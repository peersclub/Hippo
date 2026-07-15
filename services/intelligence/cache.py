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
from typing import Any

from textutil import canonical_text

# TTL is fixed at 120s here; in production it is volatility-scaled (the
# market-data volatility monitor shrinks TTLs and pre-warms GPU burst).
DEFAULT_TTL_S = 120.0
WINDOW_S = 300  # 5-minute market window bucket

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
    ) -> None:
        now = now if now is not None else time.time()
        self._store[self._key(text, symbol, now)] = (now + self.ttl_s, answer)

    def stats(self) -> dict[str, Any]:
        total = self.hits + self.misses
        # Prune expired entries so /health reports live occupancy.
        now = time.time()
        self._store = {k: v for k, v in self._store.items() if v[0] > now}
        return {
            "entries": len(self._store),
            "hitRate": round(self.hits / total, 4) if total else 0.0,
        }
