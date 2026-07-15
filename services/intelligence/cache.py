"""Answer cache — THIS IS THE UNIT-ECONOMICS ENGINE (strategy memo §9).

Market-level answers are factual, not personalized opinions, so they are
identical across users: generated ONCE, served fleet-wide. Correlated demand
spikes ("why is BTC down" × 50k users during a dump) become the cheapest
traffic instead of the most expensive. Cache hit rate is the pilot's most
important single metric — it underwrites the flat rate card.

Local shape: in-memory TTL dict. Production: Redis, key-compatible
(cache:{canonical_q}:{asset}:{window}), TTL scaled by the volatility monitor.

Key = (canonical question, symbol, 5-minute market window bucket). The window
bucket makes "as of" honest: two users in the same window share a moment.
"""
from __future__ import annotations

import re
import time
from typing import Any, Sequence

from textutil import canonical_text

DEFAULT_TTL_S = 120.0
WINDOW_S = 300  # 5-minute market window bucket

# --- volatility-scaled TTL ----------------------------------------------------
# TTL tied to market volatility (Build Plan 03): a calm market can serve the
# same brief for longer without lying about "right now"; a moving market
# expires it fast. Production drives this from the market-data volatility
# monitor (which also pre-warms burst GPU capacity before the query wave);
# locally we approximate realized volatility from the snapshot's spark line.
# Note the window bucket still bounds staleness — a calm TTL mostly means the
# entry survives its whole 5-minute window.
CALM_TTL_S = 300.0
VOLATILE_TTL_S = 45.0
_CALM_STDEV_PCT = 0.15      # per-step move stdev (%) at or below = calm
_VOLATILE_STDEV_PCT = 0.45  # at or above = volatile


def volatility_scaled_ttl(
    spark: Sequence[float] | None, base_ttl: float = DEFAULT_TTL_S
) -> float:
    """TTL for a brief given its spark line (hourly closes)."""
    if not spark or len(spark) < 3:
        return base_ttl
    returns = [
        (cur - prev) / prev * 100.0
        for prev, cur in zip(spark, spark[1:])
        if prev
    ]
    if len(returns) < 2:
        return base_ttl
    mean = sum(returns) / len(returns)
    stdev = (sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)) ** 0.5
    if stdev <= _CALM_STDEV_PCT:
        return CALM_TTL_S
    if stdev >= _VOLATILE_STDEV_PCT:
        return VOLATILE_TTL_S
    return base_ttl

# Keyword canonicalization: map common phrasings (EN + Hinglish) of the same
# market question onto one key. This rule table is the dev stand-in — the
# intent engine's canonicalization is the production version (it also makes
# suggested-query chips deliberate cache levers).
_CANON_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("why-down", re.compile(r"\bwhy\b.*\b(?:down|fall|falling|drop|dropping|dump|dumping|crash|crashing|red)\b")),
    ("why-down", re.compile(r"\b(?:kyu|kyun|kyon)\b.*\bgir\b|\bgir\b.*\b(?:raha|rahi)\b")),
    ("why-up", re.compile(r"\bwhy\b.*\b(?:up|rising|pump|pumping|rally|rallying|green|mooning)\b")),
    ("why-up", re.compile(r"\b(?:kyu|kyun|kyon)\b.*\b(?:badh|chadh)\b")),
    ("price-now", re.compile(r"\b(?:price|bhav|rate)\b.*\b(?:now|today|abhi|current|kitna|kitne)\b|\b(?:kitna|kitne)\b.*\b(?:price|bhav)\b")),
    ("funding-now", re.compile(r"\bfunding\b")),
    ("whats-happening", re.compile(r"\b(?:what.?s|whats) (?:happening|going on|up) with\b|\bkya (?:ho raha|hua)\b")),
]


def canonicalize(text: str, symbol: str) -> str:
    """Canonical cache-key form of a question, scoped to a symbol."""
    canon = canonical_text(text)
    for tag, pattern in _CANON_RULES:
        if pattern.search(canon):
            return f"{tag}:{symbol}"
    return f"q:{canon}:{symbol}"


def window_bucket(now: float | None = None) -> int:
    return int((now if now is not None else time.time()) // WINDOW_S)


class AnswerCache:
    """In-memory TTL cache with hit-rate telemetry for /health."""

    def __init__(self, ttl_s: float = DEFAULT_TTL_S) -> None:
        self.ttl_s = ttl_s
        self._store: dict[tuple[str, int], tuple[float, dict[str, Any]]] = {}
        self.hits = 0
        self.misses = 0

    def _key(self, text: str, symbol: str, now: float) -> tuple[str, int]:
        return (canonicalize(text, symbol), window_bucket(now))

    def get(
        self, text: str, symbol: str, now: float | None = None
    ) -> dict[str, Any] | None:
        now = now if now is not None else time.time()
        key = self._key(text, symbol, now)
        entry = self._store.get(key)
        if entry is None or entry[0] <= now:
            if entry is not None:
                del self._store[key]
            self.misses += 1
            return None
        self.hits += 1
        return entry[1]

    def set(
        self,
        text: str,
        symbol: str,
        answer: dict[str, Any],
        now: float | None = None,
        ttl_s: float | None = None,
    ) -> None:
        now = now if now is not None else time.time()
        ttl = self.ttl_s if ttl_s is None else ttl_s
        self._store[self._key(text, symbol, now)] = (now + ttl, answer)

    def stats(self) -> dict[str, Any]:
        total = self.hits + self.misses
        # Prune expired entries so /health reports live occupancy.
        now = time.time()
        self._store = {k: v for k, v in self._store.items() if v[0] > now}
        return {
            "entries": len(self._store),
            "hitRate": round(self.hits / total, 4) if total else 0.0,
        }
