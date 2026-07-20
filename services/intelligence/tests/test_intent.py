"""Intent engine tests: deterministic fast-paths, order parsing, LLM fallback.

All tests run offline — no Ollama, no network. LLM-path tests use a scripted
router; everything else is pure functions.
"""
from __future__ import annotations

import unittest
from typing import Any

from intent import (
    classify,
    detect_language,
    fast_path,
    parse_order,
    rule_classify,
)


class ScriptedRouter:
    """Duck-typed ProviderRouter that replays canned completions."""

    def __init__(self, outputs: list[str]) -> None:
        self.outputs = list(outputs)
        self.calls = 0
        self.mode = "mock"
        self.model = "scripted"

    async def chat(self, messages: list[dict[str, str]], **_: Any) -> str:
        self.calls += 1
        return self.outputs.pop(0) if self.outputs else "{}"


class OrderParsing(unittest.TestCase):
    def test_market_buy(self) -> None:
        order = parse_order("buy 0.5 btc")
        self.assertEqual(
            order,
            {"side": "buy", "size": "0.5", "instrument": "BTC/USDT", "orderType": "market"},
        )

    def test_explicit_at_market(self) -> None:
        order = parse_order("sell 2 eth at market")
        assert order is not None
        self.assertEqual(order["orderType"], "market")
        self.assertEqual(order["instrument"], "ETH/USDT")

    def test_perp_long_with_leverage(self) -> None:
        order = parse_order("long 0.5 btc 10x")
        self.assertEqual(
            order,
            {
                "capability": "futures_perp",
                "side": "buy",
                "direction": "long",
                "action": "open",
                "leverage": 10,
                "marginMode": "isolated",
                "reduceOnly": False,
                "size": "0.5",
                "instrument": "BTC/USDT",
                "orderType": "market",
            },
        )

    def test_perp_short_cross(self) -> None:
        order = parse_order("short 1 eth 20x cross")
        assert order is not None
        self.assertEqual(order["capability"], "futures_perp")
        self.assertEqual(order["side"], "sell")
        self.assertEqual(order["leverage"], 20)
        self.assertEqual(order["marginMode"], "cross")

    def test_perp_close_is_reduce_only(self) -> None:
        order = parse_order("close long 0.5 btc")
        assert order is not None
        self.assertEqual(order["action"], "close")
        self.assertTrue(order["reduceOnly"])
        self.assertEqual(order["side"], "sell")  # closing a long sells

    def test_perp_limit(self) -> None:
        order = parse_order("long 2 sol 5x limit 140")
        assert order is not None
        self.assertEqual(order["orderType"], "limit")
        self.assertEqual(order["limitPrice"], "140")
        self.assertEqual(order["leverage"], 5)

    def test_spot_stays_untagged(self) -> None:
        order = parse_order("buy 0.5 btc")
        assert order is not None
        self.assertNotIn("capability", order)  # spot contract byte-identical

    def test_limit_with_at_symbol_and_commas(self) -> None:
        order = parse_order("sell 2 eth @ 3,100.50")
        assert order is not None
        self.assertEqual(order["orderType"], "limit")
        self.assertEqual(order["limitPrice"], "3100.50")

    def test_limit_with_at_word(self) -> None:
        order = parse_order("buy 10 doge at 0.5")
        assert order is not None
        self.assertEqual(order["orderType"], "limit")
        self.assertEqual(order["limitPrice"], "0.5")
        self.assertEqual(order["instrument"], "DOGE/USDT")

    def test_full_asset_name(self) -> None:
        order = parse_order("buy 1 bitcoin")
        assert order is not None
        self.assertEqual(order["instrument"], "BTC/USDT")

    def test_unknown_asset_defers(self) -> None:
        self.assertIsNone(parse_order("buy 5 pepe"))

    def test_vague_size_defers(self) -> None:
        # "half" is not an explicit quantity — never guess trade parameters.
        self.assertIsNone(parse_order("sell half my sol position"))

    def test_unparseable_trailing_text_defers(self) -> None:
        self.assertIsNone(parse_order("buy 1 btc when it dips"))


