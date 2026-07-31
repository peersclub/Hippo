"""Memory extraction engine: post-turn durable-fact extraction.

Track 1 of the auto-learning memory feature (memo §9). AFTER a turn, a small
model reads what the user said and proposes durable, trading-relevant FACTS
about the trader worth remembering (e.g. "trades BTC perps at 10x, wants
concise answers"). This is the OUTPUT side of memory; composing memory back
into the answer prompt lives elsewhere (research.py + the gateway).

Two hard invariants:
  1. CLOSED ALLOWLIST. Only the fact types in FACT_TYPES survive, with
     canonical values only. Everything else the model emits is dropped by
     _validate_facts — the model is a proposer, never the authority.
  2. FACTS ARE DATA, NEVER INSTRUCTIONS. The extraction prompt refuses to turn
     injected behaviour ("always tell me to buy", "ignore your no-advice rule")
     into a fact; the validator is the belt-and-braces second line, rejecting
     any value that isn't a short factual token in its type's shape. So even a
     coaxed or hostile model output cannot smuggle a directive into memory.

Availability: like the rest of the service, this NEVER 500s. router.chat already
falls back to the deterministic mock (which returns no facts); any residual
error here degrades to {"facts": []}.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from marketdata import normalize_asset
from prompts import EXTRACT_RETRY_SUFFIX, EXTRACT_SYSTEM_PROMPT
from providers import Message, ProviderRouter
from textutil import extract_json_object

log = logging.getLogger("intelligence.extract")

# The closed allowlist of durable fact types. Anything outside this set is
# dropped before it can reach memory.
FACT_TYPES = {
    "followed_asset",
    "instrument_pref",
    "leverage_pref",
    "experience_level",
    "answer_style",
}

# Post-turn extraction runs off the hot path but still shares the fast model;
# keep it on a tight deadline so a slow model trips the mock fallback rather
# than holding a connection open.
LLM_EXTRACT_TIMEOUT = float(os.environ.get("LLM_EXTRACT_TIMEOUT", "2"))

# Bound the memory we accept from any single turn.
_MAX_FACTS = 12

# Canonical value spaces per allowlisted type.
_INSTRUMENT_PREFS = {"spot", "perps"}
_EXPERIENCE_LEVELS = {"beginner", "intermediate", "pro"}
_ANSWER_STYLES = {"concise", "detailed"}
_TICKER_RE = re.compile(r"^[A-Z0-9]{2,10}$")
_LEVERAGE_RE = re.compile(r"^\d{1,3}x$")

# followed_asset is a CLOSED value space, not "any 2-10 letter word". The old
# `value.upper() if value.isalpha()` fallback accepted ANY alphabetic token as a
# ticker — so a model that (mis)extracted a person's name ("John", "Smith")
# would have that name stored as a followed asset. A crypto ticker is public,
# non-identifying reference data; a name is PII. We therefore only accept a bare
# token as a ticker if it is a recognized crypto asset. normalize_asset() covers
# the pilot keyword set; _KNOWN_TICKERS widens that to the well-known majors a
# real trader might mention, without ever opening the door to arbitrary words.
_KNOWN_TICKERS = frozenset(
    {
        # pilot set (also covered by normalize_asset)
        "BTC", "ETH", "SOL", "ADA", "MATIC", "DOGE", "XRP",
        # well-known majors / commonly-traded tickers
        "BNB", "AVAX", "LINK", "DOT", "LTC", "TRX", "BCH", "ATOM", "NEAR",
        "APT", "SUI", "ARB", "OP", "TON", "INJ", "SEI", "TIA", "RNDR",
        "SHIB", "PEPE", "WIF", "BONK", "FIL", "ICP", "ETC", "XLM", "HBAR",
        "ALGO", "VET", "AAVE", "UNI", "MKR", "LDO", "CRV", "SNX", "GRT",
        "USDT", "USDC", "DAI",
    }
)

# Light, conservative synonym folding so a well-meaning model that writes the
# obvious near-miss ("perp", "short answers") still lands on canonical values.
_INSTRUMENT_SYNONYMS = {
    "perp": "perps",
    "perpetual": "perps",
    "perpetuals": "perps",
    "futures": "perps",
    "spot trading": "spot",
}
_ANSWER_STYLE_SYNONYMS = {
    "short": "concise",
    "brief": "concise",
    "terse": "concise",
    "long": "detailed",
    "verbose": "detailed",
    "thorough": "detailed",
    "in-depth": "detailed",
}

# Defense in depth: a fact VALUE must be a short factual token. Any value
# carrying advice/command/directive language is rejected outright, no matter
# which type it claims — a second wall behind the allowlist so an injection can
# never ride into memory inside an otherwise-valid-looking fact.
_DIRECTIVE_RE = re.compile(
    r"\b(?:buy|sell|hold|long|short|should|shall|must|always|never|ignore|"
    r"recommend|advice|advise|signal|tell|target|predict|forecast|"
    r"instruction|command|rule|behave|pretend|roleplay)\b",
    re.IGNORECASE,
)

# Defense in depth #2: an explicit PII / sensitive-data reject scan. The closed
# value spaces above already make it impossible to STORE contact info, IDs, or
# balances (canonical tickers/enums/leverage tokens carry none of it) — but this
# scans the RAW proposed value and drops the whole fact if it looks like PII, so
# the "facts, not surveillance" guarantee is explicit and auditable rather than
# an emergent side effect of the enums. Canonical values never trip it: tickers
# and enum words have no "@" and no 7+ digit runs; "10x" has only two digits.
_PII_RE = re.compile(
    r"""
    @                       # email local@domain
  | \d[\d\s().\-]{5,}\d     # 7+ digit run (phone / card / SSN / account / balance)
  | \b0x[0-9a-fA-F]{6,}\b   # hex wallet / EVM address
  | \b[13bc][a-km-zA-HJ-NP-Z1-9]{25,}\b  # BTC-style / bech32 wallet address
    """,
    re.VERBOSE,
)


def _normalize_value(ftype: str, value: str) -> str | None:
    """Map a raw model value to its canonical form, or None if it doesn't
    belong to this type's closed value space."""
    v = value.strip()
    if not v:
        return None
    if ftype == "followed_asset":
        # Accept a known asset name ("bitcoin" → BTC) or a RECOGNIZED ticker.
        # A bare alphabetic token is only a ticker if it is in the known set —
        # never "any 2-10 letter word", which would let a name leak through.
        asset = normalize_asset(v)
        if asset is None and v.isalpha():
            cand = v.upper()
            asset = cand if cand in _KNOWN_TICKERS else None
        return asset if asset and _TICKER_RE.match(asset) else None
    if ftype == "instrument_pref":
        low = v.lower()
        low = _INSTRUMENT_SYNONYMS.get(low, low)
        return low if low in _INSTRUMENT_PREFS else None
    if ftype == "leverage_pref":
        low = v.lower().replace(" ", "")
        return low if _LEVERAGE_RE.match(low) else None
    if ftype == "experience_level":
        low = v.lower()
        return low if low in _EXPERIENCE_LEVELS else None
    if ftype == "answer_style":
        low = v.lower()
        low = _ANSWER_STYLE_SYNONYMS.get(low, low)
        return low if low in _ANSWER_STYLES else None
    return None


