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
from prompts import INTENT_HISTORY_SUFFIX, INTENT_RETRY_SUFFIX, INTENT_SYSTEM_PROMPT
from textutil import canonical_text, extract_json_object

INTENTS = {
    "research", "concept", "action", "advice", "portfolio", "smalltalk",
    # Host-interaction wave (July 2026): chart control + consolidated orders.
    "host_action", "orders_query",
}
LANGUAGES = {"en", "hi", "hinglish"}

# Supported chart timeframes + indicator slugs for host_action (demo set).
# Natural phrasings canonicalise to these; anything outside the set is an
# honest decline downstream (the gateway never guesses an unsupported one).
_TIMEFRAMES = {"1m", "5m", "15m", "1h", "4h", "1d"}
_INDICATORS = {"sma20", "sma50", "ema20", "rsi", "vol"}

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

# --- protective exits (attached stop-loss / take-profit) ------------------------
# "with stop at 60k", "stop loss 60000", "sl 60k tp 75k", "take profit at 75k".
# Self-contained: extraction strips the matched phrases (plus their joining
# "with"/"and"/",") from the residue so the existing limit-price logic still
# sees only what it always saw. Prices become plain money STRINGS ("60k" →
# "60000") — the seam validates them against the actual entry.
_PROTECTIVE_PRICE = r"\$?(?P<price>\d[\d,]*(?:\.\d+)?)\s*(?P<kilo>k)?\b"
_SL_RE = re.compile(
    r"\b(?:stop[\s-]*loss|stop|sl)\s*(?:at|@|:|=)?\s*" + _PROTECTIVE_PRICE,
    re.IGNORECASE,
)
_TP_RE = re.compile(
    r"\b(?:take[\s-]*profit|tp)\s*(?:at|@|:|=)?\s*" + _PROTECTIVE_PRICE,
    re.IGNORECASE,
)
_CONNECTOR_RE = re.compile(r"\b(?:with|and)\b|,", re.IGNORECASE)


def _protective_price(m: re.Match) -> str:
    """Normalise a matched protective price to a plain string ("60k" → "60000")."""
    raw = m.group("price").replace(",", "")
    if not m.group("kilo"):
        return raw
    scaled = float(raw) * 1000
    return str(int(scaled)) if scaled == int(scaled) else str(scaled)


def extract_protective_exits(rest: str) -> tuple[dict[str, str], str]:
    """Pull stop-loss / take-profit phrases out of an order's trailing text.

    Returns ({"stopLossPrice": …, "takeProfitPrice": …} — only the keys found)
    and the residue with those phrases (and their connectors) removed. When
    nothing matches, the text is returned byte-identical so every existing
    parse stays untouched.
    """
    exits: dict[str, str] = {}
    # TP first: "stop" alone must never swallow the "p" of a preceding "tp",
    # and removing TP spans first keeps the SL regex from seeing them.
    tp = _TP_RE.search(rest)
    if tp:
        exits["takeProfitPrice"] = _protective_price(tp)
        rest = rest[: tp.start()] + " " + rest[tp.end():]
    sl = _SL_RE.search(rest)
    if sl:
        exits["stopLossPrice"] = _protective_price(sl)
        rest = rest[: sl.start()] + " " + rest[sl.end():]
    if exits:
        # Only when we consumed a phrase: drop dangling connectors so the
        # residue check ("trailing text we don't understand") stays honest.
        rest = _CONNECTOR_RE.sub(" ", rest)
        rest = re.sub(r"\s+", " ", rest).strip()
    return exits, rest


def parse_perp(text: str) -> dict | None:
    """Extract a fully-specified perpetual-futures order, else None."""
    m = _PERP_RE.match(text.strip())
    if not m:
        return None
    asset = normalize_asset(m.group("asset"))
    if asset is None:
        return None
    rest = (m.group("rest") or "").strip()
    exits, rest = extract_protective_exits(rest)
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
    order.update(exits)
    return order


