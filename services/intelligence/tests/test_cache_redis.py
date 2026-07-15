"""Redis-backed answer cache (C1). Uses fakeredis — no real Redis server.

Asserts the Redis backend is behaviourally equivalent to the in-memory cache
for the properties research.py relies on: cross-phrasing / cross-language hit,
symbol isolation, window-bucket miss, hit-rate telemetry — and that the
volatility-scaled TTL is preserved (forwarded to Redis PX verbatim).
"""
from __future__ import annotations

import unittest

import fakeredis

from cache import (
    CALM_TTL_S,
    VOLATILE_TTL_S,
    WINDOW_S,
    AnswerCache,
    RedisAnswerCache,
    make_answer_cache,
)


def redis_cache() -> RedisAnswerCache:
    return RedisAnswerCache(fakeredis.FakeStrictRedis(decode_responses=True))


class RedisCacheBehavior(unittest.TestCase):
    def setUp(self) -> None:
        self.cache = redis_cache()
        self.answer = {"kind": "brief", "headline": "x"}
        self.t0 = 1_000_000_000.0 - (1_000_000_000 % WINDOW_S)

    def test_cross_phrasing_cross_language_hit(self) -> None:
        # The memo's cache lever, over Redis: one key for the same question.
        self.cache.set("why is btc down", "BTC", self.answer, now=self.t0)
        hit = self.cache.get("btc kyu gir raha hai", "BTC", now=self.t0 + 60)
        self.assertEqual(hit, self.answer)

    def test_symbol_isolation(self) -> None:
        self.cache.set("why is btc down", "BTC", self.answer, now=self.t0)
        self.assertIsNone(self.cache.get("why is eth down", "ETH", now=self.t0 + 1))

    def test_miss_across_window_bucket(self) -> None:
        t_late = self.t0 + WINDOW_S - 10
        self.cache.set("why is btc down", "BTC", self.answer, now=t_late)
        self.assertIsNone(self.cache.get("why is btc down", "BTC", now=t_late + 20))

    def test_hit_rate_telemetry(self) -> None:
        self.cache.set("why is btc down", "BTC", self.answer, now=self.t0)
        self.cache.get("why is btc down", "BTC", now=self.t0 + 1)  # hit
        self.cache.get("random other thing", "BTC", now=self.t0 + 1)  # miss
        stats = self.cache.stats()
        self.assertEqual(stats["hitRate"], 0.5)
        self.assertEqual(stats["entries"], 1)

    def test_volatility_scaled_ttl_is_preserved(self) -> None:
        # A moving market gets the short TTL; a calm market the long one. The
        # backend forwards ttl_s to Redis PX — verify via the key's live PTTL.
        self.cache.set(
            "why is btc down", "BTC", self.answer, now=self.t0, ttl_s=VOLATILE_TTL_S
        )
        vol_key = self.cache._key("why is btc down", "BTC", self.t0)
        vol_pttl = self.cache.client.pttl(vol_key)
        self.assertGreater(vol_pttl, 0)
        self.assertLessEqual(vol_pttl, VOLATILE_TTL_S * 1000)

        self.cache.set(
            "why is eth up", "ETH", self.answer, now=self.t0, ttl_s=CALM_TTL_S
        )
        calm_key = self.cache._key("why is eth up", "ETH", self.t0)
        self.assertGreater(self.cache.client.pttl(calm_key), VOLATILE_TTL_S * 1000)


class BackendSelection(unittest.TestCase):
    def test_default_is_in_memory(self) -> None:
        self.assertIsInstance(make_answer_cache(redis_url=None), AnswerCache)

    def test_injected_client_selects_redis(self) -> None:
        cache = make_answer_cache(client=fakeredis.FakeStrictRedis(decode_responses=True))
        self.assertIsInstance(cache, RedisAnswerCache)

    def test_redis_and_memory_agree_on_a_hit(self) -> None:
        # Same sequence of operations → same observable result on both backends.
        answer = {"kind": "brief", "headline": "shared"}
        t0 = 1_000_000_000.0 - (1_000_000_000 % WINDOW_S)
        mem = AnswerCache()
        red = redis_cache()
        for cache in (mem, red):
            cache.set("why is btc down", "BTC", answer, now=t0)
            self.assertEqual(
                cache.get("btc kyu gir raha hai?", "BTC", now=t0 + 30), answer
            )
            self.assertIsNone(cache.get("unrelated", "BTC", now=t0 + 30))
            self.assertEqual(cache.stats()["hitRate"], 0.5)


if __name__ == "__main__":
    unittest.main()
