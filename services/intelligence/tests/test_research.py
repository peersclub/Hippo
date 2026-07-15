"""Research engine tests: guardrail trip→regenerate→decline, respond shapes.

All offline: market-data is patched with a fixture snapshot and the model is
either the deterministic mock or a scripted router.
"""
from __future__ import annotations

import json
import unittest
from typing import Any
from unittest.mock import patch

import research
from cache import AnswerCache
from guardrail import detect_advice_language
from providers import ProviderRouter

SNAPSHOT: dict[str, Any] = {
    "symbol": "BTC/USDT",
    "last": 64732.22,
    "lastDisplay": "64,732",
    "change12hPct": -2.1,
    "change12hDisplay": "-2.1%",
    "fundingRate": 0.0001,
    "fundingDisplay": "+0.010%",
    "spark": [64730, 64621, 64571, 64569, 64572, 64676, 64860],
    "asOfIso": "2026-07-15T04:32:17.928Z",
    "sources": ["BINANCE PUBLIC", "FUNDING"],
}


async def fake_snapshot(symbol: str, timeout: float = 3.0) -> dict | None:
    return dict(SNAPSHOT)


async def no_snapshot(symbol: str, timeout: float = 3.0) -> dict | None:
    return None


def offline_router() -> ProviderRouter:
    """A ProviderRouter permanently pinned to the mock provider."""
    router = ProviderRouter()
    router._down_until = float("inf")  # never even try the LLM endpoint
    return router


class ScriptedRouter:
    def __init__(self, outputs: list[str]) -> None:
        self.outputs = list(outputs)
        self.calls = 0
        self.mode = "mock"
        self.model = "scripted"

    async def chat(self, messages: list[dict[str, str]], **_: Any) -> str:
        self.calls += 1
        return self.outputs.pop(0) if self.outputs else "{}"


ADVICE_PROSE = json.dumps(
    {
        "headline": "BTC looks weak",
        "paragraphs": ["You should buy the dip now, it's a great entry."],
        "followups": ["More?", "Chart?"],
    }
)
CLEAN_PROSE = json.dumps(
    {
        "headline": "BTC is down 2.1% over 12 hours",
        "paragraphs": ["As of the snapshot, BTC trades at 64,732, down 2.1%."],
        "followups": ["What is funding saying?", "How volatile is BTC today?"],
    }
)


class GuardrailDetector(unittest.TestCase):
    def test_flags_recommendation_language(self) -> None:
        self.assertTrue(detect_advice_language("You should buy the dip now."))
        self.assertTrue(detect_advice_language("I would buy here."))
        self.assertTrue(detect_advice_language("This is a great entry to buy."))

    def test_negated_advice_is_clean(self) -> None:
        self.assertEqual(
            detect_advice_language("I can't tell you whether to buy or sell."), []
        )

    def test_factual_prose_is_clean(self) -> None:
        self.assertEqual(
            detect_advice_language(
                "As of 04:32 UTC, BTC trades at 64,732, down 2.1% over 12 hours."
            ),
            [],
        )


class GuardrailFlow(unittest.IsolatedAsyncioTestCase):
    """The trip → regenerate-once → decline enforcement ladder."""

    async def test_trip_then_clean_regen_serves_brief(self) -> None:
        router = ScriptedRouter([ADVICE_PROSE, CLEAN_PROSE])
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            out = await research.build_brief(
                "why is btc down", "BTC", router, concept_mode=False
            )
        self.assertEqual(out["kind"], "brief")
        self.assertEqual(router.calls, 2)  # exactly one regeneration

    async def test_double_trip_becomes_decline(self) -> None:
        router = ScriptedRouter([ADVICE_PROSE, ADVICE_PROSE])
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            out = await research.build_brief(
                "why is btc down", "BTC", router, concept_mode=False
            )
        self.assertEqual(out["kind"], "decline")
        self.assertEqual(router.calls, 2)
        self.assertEqual(len(out["facts"]), 3)
        # Decline facts carry LIVE snapshot numbers, not model output.
        self.assertIn("64,732", out["facts"][0]["text"])

    async def test_clean_first_pass_never_regenerates(self) -> None:
        router = ScriptedRouter([CLEAN_PROSE])
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            out = await research.build_brief(
                "why is btc down", "BTC", router, concept_mode=False
            )
        self.assertEqual(out["kind"], "brief")
        self.assertEqual(router.calls, 1)


