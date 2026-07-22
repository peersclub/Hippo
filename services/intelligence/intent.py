"""Intent engine: deterministic fast-paths + small-model classification.

Latency budget is < 300ms p95 (Build Plan 03, intent engine) — the regex
fast-path answers unambiguous messages without touching the LLM at all:
explicit orders, portfolio queries, and obvious advice-bait. Everything else
goes to the small model with a strict-JSON prompt, parsed defensively, retried
once, and finally falling back to the deterministic rules.
"""
from __future__ import annotations

import os
import re
from typing import Any

from marketdata import normalize_asset, to_pair
from providers import Message, ProviderRouter
from prompts import INTENT_RETRY_SUFFIX, INTENT_SYSTEM_PROMPT
from textutil import canonical_text, extract_json_object

INTENTS = {"research", "concept", "action", "advice", "portfolio", "smalltalk"}
LANGUAGES = {"en", "hi", "hinglish"}

# Intent-path LLM deadline, well inside the gateway's 3s /v1/intent abort.
# A merely SLOW (not dead) model must trip ProviderError → mock fallback here;
# inheriting the generic 30s LLM_TIMEOUT would leave the gateway permanently
# degraded while this service's breaker never opens and /health stays green.
LLM_INTENT_TIMEOUT = float(os.environ.get("LLM_INTENT_TIMEOUT", "2"))

# --- language detection (deterministic; the LLM path can refine) -------------
_DEVANAGARI_RE = re.compile(r"[ऀ-ॿ]")
_HINGLISH_TOKENS = {
    "kya", "hai", "hain", "kyu", "kyun", "kyon", "gir", "raha", "rahi",
    "chahiye", "kharidun", "kharidu", "kharido", "kharidna", "bechu",
    "bechun", "becho", "bechna", "abhi", "kitna", "kitne", "matlab",
    "kaise", "karo", "karna", "mera", "meri", "paisa", "bhai", "nahi",
    "thoda", "sahi", "accha", "acha", "lena", "dena", "hua", "hoga",
}


def detect_language(text: str) -> str:
    if _DEVANAGARI_RE.search(text):
        return "hi"
    tokens = set(re.findall(r"[a-z]+", text.lower()))
    return "hinglish" if tokens & _HINGLISH_TOKENS else "en"


# --- explicit order parsing ---------------------------------------------------
# "buy/sell <qty> <asset> [at market | @ <price> | at <price> | limit <price>]"
_ORDER_RE = re.compile(
    r"^\s*(?P<side>buy|sell)\s+"
    r"(?P<size>\d+(?:\.\d+)?)\s+"
    r"(?P<asset>[a-zA-Z]{2,10})"
    r"(?P<rest>\s+.*)?$",
    re.IGNORECASE,
)
_LIMIT_RE = re.compile(
    r"^(?:at|@|limit(?:\s+at)?)\s*\$?(?P<price>\d[\d,]*(?:\.\d+)?)\s*$",
    re.IGNORECASE,
)
_MARKET_RE = re.compile(r"^(?:at\s+market|market)\s*$", re.IGNORECASE)

# "[open|close] long/short <qty> <asset> [<lev>x] [isolated|cross] [reduce] …"
_PERP_RE = re.compile(
    r"^\s*(?P<action>open\s+|close\s+)?"
    r"(?P<dir>long|short)\s+"
    r"(?P<size>\d+(?:\.\d+)?)\s+"
    r"(?P<asset>[a-zA-Z]{2,10})"
    r"(?P<rest>\s+.*)?$",
    re.IGNORECASE,
)
_LEV_RE = re.compile(r"\b(?P<lev>\d{1,3})x\b", re.IGNORECASE)


def parse_perp(text: str) -> dict | None:
    """Extract a fully-specified perpetual-futures order, else None."""
    m = _PERP_RE.match(text.strip())
    if not m:
        return None
    asset = normalize_asset(m.group("asset"))
    if asset is None:
        return None
    rest = (m.group("rest") or "").strip()
    lev_m = _LEV_RE.search(rest)
    direction = m.group("dir").lower()
    action = (m.group("action") or "open").strip().lower() or "open"
    order: dict = {
        "capability": "futures_perp",
        # open long / close short = buy; open short / close long = sell.
        "side": "buy" if (action == "open") == (direction == "long") else "sell",
        "direction": direction,
        "action": action,
        "leverage": int(lev_m.group("lev")) if lev_m else 10,
        "marginMode": "cross" if re.search(r"\bcross\b", rest, re.IGNORECASE) else "isolated",
        "reduceOnly": action == "close" or bool(re.search(r"\breduce\b", rest, re.IGNORECASE)),
        "size": m.group("size"),
        "instrument": to_pair(asset),
        "orderType": "market",
    }
    # Strip the parts we consumed, then look for an explicit limit price.
    residue = _LEV_RE.sub("", rest)
    residue = re.sub(r"\b(isolated|cross|reduce(?:\s+only)?)\b", "", residue, flags=re.IGNORECASE).strip()
    if residue and not _MARKET_RE.match(residue):
        limit = _LIMIT_RE.match(residue)
        if limit is None:
            return None  # trailing text we don't understand → let the LLM try
        order["orderType"] = "limit"
        order["limitPrice"] = limit.group("price").replace(",", "")
    return order


