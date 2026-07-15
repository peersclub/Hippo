"""Answer cache tests: canonicalizer, hit/expiry, 5-minute window buckets."""
from __future__ import annotations

import unittest

from cache import DEFAULT_TTL_S, WINDOW_S, AnswerCache, canonicalize, window_bucket
from textutil import canonical_text


class Canonicalizer(unittest.TestCase):
    def test_canonical_text(self) -> None:
        self.assertEqual(
            canonical_text("  Why is  BTC down, today?! "), "why is btc down today"
        )

    def test_en_and_hinglish_phrasings_share_a_key(self) -> None:
        # The memo's cache lever: same market question, one key, one generation.
        k1 = canonicalize("why is btc down today", "BTC")
        k2 = canonicalize("BTC kyu gir raha hai?", "BTC")
        k3 = canonicalize("Why is bitcoin dropping??", "BTC")
        self.assertEqual(k1, "why-down:BTC")
        self.assertEqual(k1, k2)
        self.assertEqual(k1, k3)

    def test_why_up_rule(self) -> None:
        self.assertEqual(canonicalize("why is eth pumping", "ETH"), "why-up:ETH")

    def test_symbol_scopes_the_key(self) -> None:
        self.assertNotEqual(
            canonicalize("why is it down", "BTC"), canonicalize("why is it down", "ETH")
        )

    def test_unmatched_question_falls_back_to_full_text(self) -> None:
        key = canonicalize("What happened at the fed meeting?", "BTC")
        self.assertEqual(key, "q:what happened at the fed meeting:BTC")


class CacheBehavior(unittest.TestCase):
    def setUp(self) -> None:
        self.cache = AnswerCache()
        self.answer = {"kind": "brief", "headline": "x"}
        # Fixed clock, aligned to a window start so tests are deterministic.
        self.t0 = 1_000_000_000.0 - (1_000_000_000 % WINDOW_S)

    def test_hit_within_ttl_and_window(self) -> None:
        self.cache.set("why is btc down", "BTC", self.answer, now=self.t0)
        hit = self.cache.get("btc kyu gir raha hai", "BTC", now=self.t0 + 60)
        self.assertEqual(hit, self.answer)  # cross-phrasing, cross-language hit

    def test_miss_after_ttl_expiry(self) -> None:
        self.cache.set("why is btc down", "BTC", self.answer, now=self.t0)
        self.assertIsNone(
            self.cache.get("why is btc down", "BTC", now=self.t0 + DEFAULT_TTL_S + 1)
        )

    def test_miss_across_window_bucket(self) -> None:
        # Set 10s before a window boundary: 20s later the TTL is still alive
        # but the 5-minute market window has rolled — a different moment.
        t_late = self.t0 + WINDOW_S - 10
        self.cache.set("why is btc down", "BTC", self.answer, now=t_late)
        self.assertIsNone(self.cache.get("why is btc down", "BTC", now=t_late + 20))
        self.assertEqual(window_bucket(t_late) + 1, window_bucket(t_late + 20))

    def test_symbol_isolation(self) -> None:
        self.cache.set("why is btc down", "BTC", self.answer, now=self.t0)
        self.assertIsNone(self.cache.get("why is eth down", "ETH", now=self.t0 + 1))

    def test_hit_rate_telemetry(self) -> None:
        self.cache.set("why is btc down", "BTC", self.answer, now=self.t0)
        self.cache.get("why is btc down", "BTC", now=self.t0 + 1)   # hit
        self.cache.get("random other thing", "BTC", now=self.t0 + 1)  # miss
        stats = self.cache.stats()
        self.assertEqual(stats["hitRate"], 0.5)
        self.assertIsInstance(stats["entries"], int)


if __name__ == "__main__":
    unittest.main()