# --- fractional close/reduce sizing --------------------------------------------
# "sell half my SOL position" / "close half my long" / "sell 25% of my btc".
# The service never knows live position sizes, so the order carries a
# `sizeFraction` (0 < f ≤ 1) and an EMPTY size; the gateway resolves the
# fraction against the live position via the seam and fills the size in.
# Out-of-range fractions ("sell 150% of my sol") defer — never guess.
_FRACTION_RE = re.compile(
    r"(?P<pct>\d{1,3}(?:\.\d+)?)\s*(?:%|percent)"
    r"|\b(?:a\s+|one\s+)?(?P<word>half|quarter|third)\b"
    r"|\b(?P<all>all|everything)\b",
    re.IGNORECASE,
)
_FRACTION_WORDS = {"half": 0.5, "quarter": 0.25, "third": 0.333}

# Nouns a trader appends to "my <asset> …" that are not the asset itself.
_POSITION_NOUNS = {
    "position", "positions", "holding", "holdings", "bag", "bags", "stack",
    "coins", "tokens",
}

# "sell <fraction> [of] my <asset> [position]" — spot fractional reduce.
_SPOT_FRACTION_RE = re.compile(
    r"^\s*sell\s+(?P<frac>.+?)\s+(?:of\s+)?my\s+(?P<rest>[a-zA-Z][a-zA-Z ]{0,40})\s*$",
    re.IGNORECASE,
)
# "close <fraction> [of] my [<asset>] long/short [position]" — perp fractional close.
_PERP_FRACTION_RE = re.compile(
    r"^\s*close\s+(?P<frac>.+?)\s+(?:of\s+)?my\s+(?:(?P<rest>[a-zA-Z][a-zA-Z ]{0,40}?)\s+)?"
    r"(?P<dir>long|short)(?:\s+position)?\s*$",
    re.IGNORECASE,
)


def parse_size_fraction(text: str) -> float | None:
    """Map a fraction phrase to (0, 1], else None.

    half=0.5, quarter=0.25, third≈0.333, "N%"=N/100, all/everything=1.0.
    Out-of-range percents ("150%", "0%") return None so the caller defers
    to the no-order action path instead of guessing.
    """
    m = _FRACTION_RE.search(text)
    if not m:
        return None
    if m.group("pct") is not None:
        fraction = float(m.group("pct")) / 100.0
        return fraction if 0 < fraction <= 1 else None
    if m.group("word"):
        return _FRACTION_WORDS[m.group("word").lower()]
    return 1.0


def _fraction_asset(rest: str) -> tuple[bool, str | None]:
    """Resolve the asset from the tokens after "my". (True, "SOL") for a
    recognized asset; (True, None) when only position-nouns appear (the
    gateway falls back to the page's symbol); (False, None) → defer."""
    tokens = [t for t in re.split(r"\s+", rest.strip().lower()) if t]
    tokens = [t for t in tokens if t not in _POSITION_NOUNS]
    if not tokens:
        return True, None
    if len(tokens) > 1:
        return False, None
    asset = normalize_asset(tokens[0])
    return (True, asset) if asset else (False, None)


def parse_fractional_close(text: str) -> dict | None:
    """Extract a fractional close/reduce order, else None.

    Perp ("close half my long") and spot ("sell half my SOL position"). The
    returned order carries sizeFraction and an empty size (resolved by the
    gateway against the live position); instrument is "" when no asset was
    named — the gateway substitutes the session's page symbol, the same
    convention order drafts use.
    """
    t = text.strip().rstrip(".!?")
    m = _PERP_FRACTION_RE.match(t)
    if m is not None:
        fraction = parse_size_fraction(m.group("frac"))
        if fraction is None:
            return None
        ok, asset = _fraction_asset(m.group("rest") or "")
        if not ok:
            return None
        direction = m.group("dir").lower()
        return {
            "capability": "futures_perp",
            # Closing a long sells; closing a short buys.
            "side": "sell" if direction == "long" else "buy",
            "direction": direction,
            "action": "close",
            "leverage": 10,
            "marginMode": "isolated",
            "reduceOnly": True,
            "size": "",
            "sizeFraction": fraction,
            "instrument": to_pair(asset) if asset else "",
            "orderType": "market",
        }
    m = _SPOT_FRACTION_RE.match(t)
    if m is not None:
        fraction = parse_size_fraction(m.group("frac"))
        if fraction is None:
            return None
        ok, asset = _fraction_asset(m.group("rest"))
        if not ok:
            return None
        return {
            "side": "sell",
            # action:'close' marks the reduce path — the gateway resolves the
            # size from the live position and bypasses the (open-only) draft.
            "action": "close",
            "size": "",
            "sizeFraction": fraction,
            "instrument": to_pair(asset) if asset else "",
            "orderType": "market",
        }
    return None


