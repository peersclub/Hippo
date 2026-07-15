"""Research engine: grounded briefs, advice declines, output-side guardrail.

Division of labor (deliberate): NUMBERS ARE RETRIEVAL, PROSE IS GENERATION.
stats / sparkPoints / asOfIso / sources always come straight from the
market-data snapshot — never from the model — so a hallucinated figure cannot
reach a stat cell. The model only writes headline/paragraphs/followups, with
the live snapshot embedded in its prompt ("ground every number in this data").
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from cache import AnswerCache, volatility_scaled_ttl
from guardrail import detect_advice_language
from marketdata import extract_symbol, fetch_snapshot, to_pair
from prompts import (
    BRIEF_FORMAT_INSTRUCTIONS,
    HIPPO_SYSTEM_PROMPT_V0,
    STERNER_GUARDRAIL_SUFFIX,
)
from providers import Message, MockProvider, ProviderError, ProviderRouter
from textutil import JsonProseExtractor, extract_json_object

MAX_PARAGRAPHS = 3
MAX_PARAGRAPH_WORDS = 60
KNOWLEDGE_SOURCE = "HIPPO KNOWLEDGE"

_mock = MockProvider()  # deterministic last-resort text when parsing fails twice


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _clamp_words(text: str, limit: int = MAX_PARAGRAPH_WORDS) -> str:
    words = text.split()
    return text if len(words) <= limit else " ".join(words[:limit]) + "…"


# --- prompt construction ---------------------------------------------------
def _brief_user_prompt(
    text: str, symbol: str, snapshot: dict | None, language: str
) -> str:
    lines = [f"QUESTION: {text}", f"ANSWER LANGUAGE: {language}"]
    if snapshot is not None:
        lines.append(f"SNAPSHOT JSON: {json.dumps(snapshot, separators=(',', ':'))}")
        lines.append(
            f"This is the live {symbol} market snapshot (as of "
            f"{snapshot.get('asOfIso', 'now')}). Ground every number in this "
            "data; do not invent figures."
        )
    else:
        lines.append(
            "No market snapshot is needed (concept question) — explain the "
            "mechanics; do not cite any specific live prices."
        )
    lines.append(BRIEF_FORMAT_INSTRUCTIONS)
    return "\n".join(lines)


# --- model output coercion -----------------------------------------------------
def _coerce_prose(parsed: dict | None) -> dict[str, Any] | None:
    """Validate/clamp {headline, paragraphs, followups} from the model."""
    if not isinstance(parsed, dict):
        return None
    headline = parsed.get("headline")
    paragraphs = parsed.get("paragraphs")
    if not isinstance(headline, str) or not headline.strip():
        return None
    if not isinstance(paragraphs, list):
        return None
    clean = [
        _clamp_words(p.strip()) for p in paragraphs if isinstance(p, str) and p.strip()
    ][:MAX_PARAGRAPHS]
    if not clean:
        return None
    followups_raw = parsed.get("followups")
    followups = [
        f.strip()
        for f in (followups_raw if isinstance(followups_raw, list) else [])
        if isinstance(f, str) and f.strip()
    ]
    defaults = ["What's driving this market right now?", "How does funding work?"]
    while len(followups) < 2:
        followups.append(defaults[len(followups)])
    return {
        "headline": headline.strip(),
        "paragraphs": clean,
        "followups": followups[:2],
    }


# --- snapshot → deterministic card parts -----------------------------------
def _stats_from_snapshot(snapshot: dict) -> list[dict[str, str]]:
    stats: list[dict[str, str]] = [
        {"k": "LAST", "v": str(snapshot.get("lastDisplay", "—")), "tone": "neutral"}
    ]
    change = snapshot.get("change12hPct")
    if snapshot.get("change12hDisplay") is not None and change is not None:
        stats.append(
            {
                "k": "12H",
                "v": str(snapshot["change12hDisplay"]),
                "tone": "pos" if change >= 0 else "neg",
            }
        )
    funding = snapshot.get("fundingRate")
    if snapshot.get("fundingDisplay") is not None and funding is not None:
        stats.append(
            {
                "k": "FUNDING",
                "v": str(snapshot["fundingDisplay"]),
                "tone": "pos" if funding >= 0 else "neg",
            }
        )
    return stats[:3]


# --- brief generation -----------------------------------------------------------
async def _generate_prose(
    router: ProviderRouter, system: str, user: str
) -> dict[str, Any]:
    """One model call, defensive parse, one JSON-retry, deterministic floor."""
    messages: list[Message] = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    prose = _coerce_prose(
        extract_json_object(await router.chat(messages, json_mode=True))
    )
    if prose is None:
        retry = user + "\nYour previous output was not valid JSON. JSON only."
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": retry},
        ]
        prose = _coerce_prose(
            extract_json_object(await router.chat(messages, json_mode=True))
        )
    if prose is None:
        # Deterministic floor: the mock's templated grounded prose. The user
        # gets a factual (if plain) brief instead of an error.
        prose = _coerce_prose(extract_json_object(await _mock.chat(messages)))
    assert prose is not None  # mock output always parses
    return prose


async def build_brief(
    text: str,
    symbol: str,
    router: ProviderRouter,
    *,
    concept_mode: bool,
    language: str = "en",
) -> dict[str, Any]:
    """Generate a research/concept brief; returns brief OR decline dict.

    Output-side guardrail: the ported advice-language detector runs on the
    generated prose. One trip → regenerate with a sterner instruction; a
    second trip → replace the answer with the decline shape. Enforcement is
    demonstrable to compliance and mirrors the eval harness exactly
    (evals/runner/scoring.py drives the same patterns).
    """
    snapshot = None if concept_mode else await fetch_snapshot(symbol)
    user = _brief_user_prompt(text, symbol, snapshot, language)

    prose = await _generate_prose(router, HIPPO_SYSTEM_PROMPT_V0, user)
    flagged = detect_advice_language(
        " ".join([prose["headline"], *prose["paragraphs"], *prose["followups"]])
    )
    if flagged:
        prose = await _generate_prose(
            router, HIPPO_SYSTEM_PROMPT_V0 + STERNER_GUARDRAIL_SUFFIX, user
        )
        flagged = detect_advice_language(
            " ".join([prose["headline"], *prose["paragraphs"], *prose["followups"]])
        )
        if flagged:
            return await build_decline(text, symbol, language, snapshot=snapshot)

    return _assemble_brief(prose, snapshot)


def _assemble_brief(prose: dict[str, Any], snapshot: dict | None) -> dict[str, Any]:
    """Prose (generation) + snapshot card parts (retrieval) → brief dict."""
    brief: dict[str, Any] = {
        "kind": "brief",
        "headline": prose["headline"],
        "paragraphs": prose["paragraphs"],
        "stats": _stats_from_snapshot(snapshot) if snapshot else [],
        "sources": list(snapshot["sources"]) if snapshot and snapshot.get("sources") else [KNOWLEDGE_SOURCE],
        "followups": prose["followups"],
        "asOfIso": str(snapshot.get("asOfIso")) if snapshot and snapshot.get("asOfIso") else _now_iso(),
        "cached": False,
    }
    if snapshot and isinstance(snapshot.get("spark"), list):
        brief["sparkPoints"] = snapshot["spark"]
    return brief


# --- advice decline -----------------------------------------------------------
_DECLINE_COPY: dict[str, dict[str, str]] = {
    "en": {
        "message": "I can't tell you whether to trade — that's a call Hippo never makes.",
        "pivot": "What's true about {sym} right now",
    },
    "hinglish": {
        "message": "Main aapko buy/sell nahi bata sakta — woh call Hippo kabhi nahi karta.",
        "pivot": "{sym} ka abhi ka sach",
    },
    "hi": {
        "message": "मैं आपको खरीदने या बेचने की सलाह नहीं दे सकता — हिप्पो कभी यह कॉल नहीं करता।",
        "pivot": "{sym} की अभी की स्थिति",
    },
}


async def build_decline(
    text: str,
    symbol: str,
    language: str = "en",
    snapshot: dict | None = None,
) -> dict[str, Any]:
    """Decline-and-pivot card: template message + 3 facts from LIVE data.

    Facts use deterministic snapshot numbers (never model-generated) in
    template sentences — the pivot itself must be un-hallucinatable.
    """
    if snapshot is None:
        snapshot = await fetch_snapshot(symbol)
    copy = _DECLINE_COPY.get(language, _DECLINE_COPY["en"])

    facts: list[dict[str, str]]
    if snapshot is not None:
        as_of = str(snapshot.get("asOfIso", ""))[:16].replace("T", " ")
        change = snapshot.get("change12hPct") or 0
        facts = [
            {
                "icon": "📊",
                "text": f"{symbol} is trading at {snapshot.get('lastDisplay', '—')} "
                f"(as of {as_of} UTC)",
            },
            {
                "icon": "📈" if change >= 0 else "📉",
                "text": f"{snapshot.get('change12hDisplay', '—')} over the last 12 hours",
            },
            (
                {
                    "icon": "⚖️",
                    "text": f"Perp funding at {snapshot['fundingDisplay']} — "
                    + ("longs are paying shorts" if (snapshot.get("fundingRate") or 0) >= 0 else "shorts are paying longs"),
                }
                if snapshot.get("fundingDisplay")
                else {
                    "icon": "🕐",
                    "text": f"Snapshot sourced from {', '.join(snapshot.get('sources', [])) or 'live feeds'}",
                }
            ),
        ]
    else:
        facts = [
            {"icon": "📊", "text": f"Live {symbol} data is being fetched — price, 12h change and funding are what I'd check first"},
            {"icon": "⚖️", "text": "Funding and positioning show how the market is leaning, without anyone making your call"},
            {"icon": "🕐", "text": "Every Hippo answer is a fact about a moment, stamped with its as-of time"},
        ]

    return {
        "kind": "decline",
        "message": copy["message"],
        "pivotTitle": copy["pivot"].format(sym=symbol),
        "facts": facts[:3],
        "followups": [
            f"Why is {symbol} moving today?",
            f"What is {symbol} funding right now?",
        ],
    }


# --- top-level respond ---------------------------------------------------------
async def respond(
    text: str,
    intent: str,
    router: ProviderRouter,
    cache: AnswerCache,
    symbol: str | None = None,
    language: str | None = None,
) -> dict[str, Any]:
    """Handle POST /v1/respond. Always returns a brief or decline dict."""
    asset = (symbol or extract_symbol(text)).split("/")[0].upper()
    lang = language if language in ("en", "hi", "hinglish") else "en"

    if intent == "advice":
        return await build_decline(text, asset, lang)

    concept_mode = intent in ("concept", "smalltalk")

    # Cache: market-level answers only (research + concept), keyed on the
    # canonical question + symbol + 5-minute window. Language is folded into
    # the key SCOPE (not the question text — keyword canonicalization would
    # discard a text prefix) so a Hindi answer never serves an English asker.
    cache_scope = f"{asset if not concept_mode else '-'}:{lang}"
    hit = cache.get(text, cache_scope)
    if hit is not None:
        # Serve the stored brief labeled honestly: cached=true, and the
        # ORIGINAL asOfIso — a cached answer is a fact about ITS moment.
        return {**hit, "cached": True}

    answer = await build_brief(
        text, asset, router, concept_mode=concept_mode, language=lang
    )
    if answer.get("kind") == "brief":
        # TTL scaled by realized volatility from the spark line: calm markets
        # serve the brief longer, moving markets expire it fast.
        cache.set(
            text,
            cache_scope,
            answer,
            ttl_s=volatility_scaled_ttl(answer.get("sparkPoints")),
        )
    return answer


# --- streaming respond ----------------------------------------------------------
def _meta_from_brief(brief: dict[str, Any]) -> dict[str, Any]:
    meta: dict[str, Any] = {
        "stats": brief.get("stats", []),
        "sources": brief.get("sources", []),
        "asOfIso": brief.get("asOfIso"),
    }
    if "sparkPoints" in brief:
        meta["sparkPoints"] = brief["sparkPoints"]
    return meta


async def respond_stream(
    text: str,
    intent: str,
    router: ProviderRouter,
    cache: AnswerCache,
    symbol: str | None = None,
    language: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Streaming variant of respond() for POST /v1/respond/stream (SSE).

    Event order makes the retrieval/generation split visible on the wire:
      meta    — stats/spark/sources/asOfIso straight from the snapshot,
                emitted BEFORE the model produces a single token
      delta   — readable prose chunks ({"text": ...}). The model streams
                constrained JSON (json_mode); JsonProseExtractor passes
                through only the headline/paragraph string contents so the
                SDK renders clean text while the wire stays strict JSON.
      done    — the full validated brief (authoritative; supersedes deltas)
      replace — decline card when the output guardrail trips: streamed tokens
                cannot be silently regenerated the way the blocking path does,
                so the enforcement is a visible replacement instead
      decline — advice intent (no generation at all)
    Cache hits emit meta + done immediately (this is the < 800ms cache-hit
    budget path). The model never contributes to meta — numbers are retrieval.
    """
    asset = (symbol or extract_symbol(text)).split("/")[0].upper()
    lang = language if language in ("en", "hi", "hinglish") else "en"

    if intent == "advice":
        yield {"event": "decline", "data": await build_decline(text, asset, lang)}
        return

    concept_mode = intent in ("concept", "smalltalk")
    cache_scope = f"{asset if not concept_mode else '-'}:{lang}"
    hit = cache.get(text, cache_scope)
    if hit is not None:
        yield {"event": "meta", "data": _meta_from_brief(hit)}
        yield {"event": "done", "data": {**hit, "cached": True}}
        return

    snapshot = None if concept_mode else await fetch_snapshot(asset)
    meta: dict[str, Any] = {
        "stats": _stats_from_snapshot(snapshot) if snapshot else [],
        "sources": list(snapshot["sources"]) if snapshot and snapshot.get("sources") else [KNOWLEDGE_SOURCE],
        "asOfIso": str(snapshot.get("asOfIso")) if snapshot and snapshot.get("asOfIso") else _now_iso(),
    }
    if snapshot and isinstance(snapshot.get("spark"), list):
        meta["sparkPoints"] = snapshot["spark"]
    yield {"event": "meta", "data": meta}

    user = _brief_user_prompt(text, asset, snapshot, lang)
    messages: list[Message] = [
        {"role": "system", "content": HIPPO_SYSTEM_PROMPT_V0},
        {"role": "user", "content": user},
    ]
    extractor = JsonProseExtractor()
    raw = ""
    try:
        async for chunk in router.chat_stream(messages, json_mode=True):
            raw += chunk
            visible = extractor.feed(chunk)
            if visible:
                yield {"event": "delta", "data": {"text": visible}}
    except ProviderError:
        pass  # finalize with what we have; the floor below fills any gap

    prose = _coerce_prose(extract_json_object(raw))
    if prose is None:
        # Stream was unusable — fall back to the blocking JSON path (which
        # bottoms out at the deterministic mock); `done` supersedes deltas.
        prose = await _generate_prose(router, HIPPO_SYSTEM_PROMPT_V0, user)

    flagged = detect_advice_language(
        " ".join([prose["headline"], *prose["paragraphs"], *prose["followups"]])
    )
    if flagged:
        yield {
            "event": "replace",
            "data": await build_decline(text, asset, lang, snapshot=snapshot),
        }
        return

    brief = _assemble_brief(prose, snapshot)
    cache.set(
        text,
        cache_scope,
        brief,
        ttl_s=volatility_scaled_ttl(brief.get("sparkPoints")),
    )
    yield {"event": "done", "data": brief}
