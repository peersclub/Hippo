"""Streaming respond tests: event order, prose extraction from a JSON stream,
guardrail replace, volatility-scaled TTL. All offline."""
from __future__ import annotations

import json
import unittest
from typing import Any, AsyncIterator
from unittest.mock import patch

import research
from cache import (
    CALM_TTL_S,
    DEFAULT_TTL_S,
    VOLATILE_TTL_S,
    AnswerCache,
    volatility_scaled_ttl,
)
from providers import MockProvider, ProviderError
from textutil import JsonProseExtractor
from tests.test_research import SNAPSHOT, fake_snapshot, offline_router

CLEAN_BRIEF = {
    "headline": "BTC is down 2.1% over 12 hours",
    "paragraphs": [
        "As of the snapshot, BTC trades at 64,732, down 2.1%.",
        "Perp funding sits at +0.010%, so positioning leans long.",
    ],
    "followups": ["What is funding saying?", "How volatile is BTC today?"],
}
ADVICE_BRIEF = {
    "headline": "BTC looks weak",
    "paragraphs": ["You should buy the dip now, it's a great entry."],
    "followups": ["More?", "Chart?"],
}


def chunked(text: str, size: int = 7) -> list[str]:
    """Split anywhere — including mid-escape — like a real token stream."""
    return [text[i : i + size] for i in range(0, len(text), size)]


class ScriptedStreamRouter:
    """Duck-typed router streaming canned chunks; chat() replays canned text."""

    def __init__(self, chunks: list[str], chat_outputs: list[str] | None = None) -> None:
        self.chunks = list(chunks)
        self.chat_outputs = list(chat_outputs or [])
        self.mode = "mock"
        self.model = "scripted"

    async def chat_stream(self, messages: list[dict[str, str]], **_: Any) -> AsyncIterator[str]:
        for chunk in self.chunks:
            if chunk == "<ERROR>":
                raise ProviderError("mid-stream failure")
            yield chunk

    async def chat(self, messages: list[dict[str, str]], **_: Any) -> str:
        return self.chat_outputs.pop(0) if self.chat_outputs else "{}"


async def collect(agen: AsyncIterator[dict[str, Any]]) -> list[dict[str, Any]]:
    return [ev async for ev in agen]


class ProseExtractor(unittest.TestCase):
    def _extract(self, payload: dict, size: int = 7) -> str:
        ex = JsonProseExtractor()
        return "".join(ex.feed(c) for c in chunked(json.dumps(payload), size))

    def test_headline_and_paragraphs_only(self) -> None:
        visible = self._extract(CLEAN_BRIEF)
        expected = (
            CLEAN_BRIEF["headline"] + "\n\n" + "\n\n".join(CLEAN_BRIEF["paragraphs"])
        )
        self.assertEqual(visible, expected)
        self.assertNotIn("What is funding saying?", visible)  # followups hidden

    def test_chunk_size_invariance(self) -> None:
        # Splitting mid-escape / mid-key must not change the visible output.
        outputs = {self._extract(CLEAN_BRIEF, size) for size in (1, 3, 5, 64, 4096)}
        self.assertEqual(len(outputs), 1)

    def test_escape_decoding(self) -> None:
        payload = {"headline": 'He said \\"buy\\" ₹\n done', "paragraphs": ["a\tb"]}
        visible = self._extract(payload, 2)
        self.assertEqual(visible, 'He said \\"buy\\" ₹\n done\n\na\tb')

    def test_nested_objects_are_not_prose(self) -> None:
        payload = {
            "headline": "H",
            "stats": [{"k": "LAST", "v": "64,732"}],
            "paragraphs": ["P"],
        }
        self.assertEqual(self._extract(payload), "H\n\nP")

    def test_keys_never_leak(self) -> None:
        visible = self._extract(CLEAN_BRIEF, 1)
        self.assertNotIn("headline", visible)
        self.assertNotIn("followups", visible)