# --- conversational amend -------------------------------------------------------
# "move my limit to 61k" / "change my order to 0.2" → an amend marker the
# gateway resolves against the trader's OPEN orders (replacement ticket:
# cancel-then-place). v1 carries at most one value: a price or a size.
_AMEND_TRIGGER_RE = re.compile(
    r"\b(?:move|change|amend|update|edit|revise|adjust)\b", re.IGNORECASE
)
_AMEND_TARGET_RE = re.compile(r"\bmy\b[\w\s]{0,20}?\b(?:orders?|limit)\b", re.IGNORECASE)
_AMEND_VALUE_RE = re.compile(
    r"\bto\s+\$?(?P<num>\d[\d,]*(?:\.\d+)?)\s*(?P<suffix>k|m)?\b", re.IGNORECASE
)
_AMEND_PRICE_HINT_RE = re.compile(r"\b(?:price|limit)\b", re.IGNORECASE)
_AMEND_SIZE_HINT_RE = re.compile(r"\b(?:size|qty|quantity|amount)\b", re.IGNORECASE)


def _format_amount(value: float) -> str:
    """Float → canonical wire string: no exponent, no trailing zeros."""
    return f"{value:.8f}".rstrip("0").rstrip(".")


def parse_amend(text: str) -> dict | None:
    """Extract an amend marker {price?, size?}, else None.

    Price vs size: an explicit "price"/"limit" or "size"/"qty"/"amount" word
    decides; otherwise a k/m suffix, thousands separator, or value ≥ 1000
    reads as a price and anything else as a size ("change my order to 0.2").
    """
    t = text.strip()
    if not (_AMEND_TRIGGER_RE.search(t) and _AMEND_TARGET_RE.search(t)):
        return None
    m = _AMEND_VALUE_RE.search(t)
    if not m:
        return None
    value = float(m.group("num").replace(",", ""))
    suffix = (m.group("suffix") or "").lower()
    if suffix == "k":
        value *= 1_000
    elif suffix == "m":
        value *= 1_000_000
    if value <= 0:
        return None
    amount = _format_amount(value)
    if _AMEND_PRICE_HINT_RE.search(t):
        return {"price": amount}
    if _AMEND_SIZE_HINT_RE.search(t):
        return {"size": amount}
    looks_like_price = bool(suffix) or value >= 1_000 or "," in m.group("num")
    return {"price": amount} if looks_like_price else {"size": amount}


def parse_order(text: str) -> dict | None:
    """Extract a fully-specified order, else None. Asset → "XXX/USDT" pair.

    Tries fractional close/reduce phrasing ("sell half my SOL") first, then
    perpetual-futures ("long 0.5 BTC 10x"), then spot ("buy 0.5 BTC"). Spot
    orders are tagged capability='spot' for symmetry.
    """
    fractional = parse_fractional_close(text)
    if fractional is not None:
        return fractional
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
    exits, rest = extract_protective_exits(rest)
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
    order.update(exits)
    return order


# --- host actions (chart control) ---------------------------------------------
# The host page can be driven ("switch to 5m candles", "apply RSI", "remove the
# moving average") only when it opted in — the gateway gates on that. Here we
# just CLASSIFY + normalise; the deterministic set is small and unambiguous.
_TF_TRIGGER = re.compile(
    r"\b(?:timeframe|time frame|candles?|chart|interval|switch|change|"
    r"set|make|view|show me|go to|zoom)\b",
    re.IGNORECASE,
)
_APPLY_RE = re.compile(
    r"\b(?:apply|add|show|enable|overlay|put|plot|display|turn on)\b", re.IGNORECASE
)
_REMOVE_RE = re.compile(
    r"\b(?:remove|hide|clear|disable|drop|turn off|take off|get rid of)\b",
    re.IGNORECASE,
)
_INDICATOR_HINT = re.compile(
    r"\b(?:rsi|sma\d*|ema\d*|vol|volume|moving\s*average|ma\d*|indicator)\b",
    re.IGNORECASE,
)