class BriefShape(unittest.IsolatedAsyncioTestCase):
    async def test_market_brief_grounds_card_parts_in_snapshot(self) -> None:
        router = ScriptedRouter([CLEAN_PROSE])
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            out = await research.build_brief(
                "why is btc down", "BTC", router, concept_mode=False
            )
        # stats/spark/asOfIso/sources are retrieval, never generation.
        self.assertEqual(out["asOfIso"], SNAPSHOT["asOfIso"])
        self.assertEqual(out["sources"], SNAPSHOT["sources"])
        self.assertEqual(out["sparkPoints"], SNAPSHOT["spark"])
        self.assertLessEqual(len(out["stats"]), 3)
        stats = {s["k"]: s for s in out["stats"]}
        self.assertEqual(stats["LAST"]["v"], "64,732")
        self.assertEqual(stats["12H"]["tone"], "neg")
        self.assertEqual(stats["FUNDING"]["tone"], "pos")
        self.assertFalse(out["cached"])

    async def test_concept_brief_has_no_market_furniture(self) -> None:
        router = offline_router()
        out = await research.build_brief(
            "what is a funding rate?", "BTC", router, concept_mode=True
        )
        self.assertEqual(out["kind"], "brief")
        self.assertEqual(out["stats"], [])
        self.assertEqual(out["sources"], ["HIPPO KNOWLEDGE"])
        self.assertNotIn("sparkPoints", out)

    async def test_paragraph_word_clamp(self) -> None:
        long_para = " ".join(["word"] * 200)
        router = ScriptedRouter(
            [json.dumps({"headline": "h", "paragraphs": [long_para], "followups": ["a?", "b?"]})]
        )
        out = await research.build_brief("q", "BTC", router, concept_mode=True)
        self.assertLessEqual(len(out["paragraphs"][0].split()), 61)

    async def test_unparseable_model_output_degrades_to_mock_prose(self) -> None:
        router = ScriptedRouter(["not json", "still not json"])
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            out = await research.build_brief(
                "why is btc down", "BTC", router, concept_mode=False
            )
        self.assertEqual(out["kind"], "brief")  # deterministic floor, no error
        self.assertEqual(router.calls, 2)


class RespondShapes(unittest.IsolatedAsyncioTestCase):
    async def test_research_brief_shape(self) -> None:
        router, cache = offline_router(), AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            out = await research.respond("why is btc down today", "research", router, cache)
        self.assertEqual(out["kind"], "brief")
        for key in ("headline", "paragraphs", "stats", "sources", "followups", "asOfIso", "cached"):
            self.assertIn(key, out)
        self.assertTrue(1 <= len(out["paragraphs"]) <= 3)
        self.assertEqual(len(out["followups"]), 2)
        for stat in out["stats"]:
            self.assertEqual(set(stat), {"k", "v", "tone"})
            self.assertIn(stat["tone"], {"pos", "neg", "neutral"})

    async def test_advice_decline_shape(self) -> None:
        router, cache = offline_router(), AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            out = await research.respond("should i buy btc?", "advice", router, cache)
        self.assertEqual(out["kind"], "decline")
        for key in ("message", "pivotTitle", "facts", "followups"):
            self.assertIn(key, out)
        self.assertEqual(len(out["facts"]), 3)
        self.assertEqual(len(out["followups"]), 2)
        for fact in out["facts"]:
            self.assertEqual(set(fact), {"icon", "text"})

    async def test_advice_decline_localized(self) -> None:
        router, cache = offline_router(), AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            out = await research.respond(
                "kya main btc kharidun", "advice", router, cache, language="hinglish"
            )
        self.assertIn("nahi bata sakta", out["message"])

    async def test_cache_hit_labeled_with_original_as_of(self) -> None:
        router, cache = offline_router(), AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            first = await research.respond("why is btc down", "research", router, cache)
            second = await research.respond("btc kyu gir raha hai?", "research", router, cache)
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])  # canonicalizer folded the phrasings
        self.assertEqual(second["asOfIso"], first["asOfIso"])

    async def test_language_scopes_the_cache(self) -> None:
        router, cache = offline_router(), AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            await research.respond("why is btc down", "research", router, cache, language="en")
            hi = await research.respond(
                "btc kyu gir raha hai?", "research", router, cache, language="hinglish"
            )
        self.assertFalse(hi["cached"])  # a Hindi asker never gets the English brief

    async def test_snapshot_outage_degrades_gracefully(self) -> None:
        router, cache = offline_router(), AnswerCache()
        with patch.object(research, "fetch_snapshot", no_snapshot):
            out = await research.respond("why is btc down", "research", router, cache)
        self.assertEqual(out["kind"], "brief")
        self.assertEqual(out["stats"], [])  # no numbers invented to fill the gap
        self.assertEqual(out["sources"], ["HIPPO KNOWLEDGE"])