class RespondStreamFlow(unittest.IsolatedAsyncioTestCase):
    async def test_event_order_and_done_shape(self) -> None:
        router = ScriptedStreamRouter(chunked(json.dumps(CLEAN_BRIEF)))
        cache = AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            events = await collect(
                research.respond_stream("why is btc down", "research", router, cache)
            )
        kinds = [e["event"] for e in events]
        self.assertEqual(kinds[0], "meta")  # retrieval lands before generation
        self.assertEqual(kinds[-1], "done")
        self.assertGreater(kinds.count("delta"), 1)
        meta = events[0]["data"]
        self.assertEqual(meta["asOfIso"], SNAPSHOT["asOfIso"])  # from snapshot
        self.assertEqual(meta["sparkPoints"], SNAPSHOT["spark"])
        done = events[-1]["data"]
        self.assertEqual(done["kind"], "brief")
        self.assertEqual(done["headline"], CLEAN_BRIEF["headline"])
        self.assertFalse(done["cached"])
        streamed = "".join(e["data"]["text"] for e in events if e["event"] == "delta")
        self.assertIn(CLEAN_BRIEF["headline"], streamed)
        self.assertNotIn("{", streamed)  # readable prose, not raw JSON

    async def test_second_call_streams_from_cache(self) -> None:
        router = ScriptedStreamRouter(chunked(json.dumps(CLEAN_BRIEF)))
        cache = AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            await collect(
                research.respond_stream("why is btc down", "research", router, cache)
            )
            events = await collect(
                research.respond_stream("btc kyu gir raha hai?", "research", router, cache)
            )
        self.assertEqual([e["event"] for e in events], ["meta", "done"])
        self.assertTrue(events[1]["data"]["cached"])

    async def test_advice_intent_yields_single_decline(self) -> None:
        router = ScriptedStreamRouter([])
        cache = AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            events = await collect(
                research.respond_stream("should i buy?", "advice", router, cache)
            )
        self.assertEqual([e["event"] for e in events], ["decline"])
        self.assertEqual(len(events[0]["data"]["facts"]), 3)

    async def test_guardrail_trip_replaces_with_decline(self) -> None:
        router = ScriptedStreamRouter(chunked(json.dumps(ADVICE_BRIEF)))
        cache = AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            events = await collect(
                research.respond_stream("why is btc down", "research", router, cache)
            )
        self.assertEqual(events[-1]["event"], "replace")
        self.assertEqual(events[-1]["data"]["kind"], "decline")
        # A tripped answer must never be cached.
        self.assertIsNone(cache.get("why is btc down", "BTC:en"))

    async def test_mid_stream_error_still_finalizes(self) -> None:
        # Only a prefix of the JSON arrives, then the provider dies: the
        # partial stream is unusable, so the blocking floor (mock) fills in.
        router = ScriptedStreamRouter(
            [json.dumps(CLEAN_BRIEF)[:25], "<ERROR>"],
            chat_outputs=["not json", "still not"],
        )
        cache = AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            events = await collect(
                research.respond_stream("why is btc down", "research", router, cache)
            )
        self.assertEqual(events[-1]["event"], "done")  # finalized, no exception
        self.assertEqual(events[-1]["data"]["kind"], "brief")

    async def test_mock_provider_end_to_end(self) -> None:
        router = offline_router()
        cache = AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            events = await collect(
                research.respond_stream("why is btc down", "research", router, cache)
            )
        kinds = [e["event"] for e in events]
        self.assertEqual(kinds[0], "meta")
        self.assertEqual(kinds[-1], "done")
        self.assertGreater(kinds.count("delta"), 1)  # mock streams chunks
        streamed = "".join(e["data"]["text"] for e in events if e["event"] == "delta")
        self.assertNotIn('"headline"', streamed)  # extractor hides JSON keys


class MockStreaming(unittest.IsolatedAsyncioTestCase):
    async def test_mock_streams_parseable_json(self) -> None:
        mock = MockProvider()
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": 'QUESTION: what is leverage?\n{"headline"}'},
        ]
        chunks = [c async for c in mock.chat_stream(messages)]
        self.assertGreater(len(chunks), 1)
        parsed = json.loads("".join(chunks))
        self.assertIn("headline", parsed)


class VolatilityTTL(unittest.TestCase):
    def test_calm_market_long_ttl(self) -> None:
        calm = [64000 + i * 5 for i in range(13)]  # ~0.008% steps
        self.assertEqual(volatility_scaled_ttl(calm), CALM_TTL_S)

    def test_volatile_market_short_ttl(self) -> None:
        wild = [64000, 65200, 63800, 65500, 63500, 65800, 63000]
        self.assertEqual(volatility_scaled_ttl(wild), VOLATILE_TTL_S)

    def test_missing_spark_uses_default(self) -> None:
        self.assertEqual(volatility_scaled_ttl(None), DEFAULT_TTL_S)
        self.assertEqual(volatility_scaled_ttl([64000]), DEFAULT_TTL_S)

    def test_cache_set_honors_ttl_override(self) -> None:
        cache = AnswerCache()
        t0 = 1_000_000_000.0 - (1_000_000_000 % 300)
        cache.set("why is btc down", "BTC", {"kind": "brief"}, now=t0, ttl_s=30.0)
        self.assertIsNotNone(cache.get("why is btc down", "BTC", now=t0 + 29))
        self.assertIsNone(cache.get("why is btc down", "BTC", now=t0 + 31))


if __name__ == "__main__":
    unittest.main()