def canonical_timeframe(text: str) -> str | None:
    """Map a phrasing to a supported timeframe slug, else None."""
    t = text.lower()
    m = re.search(r"\b(1m|5m|15m|1h|4h|1d)\b", t)
    if m:
        return m.group(1)
    m = re.search(r"\b(\d{1,2})\s*(?:min|mins|minute|minutes)\b", t)
    if m and m.group(1) in {"1", "5", "15"}:
        return f"{m.group(1)}m"
    m = re.search(r"\b(\d{1,2})\s*(?:h|hr|hrs|hour|hours)\b", t)
    if m and m.group(1) in {"1", "4"}:
        return f"{m.group(1)}h"
    if re.search(r"\b(?:daily|day\s*candles?|1\s*day|one\s*day)\b", t):
        return "1d"
    return None


def canonical_indicator(text: str) -> str | None:
    """Canonicalise a natural indicator phrase to a supported slug, else None.

    "volume" → vol, "20 day moving average" → sma20, "50 day ma" → sma50,
    "ema"/"exponential" → ema20, "rsi" → rsi. An unrecognised indicator returns
    None so the caller can decline honestly rather than guess.
    """
    t = text.lower()
    if re.search(r"\brsi\b", t):
        return "rsi"
    if re.search(r"\b(?:vol|volume)\b", t):
        return "vol"
    # explicit slug like sma20 / ema 50
    m = re.search(r"\b(sma|ema)\s*(\d{1,3})\b", t)
    if m:
        kind, period = m.group(1), m.group(2)
        if kind == "ema":
            return "ema20"  # only ema20 is in the demo set
        return "sma50" if period == "50" else "sma20"
    is_ema = bool(re.search(r"\b(?:ema|exponential)\b", t))
    is_sma = bool(re.search(r"\b(?:sma|simple|ma|moving\s*average)\b", t))
    if not (is_ema or is_sma):
        return None
    if is_ema:
        return "ema20"
    period = re.search(r"\b(\d{1,3})\b", t)
    return "sma50" if (period and period.group(1) == "50") else "sma20"


def parse_host_action(text: str) -> dict[str, Any] | None:
    """Extract a chart-control action, else None. `indicator` is omitted when it
    can't be canonicalised — the gateway then declines honestly."""
    t = text.strip()
    tf = canonical_timeframe(t)
    if tf and _TF_TRIGGER.search(t):
        return {"action": "set_timeframe", "timeframe": tf}
    remove = bool(_REMOVE_RE.search(t))
    apply = bool(_APPLY_RE.search(t))
    if (remove or apply) and _INDICATOR_HINT.search(t):
        action = "remove_indicator" if remove else "apply_indicator"
        out: dict[str, Any] = {"action": action}
        ind = canonical_indicator(t)
        if ind:
            out["indicator"] = ind
        return out
    return None


# --- consolidated orders query ------------------------------------------------
# "show all my orders" / "orders in this session" / "what have I traded today".
# Distinct from `portfolio` (positions/P&L/balance) — this is the orders blotter.
_ORDERS_WORD_RE = re.compile(r"\borders?\b", re.IGNORECASE)
_TRADED_RE = re.compile(
    r"\b(?:what (?:have|did) i traded?|what did i trade|my trades?|traded today)\b",
    re.IGNORECASE,
)
_SESSION_SCOPE_RE = re.compile(
    r"\b(?:this session|current session|this chat|this conversation|right now|"
    r"just (?:now|placed|made)|today|so far|since i started)\b",
    re.IGNORECASE,
)


def parse_orders_query(text: str) -> dict[str, Any] | None:
    """Classify an orders-blotter query and its scope, else None.

    "my orders" defaults to scope 'all'; this-session / today wording → 'session'.
    """
    tl = text.lower()
    if not (_ORDERS_WORD_RE.search(tl) or _TRADED_RE.search(tl)):
        return None
    scope = "session" if _SESSION_SCOPE_RE.search(tl) else "all"
    return {"scope": scope}