def parse_order(text: str) -> dict | None:
    """Extract a fully-specified order, else None. Asset → "XXX/USDT" pair.

    Tries perpetual-futures phrasing ("long 0.5 BTC 10x") first, then spot
    ("buy 0.5 BTC"). Spot orders are tagged capability='spot' for symmetry.
    """
    perp = parse_perp(text)
    if perp is not None:
        return perp
    m = _ORDER_RE.match(text.strip())
    if not m:
        return None
    asset = normalize_asset(m.group("asset"))
    if asset is None:
        return None
    rest = (m.group("rest") or "").strip()
    # Spot stays byte-identical (untagged) — the gateway treats an order with no
    # capability as spot; only richer capabilities carry an explicit tag.
    order: dict[str, str] = {
        "side": m.group("side").lower(),
        "size": m.group("size"),
        "instrument": to_pair(asset),
        "orderType": "market",
    }
    if rest and not _MARKET_RE.match(rest):
        limit = _LIMIT_RE.match(rest)
        if limit is None:
            return None  # trailing text we don't understand → let the LLM try
        order["orderType"] = "limit"
        order["limitPrice"] = limit.group("price").replace(",", "")
    return order


# --- deterministic classification rules ---------------------------------------
_ADVICE_BAIT = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bshould (?:i|we)\b",
        r"\bshall i\b",
        r"\bis (?:this|it) (?:the |a )?dip\b",
        r"\bgood time to (?:buy|sell|enter|exit)\b",
        r"\bbuy or sell\b",
        r"\bworth (?:buying|selling)\b",
        r"\bwhat would you (?:do|buy|sell)\b",
        r"\bkya m(?:ai)?n?\s+kharid",          # "kya main kharidun"
        r"\bkhari?d(?:un|u|na)\b",
        r"\bbech(?:un|u|na)\b",
        r"\bchahiye\b.*\b(?:kharid|bech|buy|sell|lena)\b",
        r"\b(?:kharid|bech|lena)\w*\b.*\bchahiye\b",
    )
]
_PORTFOLIO_RE = re.compile(
    r"\b(?:positions?|p\s?&\s?l|pnl|portfolio|holdings?|balance|my orders?)\b",
    re.IGNORECASE,
)
_ACTION_VERB_START = re.compile(r"^\s*(?:buy|sell)\b", re.IGNORECASE)
_SMALLTALK_RE = re.compile(
    r"^\s*(?:hi|hello|hey|yo|namaste|gm|good (?:morning|evening|night)|"
    r"thanks|thank you|thx|how are you|who are you|kaise ho)\b",
    re.IGNORECASE,
)
_CONCEPT_RE = re.compile(
    r"\b(?:what is|what's|what are|how does|how do|explain|meaning of|"
    r"difference between|kya hota hai|kya hai|kaise (?:kaam|hota|work))\b",
    re.IGNORECASE,
)
_LIVE_MARKET_RE = re.compile(
    r"\b(?:price|down|up|why|today|now|abhi|news|moving|move[ds]?|pump|dump|"
    r"crash|rally|gir|badh|kitna|kitne|high|low|funding rate right now)\b",
    re.IGNORECASE,
)


def fast_path(text: str) -> dict[str, Any] | None:
    """Skip the LLM when the message is unambiguous. None = LLM decides."""
    language = detect_language(text)
    if any(p.search(text) for p in _ADVICE_BAIT):
        return {"intent": "advice", "confidence": 0.95, "language": language}
    order = parse_order(text)
    if order is not None:
        return {
            "intent": "action",
            "confidence": 0.97,
            "language": language,
            "order": order,
        }
    if not _ACTION_VERB_START.match(text) and _PORTFOLIO_RE.search(text):
        return {"intent": "portfolio", "confidence": 0.92, "language": language}
    return None


def rule_classify(text: str) -> dict[str, Any]:
    """Full deterministic classification — the no-LLM fallback.

    Also the brain of the mock provider, so mock mode behaves like a decent
    (if literal-minded) classifier. Decided behavior for vague orders like
    "sell half my sol position": intent=action with NO order object — the
    gateway asks for an explicit size; we never guess trade parameters.
    """
    fp = fast_path(text)
    if fp is not None:
        return fp
    language = detect_language(text)
    if _ACTION_VERB_START.match(text):
        return {"intent": "action", "confidence": 0.7, "language": language}
    if _SMALLTALK_RE.match(text) and len(canonical_text(text).split()) <= 6:
        return {"intent": "smalltalk", "confidence": 0.8, "language": language}
    if _CONCEPT_RE.search(text) and not _LIVE_MARKET_RE.search(text):
        return {"intent": "concept", "confidence": 0.7, "language": language}
    return {"intent": "research", "confidence": 0.6, "language": language}