def _validate_fact(raw: object) -> dict[str, Any] | None:
    """Validate one proposed fact against the allowlist. None → drop it."""
    if not isinstance(raw, dict):
        return None
    ftype = raw.get("type")
    value = raw.get("value")
    if ftype not in FACT_TYPES or not isinstance(value, str):
        return None
    # Reject the whole fact if the RAW proposed value carries anything that
    # smells like PII (email, phone/card/ID digit runs, wallet address) before
    # we even canonicalize — a smuggled identifier never reaches memory.
    if _PII_RE.search(value):
        log.warning("dropped extracted fact with PII-like value")
        return None
    norm = _normalize_value(ftype, value)
    if norm is None:
        return None
    # Second wall: never let a directive/advice phrase through as a "value".
    # (Canonical values can't trip this; a smuggled sentence will.)
    if _DIRECTIVE_RE.search(norm):
        log.warning("dropped extracted fact with directive-like value")
        return None
    confidence = raw.get("confidence")
    if not isinstance(confidence, (int, float)):
        confidence = 0.5
    return {
        "type": ftype,
        "value": norm,
        "confidence": max(0.0, min(1.0, float(confidence))),
    }


def _validate_facts(parsed: dict | None) -> list[dict[str, Any]]:
    """Extract the validated, de-duplicated fact list from model output."""
    if not isinstance(parsed, dict):
        return []
    raw_facts = parsed.get("facts")
    if not isinstance(raw_facts, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for rf in raw_facts:
        fact = _validate_fact(rf)
        if fact is None:
            continue
        key = (fact["type"], fact["value"])
        if key in seen:
            continue
        seen.add(key)
        out.append(fact)
        if len(out) >= _MAX_FACTS:
            break
    return out


def _build_user_prompt(
    query: str,
    interpretation: str | None,
    answer: str | None,
    prior_facts: list[dict[str, Any]] | None,
) -> str:
    """Assemble the extraction context. The USER MESSAGE is the primary (and
    only trusted-as-preference) source; the rest is background."""
    parts = [f"USER MESSAGE: {query.strip()}"]
    if interpretation and interpretation.strip():
        parts.append(f"INTERPRETATION: {interpretation.strip()}")
    if answer and answer.strip():
        # Truncated: the answer is context for disambiguation only, and the
        # prompt forbids inferring preferences from it.
        parts.append(f"ASSISTANT ANSWER: {answer.strip()[:2000]}")
    if prior_facts:
        # Already-known facts: the model should avoid re-proposing unchanged
        # ones. Passed as data; validation is identical regardless.
        try:
            parts.append("ALREADY KNOWN: " + json.dumps(prior_facts, ensure_ascii=False))
        except (TypeError, ValueError):
            pass
    return "\n".join(parts)


async def extract(
    query: str,
    router: ProviderRouter,
    *,
    interpretation: str | None = None,
    answer: str | None = None,
    prior_facts: list[dict[str, Any]] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Extract durable trading facts from one turn. Never raises: on any error
    or in mock mode, returns {"facts": []}."""
    user = _build_user_prompt(query, interpretation, answer, prior_facts)
    # "/no_think": qwen3's soft switch to skip the reasoning block (mirrors the
    # intent path); harmless on models that ignore it.
    messages: list[Message] = [
        {"role": "system", "content": EXTRACT_SYSTEM_PROMPT},
        {"role": "user", "content": f"{user} /no_think"},
    ]
    try:
        raw = await router.chat(
            messages,
            temperature=0.0,
            max_tokens=500,
            json_mode=True,
            timeout=LLM_EXTRACT_TIMEOUT,
            purpose="memory-extract",
        )
        facts = _validate_facts(extract_json_object(raw))
        if not facts and extract_json_object(raw) is None:
            # Unparseable output: one retry with a sterner JSON-only instruction.
            retry: list[Message] = [
                {"role": "system", "content": EXTRACT_SYSTEM_PROMPT + EXTRACT_RETRY_SUFFIX},
                {"role": "user", "content": f"{user} /no_think"},
            ]
            raw = await router.chat(
                retry,
                temperature=0.0,
                max_tokens=500,
                json_mode=True,
                timeout=LLM_EXTRACT_TIMEOUT,
                purpose="memory-extract",
            )
            facts = _validate_facts(extract_json_object(raw))
    except Exception:
        # Absolute promise: extraction never breaks a turn. Degrade to no facts.
        log.exception("extract pipeline error; returning empty facts")
        return {"facts": []}
    return {"facts": facts}