class ExperienceCalibration(unittest.IsolatedAsyncioTestCase):
    """Memory v1: experience level calibrates CONCEPT depth only — market
    briefs stay fleet-wide cacheable (the cache economics, memo §9)."""

    def test_depth_line_in_concept_prompt_only(self) -> None:
        concept = research._brief_user_prompt("what is funding?", "BTC", None, "en", "new")
        self.assertIn("CALIBRATE DEPTH", concept)
        self.assertIn("new to trading", concept)
        market = research._brief_user_prompt("why down?", "BTC", SNAPSHOT, "en", "new")
        self.assertNotIn("CALIBRATE DEPTH", market)

    async def test_concept_cache_scopes_by_level(self) -> None:
        router, cache = offline_router(), AnswerCache()
        first = await research.respond(
            "what is a funding rate?", "concept", router, cache, experience_level="new"
        )
        pro = await research.respond(
            "what is a funding rate?", "concept", router, cache, experience_level="pro"
        )
        again = await research.respond(
            "what is a funding rate?", "concept", router, cache, experience_level="new"
        )
        self.assertFalse(first["cached"])
        self.assertFalse(pro["cached"])  # a pro never gets the beginner depth
        self.assertTrue(again["cached"])  # same level shares the entry

    async def test_market_cache_ignores_level(self) -> None:
        router, cache = offline_router(), AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            await research.respond(
                "why is btc down", "research", router, cache, experience_level="new"
            )
            second = await research.respond(
                "why is btc down", "research", router, cache, experience_level="pro"
            )
        self.assertTrue(second["cached"])  # market answers stay fleet-wide


class NeverFiveHundredFloor(unittest.IsolatedAsyncioTestCase):
    """Regression for a live incident: httpx CLIENT CREATION raised OSError
    (broken CA bundle after a python upgrade), escaping the (HTTPError,
    ValueError) handlers and turning the never-500 fallback into a 500."""

    async def test_fetch_snapshot_swallows_oserror(self) -> None:
        import marketdata

        def boom(*_: object, **__: object) -> object:
            raise FileNotFoundError("ca bundle missing")

        with patch.object(marketdata.httpx, "AsyncClient", boom):
            self.assertIsNone(await marketdata.fetch_snapshot("BTC"))

    def test_static_decline_is_zero_io_and_well_shaped(self) -> None:
        out = research.static_decline("BTC", "en")
        self.assertEqual(out["kind"], "decline")
        self.assertEqual(len(out["facts"]), 3)
        self.assertEqual(len(out["followups"]), 2)
        for fact in out["facts"]:
            self.assertEqual(set(fact), {"icon", "text"})

    def test_static_decline_localized(self) -> None:
        self.assertIn("nahi bata sakta", research.static_decline("BTC", "hinglish")["message"])


if __name__ == "__main__":
    unittest.main()