# --- LLM output validation ------------------------------------------------------
def _validate_order(raw: object) -> dict[str, str] | None:
    if not isinstance(raw, dict):
        return None
    side = raw.get("side")
    size = raw.get("size")
    instrument = raw.get("instrument")
    if side not in ("buy", "sell") or not size or not isinstance(instrument, str):
        return None
    base = instrument.split("/")[0].strip()
    asset = normalize_asset(base) or (base.upper() if base.isalpha() else None)
    if not asset:
        return None
    order: dict[str, str] = {
        "side": side,
        "size": str(size),
        "instrument": to_pair(asset),
        "orderType": "limit" if raw.get("orderType") == "limit" else "market",
    }
    if order["orderType"] == "limit":
        if not raw.get("limitPrice"):
            return None
        order["limitPrice"] = str(raw["limitPrice"])
    return order


def _validate_classification(
    parsed: dict | None, text: str
) -> dict[str, Any] | None:
    if not isinstance(parsed, dict) or parsed.get("intent") not in INTENTS:
        return None
    confidence = parsed.get("confidence")
    if not isinstance(confidence, (int, float)):
        confidence = 0.5
    language = parsed.get("language")
    if language not in LANGUAGES:
        language = detect_language(text)
    result: dict[str, Any] = {
        "intent": parsed["intent"],
        "confidence": max(0.0, min(1.0, float(confidence))),
        "language": language,
    }
    # Interpretation + restructured query are additive stage-1 output. When the
    # model supplies them we take them (trimmed); otherwise _ensure_interpretation
    # fills deterministic defaults so fast-path/fallback turns still carry them.
    interp = parsed.get("interpretation")
    if isinstance(interp, str) and interp.strip():
        result["interpretation"] = interp.strip()
    restructured = parsed.get("restructuredQuery")
    if isinstance(restructured, str) and restructured.strip():
        result["restructuredQuery"] = restructured.strip()
    if parsed["intent"] == "action":
        order = _validate_order(parsed.get("order"))
        if order is not None:
            result["order"] = order
    return result


# One-line templated "understanding" per intent — used for fast-path hits (no
# LLM) and whenever the model omits its own interpretation. Never advice.
_INTERP_TEMPLATES = {
    "research": "Looking up live market info for this.",
    "concept": "Explaining the concept — no live data needed.",
    "action": "Preparing an order ticket to review.",
    "advice": "This asks for a call — I'll share facts, not advice.",
    "portfolio": "Checking your own positions and balance.",
    "smalltalk": "Just saying hi.",
}


def _ensure_interpretation(result: dict[str, Any], text: str) -> dict[str, Any]:
    """Guarantee interpretation + restructuredQuery are present. The answer
    engine falls back to the raw text if restructuredQuery is absent, but the
    UI card always wants a summary line."""
    result.setdefault(
        "interpretation", _INTERP_TEMPLATES.get(result["intent"], "Working on it.")
    )
    result.setdefault("restructuredQuery", text.strip())
    return result


async def classify(
    text: str, router: ProviderRouter, language_hint: str | None = None
) -> dict[str, Any]:
    """Classify one message. Deterministic fast-path → LLM → rules fallback."""
    fp = fast_path(text)
    if fp is not None:
        result = fp
    else:
        # "/no_think" is qwen3's soft switch to skip the reasoning block —
        # honored by vLLM's chat template; some Ollama builds reason anyway
        # (into a separate channel), which the max_tokens budget absorbs and
        # textutil.strip_think guards at parse time. Intent is latency-
        # critical: production runs this on the regional 7-8B pod.
        messages: list[Message] = [
            {"role": "system", "content": INTENT_SYSTEM_PROMPT},
            {"role": "user", "content": f"{text} /no_think"},
        ]
        raw = await router.chat(
            messages,
            temperature=0.0,
            max_tokens=500,
            json_mode=True,
            timeout=LLM_INTENT_TIMEOUT,
        )
        result = _validate_classification(extract_json_object(raw), text)
        if result is None:  # one retry with a sterner JSON-only instruction
            retry = [
                {"role": "system", "content": INTENT_SYSTEM_PROMPT + INTENT_RETRY_SUFFIX},
                {"role": "user", "content": f"{text} /no_think"},
            ]
            raw = await router.chat(
                retry,
                temperature=0.0,
                max_tokens=500,
                json_mode=True,
                timeout=LLM_INTENT_TIMEOUT,
            )
            result = _validate_classification(extract_json_object(raw), text)
        if result is None:
            result = rule_classify(text)
    if language_hint in LANGUAGES:
        result["language"] = language_hint
    return _ensure_interpretation(result, text)