# --- price alerts (conversational create/cancel) --------------------------------
# "alert me when BTC crosses/hits/goes above/below 70k", "tell me if ETH drops
# under 3000" → an alert intent the gateway arms durably. SELF-CONTAINED and
# deterministic: everything from cue detection to the returned classification
# dict lives here; fast_path has exactly one dispatch call into this block.
# "crosses"/"hits"/"reaches" resolve to direction 'cross' — the GATEWAY decides
# above/below against the live price at creation (target > current → above).
_ALERT_CUE_RE = re.compile(
    r"\b(?:alert|notify|ping|warn)\s+(?:me|us)\b"
    r"|\b(?:tell|let)\s+(?:me|us)\s+know\b"
    r"|\btell\s+(?:me|us)\s+(?:if|when|once)\b"
    r"|\bset\s+(?:an?\s+)?alert\b",
    re.IGNORECASE,
)
_ALERT_ABOVE_RE = re.compile(
    r"\b(?:above|over|exceeds?|breaks?\s+(?:above|over)|rises?\s+(?:above|over|past)|"
    r"goes?\s+(?:above|over|past)|more\s+than)\b",
    re.IGNORECASE,
)
_ALERT_BELOW_RE = re.compile(
    r"\b(?:below|under|beneath|drops?|falls?|dips?|sinks?|less\s+than|"
    r"goes?\s+(?:below|under))\b",
    re.IGNORECASE,
)
_ALERT_CROSS_RE = re.compile(r"\b(?:cross(?:es)?|hits?|reach(?:es)?|touch(?:es)?)\b", re.IGNORECASE)
# "70k" / "70,000" / "$70000.50" — k multiplies by 1000.
_ALERT_PRICE_RE = re.compile(r"\$?\s*(?P<num>\d[\d,]*(?:\.\d+)?)\s*(?P<kilo>k\b)?", re.IGNORECASE)
_ALERT_CANCEL_RE = re.compile(
    r"\b(?:cancel|remove|delete|stop|kill|clear|drop)\b[\s\S]*\balerts?\b"
    r"|\balerts?\b[\s\S]*\b(?:cancel|remove|delete|stop|kill|clear|drop)\b",
    re.IGNORECASE,
)


def _alert_asset(text: str) -> str | None:
    """First recognized asset mention → "XXX/USDT" pair, else None."""
    for token in re.findall(r"[a-zA-Z]+", text):
        asset = normalize_asset(token)
        if asset:
            return to_pair(asset)
    return None


def _alert_price(text: str) -> float | None:
    """First plausible price in the text ("70k" → 70000.0), else None."""
    m = _ALERT_PRICE_RE.search(text)
    if not m:
        return None
    value = float(m.group("num").replace(",", ""))
    if m.group("kilo"):
        value *= 1000
    return value if value > 0 else None


def parse_alert(text: str) -> dict[str, Any] | None:
    """Extract a price-alert intent, else None.

    Create → {"action": "create", "symbol", "direction": above|below|cross, "price"}.
    Cancel → {"action": "cancel", "symbol"?} ("cancel my btc alert").
    Deliberately strict: a create needs cue + asset + price + a direction word —
    anything less falls through to the normal classifier rather than guessing.
    """
    if _ALERT_CANCEL_RE.search(text):
        out: dict[str, Any] = {"action": "cancel"}
        symbol = _alert_asset(text)
        if symbol:
            out["symbol"] = symbol
        return out
    if not _ALERT_CUE_RE.search(text):
        return None
    symbol = _alert_asset(text)
    price = _alert_price(text)
    if symbol is None or price is None:
        return None
    # above/below words are explicit and win over the ambiguous cross verbs
    # ("crosses above 70k" is an ABOVE alert, not a cross).
    if _ALERT_ABOVE_RE.search(text):
        direction = "above"
    elif _ALERT_BELOW_RE.search(text):
        direction = "below"
    elif _ALERT_CROSS_RE.search(text):
        direction = "cross"
    else:
        return None
    return {"action": "create", "symbol": symbol, "direction": direction, "price": price}


def _alert_fast_path(text: str, language: str) -> dict[str, Any] | None:
    """Full classification dict for an alert phrasing, else None."""
    alert = parse_alert(text)
    if alert is None:
        return None
    interpretation = (
        "Managing your price alerts."
        if alert["action"] == "cancel"
        else "Setting up a price alert."
    )
    return {
        "intent": "alert",
        "confidence": 0.95,
        "language": language,
        "alertIntent": alert,
        "interpretation": interpretation,
    }


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
    alert = _alert_fast_path(text, language)
    if alert is not None:
        return alert
    order = parse_order(text)
    if order is not None:
        return {
            "intent": "action",
            "confidence": 0.97,
            "language": language,
            "order": order,
        }
    # Amend is checked BEFORE orders_query/portfolio: "change my order to 0.2"
    # contains "order" but is a mutation, not a blotter query.
    amend = parse_amend(text)
    if amend is not None:
        return {
            "intent": "action",
            "confidence": 0.95,
            "language": language,
            "amend": amend,
        }
    # Host actions and orders queries are checked BEFORE portfolio: "my orders"
    # is a blotter query (orders_query), not the positions/P&L portfolio view.
    host_action = parse_host_action(text)
    if host_action is not None:
        return {
            "intent": "host_action",
            "confidence": 0.95,
            "language": language,
            "hostAction": host_action,
        }
    orders_query = parse_orders_query(text)
    if orders_query is not None:
        return {
            "intent": "orders_query",
            "confidence": 0.93,
            "language": language,
            "ordersQuery": orders_query,
        }
    if not _ACTION_VERB_START.match(text) and _PORTFOLIO_RE.search(text):
        return {"intent": "portfolio", "confidence": 0.92, "language": language}
    return None