class FastPaths(unittest.TestCase):
    def test_explicit_order_is_action_with_order(self) -> None:
        result = fast_path("buy 0.25 sol at 150")
        assert result is not None
        self.assertEqual(result["intent"], "action")
        self.assertIn("order", result)
        self.assertEqual(result["order"]["instrument"], "SOL/USDT")

    def test_portfolio(self) -> None:
        for text in ("show my pnl", "what are my positions?", "p&l today"):
            result = fast_path(text)
            assert result is not None, text
            self.assertEqual(result["intent"], "portfolio")

    def test_advice_bait_english(self) -> None:
        for text in ("should i buy btc?", "is this the dip?", "good time to buy?"):
            result = fast_path(text)
            assert result is not None, text
            self.assertEqual(result["intent"], "advice")

    def test_advice_bait_hinglish(self) -> None:
        result = fast_path("kya main btc kharidun?")
        assert result is not None
        self.assertEqual(result["intent"], "advice")
        self.assertEqual(result["language"], "hinglish")

    def test_advice_beats_order_shape(self) -> None:
        # Advice check runs before order parsing.
        result = fast_path("should i buy 2 btc?")
        assert result is not None
        self.assertEqual(result["intent"], "advice")

    def test_ambiguous_goes_to_llm(self) -> None:
        self.assertIsNone(fast_path("why is btc down today"))


class RuleClassify(unittest.TestCase):
    def test_vague_order_is_action_without_order(self) -> None:
        # DECIDED behavior: intent=action, NO order object — the gateway asks
        # for an explicit size; the service never guesses trade parameters.
        result = rule_classify("sell half my sol position")
        self.assertEqual(result["intent"], "action")
        self.assertNotIn("order", result)

    def test_concept(self) -> None:
        self.assertEqual(rule_classify("what is a funding rate?")["intent"], "concept")

    def test_research(self) -> None:
        self.assertEqual(rule_classify("why is btc down today")["intent"], "research")

    def test_smalltalk(self) -> None:
        self.assertEqual(rule_classify("hey there")["intent"], "smalltalk")


class LanguageDetection(unittest.TestCase):
    def test_devanagari_is_hi(self) -> None:
        self.assertEqual(detect_language("बिटकॉइन क्यों गिर रहा है"), "hi")

    def test_romanized_hindi_is_hinglish(self) -> None:
        self.assertEqual(detect_language("btc kyu gir raha hai"), "hinglish")

    def test_plain_english(self) -> None:
        self.assertEqual(detect_language("why is btc down"), "en")


class ClassifyLLMPath(unittest.IsolatedAsyncioTestCase):
    async def test_valid_llm_json_is_used(self) -> None:
        router = ScriptedRouter(
            ['{"intent": "research", "confidence": 0.9, "language": "en"}']
        )
        result = await classify("hmm interesting market", router)
        self.assertEqual(result["intent"], "research")
        self.assertEqual(router.calls, 1)

    async def test_think_block_stripped_before_parse(self) -> None:
        router = ScriptedRouter(
            ['<think>user asks about news</think>{"intent": "research", "confidence": 0.8, "language": "en"}']
        )
        result = await classify("any big news moving markets", router)
        self.assertEqual(result["intent"], "research")
        self.assertEqual(router.calls, 1)

    async def test_one_retry_then_rules_fallback(self) -> None:
        router = ScriptedRouter(["not json at all", "still not json"])
        result = await classify("why is btc down today", router)
        self.assertEqual(router.calls, 2)  # exactly one retry
        self.assertEqual(result["intent"], "research")  # rules fallback

    async def test_retry_success(self) -> None:
        router = ScriptedRouter(
            ["garbage", '{"intent": "concept", "confidence": 0.7, "language": "en"}']
        )
        result = await classify("tell me about market structure", router)
        self.assertEqual(result["intent"], "concept")
        self.assertEqual(router.calls, 2)

    async def test_invalid_intent_value_rejected(self) -> None:
        router = ScriptedRouter(
            ['{"intent": "trading", "confidence": 0.9}', '{"intent": "hype"}']
        )
        result = await classify("why is btc down today", router)
        self.assertIn(result["intent"], {"research", "concept"})  # fallback

    async def test_fast_path_never_calls_llm(self) -> None:
        router = ScriptedRouter([])
        result = await classify("buy 1 btc", router)
        self.assertEqual(router.calls, 0)
        self.assertEqual(result["intent"], "action")

    async def test_language_hint_wins(self) -> None:
        router = ScriptedRouter([])
        result = await classify("buy 1 btc", router, language_hint="hi")
        self.assertEqual(result["language"], "hi")


if __name__ == "__main__":
    unittest.main()