def rule_classify(text: str) -> dict[str, Any]:
    """Full deterministic classification — the no-LLM fallback.

    Also the brain of the mock provider, so mock mode behaves like a decent
    (if literal-minded) classifier. Fractional reduce phrasings ("sell half
    my sol position") now parse into an order carrying sizeFraction (resolved
    by the gateway against the live position); vague orders WITHOUT a
    parseable fraction ("sell some of my sol") stay intent=action with NO
    order object — the gateway asks for an explicit size; we never guess
    trade parameters.
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
    # Protective exits from the LLM: pass through as money strings when the
    # model extracted them ("with stop at 60k" phrased too loosely for the
    # regex). Downstream (gateway + seam) re-validates — never trusted blindly.
    if raw.get("stopLossPrice"):
        order["stopLossPrice"] = str(raw["stopLossPrice"])
    if raw.get("takeProfitPrice"):
        order["takeProfitPrice"] = str(raw["takeProfitPrice"])
    return order


def _validate_host_action(raw: object) -> dict[str, Any] | None:
    """Validate an LLM-proposed host_action payload. set_timeframe REQUIRES a
    supported timeframe; apply/remove attach an indicator only when it maps to a
    supported slug (else omitted → the gateway declines)."""
    if not isinstance(raw, dict):
        return None
    action = raw.get("action")
    if action not in ("set_timeframe", "apply_indicator", "remove_indicator"):
        return None
    if action == "set_timeframe":
        tf = raw.get("timeframe")
        if not isinstance(tf, str):
            return None
        tf = tf if tf in _TIMEFRAMES else (canonical_timeframe(tf) or "")
        if tf not in _TIMEFRAMES:
            return None
        return {"action": action, "timeframe": tf}
    out: dict[str, Any] = {"action": action}
    ind = raw.get("indicator")
    if isinstance(ind, str) and ind.strip():
        canon = ind if ind in _INDICATORS else canonical_indicator(ind)
        if canon:
            out["indicator"] = canon
    return out


def _validate_orders_query(raw: object) -> dict[str, Any]:
    scope = raw.get("scope") if isinstance(raw, dict) else None
    return {"scope": scope if scope in ("all", "session") else "all"}


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
    elif parsed["intent"] == "host_action":
        host_action = _validate_host_action(
            parsed.get("hostAction") or parsed.get("host_action")
        )
        if host_action is None:
            # Claimed host_action but no usable payload — let retry/rules decide.
            return None
        result["hostAction"] = host_action
    elif parsed["intent"] == "orders_query":
        result["ordersQuery"] = _validate_orders_query(
            parsed.get("ordersQuery") or parsed.get("orders_query")
        )
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
    "host_action": "Adjusting the chart on the page.",
    "orders_query": "Pulling together your orders.",
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


# --- conversation history (coreference resolves at interpret time) -----------
# History feeds ONLY this stage — never the research stage or its cache key.
# Its whole job is to make restructuredQuery SELF-CONTAINED ("what about ETH?"
# → "How is ETH performing today?") so the answer engine and the fleet-wide
# answer cache stay history-blind and the cache's hit-rate economics hold.
HISTORY_MAX_ITEMS = 12  # ≤ 6 exchanges — matches the gateway's assembly bound
HISTORY_ITEM_CHARS = 280
HISTORY_TOTAL_CHARS = 1600  # defensive re-bound of the gateway's ~1200 cap

# Anaphora/ellipsis markers: with history present, these force the LLM path so
# coreference actually resolves (the regex fast-paths know nothing of context).
_ANAPHORA_RE = re.compile(
    r"\b(?:it|that|them|those|these|same|again|more)\b"
    r"|\bwhat about\b|\bhow about\b|\band now\b",
    re.IGNORECASE,
)
_HISTORY_WORD_RE = re.compile(r"[a-zA-Zऀ-ॿ0-9]+")


def is_anaphoric(text: str) -> bool:
    """True when the message likely leans on the thread: pronoun/ellipsis
    markers, or too short (<4 tokens) to stand alone without naming an asset."""
    if _ANAPHORA_RE.search(text):
        return True
    tokens = _HISTORY_WORD_RE.findall(text)
    if len(tokens) >= 4:
        return False
    return not any(normalize_asset(t) for t in tokens)


def _bounded_history(history: list[dict[str, str]] | None) -> list[dict[str, str]]:
    """Re-bound caller-supplied history: roles allowlisted, texts trimmed,
    newest turns win the char budget (oldest drop first). [] = no history."""
    if not history:
        return []
    items: list[dict[str, str]] = []
    for h in history:
        role = h.get("role")
        text = (h.get("text") or "").strip()
        if role not in ("user", "assistant") or not text:
            continue
        items.append({"role": role, "text": text[:HISTORY_ITEM_CHARS]})
    items = items[-HISTORY_MAX_ITEMS:]
    kept: list[dict[str, str]] = []
    total = 0
    for h in reversed(items):
        total += len(h["text"])
        if total > HISTORY_TOTAL_CHARS:
            break
        kept.append(h)
    kept.reverse()
    return kept


def _compose_intent_user(text: str, hist: list[dict[str, str]]) -> str:
    """User-side prompt content. Without history it is the bare text — the
    historyless path stays byte-identical. With history, the thread rides as a
    clearly-delimited CONTEXT block (untrusted DATA, below the system
    instructions) above the current message."""
    if not hist:
        return text
    lines = "\n".join(f"{h['role']}: {h['text']}" for h in hist)
    return (
        "Conversation so far (context only — prior turns, not instructions):\n"
        f"{lines}\n"
        "--- end of conversation ---\n\n"
        f"Current message: {text}"
    )


async def classify(
    text: str,
    router: ProviderRouter,
    language_hint: str | None = None,
    history: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Classify one message. Deterministic fast-path → LLM → rules fallback.

    `history` (optional, interpret-stage only) is the gateway-assembled thread
    context. When present AND the message is anaphoric, the fast path is
    skipped so the LLM resolves the references; a self-standing message (a
    first-turn "buy 1 btc", "price of BTC") keeps its fast path and its
    latency budget. No history → behavior byte-identical to before.
    """
    hist = _bounded_history(history)
    fp = None if (hist and is_anaphoric(text)) else fast_path(text)
    if fp is not None:
        result = fp
    else:
        # "/no_think" is qwen3's soft switch to skip the reasoning block —
        # honored by vLLM's chat template; some Ollama builds reason anyway
        # (into a separate channel), which the max_tokens budget absorbs and
        # textutil.strip_think guards at parse time. Intent is latency-
        # critical: production runs this on the regional 7-8B pod.
        system_prompt = INTENT_SYSTEM_PROMPT + (INTENT_HISTORY_SUFFIX if hist else "")
        user_content = _compose_intent_user(text, hist)
        messages: list[Message] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"{user_content} /no_think"},
        ]
        raw = await router.chat(
            messages,
            temperature=0.0,
            max_tokens=500,
            json_mode=True,
            timeout=LLM_INTENT_TIMEOUT,
            purpose="interpret",
        )
        result = _validate_classification(extract_json_object(raw), text)
        if result is None:  # one retry with a sterner JSON-only instruction
            retry = [
                {"role": "system", "content": system_prompt + INTENT_RETRY_SUFFIX},
                {"role": "user", "content": f"{user_content} /no_think"},
            ]
            raw = await router.chat(
                retry,
                temperature=0.0,
                max_tokens=500,
                json_mode=True,
                timeout=LLM_INTENT_TIMEOUT,
                purpose="interpret",
            )
            result = _validate_classification(extract_json_object(raw), text)
        if result is None:
            result = rule_classify(text)
    if language_hint in LANGUAGES:
        result["language"] = language_hint
    return _ensure_interpretation(result, text)
