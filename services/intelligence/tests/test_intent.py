"""Intent engine tests: deterministic fast-paths, order parsing, LLM fallback.

All tests run offline — no Ollama, no network. LLM-path tests use a scripted
router; everything else is pure functions.
"""
from __future__ import annotations

import unittest
from typing import Any

from intent import (
    canonical_indicator,
    canonical_timeframe,
    classify,
    detect_language,
    fast_path,
    parse_amend,
    parse_fractional_close,
    parse_host_action,
    parse_order,
    parse_orders_query,
    parse_size_fraction,
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
        # "some" is not a quantity OR a fraction — never guess trade parameters.
        self.assertIsNone(parse_order("sell some of my sol position"))

    def test_unparseable_trailing_text_defers(self) -> None:
        self.assertIsNone(parse_order("buy 1 btc when it dips"))


class FractionalCloseParsing(unittest.TestCase):
    def test_fraction_table(self) -> None:
        for phrase, fraction in (
            ("half", 0.5),
            ("a half", 0.5),
            ("quarter", 0.25),
            ("a quarter", 0.25),
            ("one third", 0.333),
            ("third", 0.333),
            ("25%", 0.25),
            ("12.5%", 0.125),
            ("100%", 1.0),
            ("all", 1.0),
            ("everything", 1.0),
        ):
            self.assertEqual(parse_size_fraction(phrase), fraction, phrase)

    def test_fraction_rejects(self) -> None:
        for phrase in ("150%", "0%", "some", "most", "101%"):
            self.assertIsNone(parse_size_fraction(phrase), phrase)

    def test_spot_sell_half(self) -> None:
        order = parse_fractional_close("sell half my sol position")
        self.assertEqual(
            order,
            {
                "side": "sell",
                "action": "close",
                "size": "",
                "sizeFraction": 0.5,
                "instrument": "SOL/USDT",
                "orderType": "market",
            },
        )

    def test_spot_percent_of(self) -> None:
        order = parse_fractional_close("sell 25% of my btc")
        assert order is not None
        self.assertEqual(order["sizeFraction"], 0.25)
        self.assertEqual(order["instrument"], "BTC/USDT")

    def test_spot_all(self) -> None:
        order = parse_fractional_close("sell all my eth")
        assert order is not None
        self.assertEqual(order["sizeFraction"], 1.0)
        self.assertEqual(order["instrument"], "ETH/USDT")

    def test_spot_no_asset_falls_to_page_symbol(self) -> None:
        order = parse_fractional_close("sell half my position")
        assert order is not None
        self.assertEqual(order["instrument"], "")  # gateway uses the page symbol
        self.assertEqual(order["sizeFraction"], 0.5)

    def test_perp_close_half_long(self) -> None:
        order = parse_fractional_close("close half my long")
        assert order is not None
        self.assertEqual(order["capability"], "futures_perp")
        self.assertEqual(order["action"], "close")
        self.assertTrue(order["reduceOnly"])
        self.assertEqual(order["side"], "sell")  # closing a long sells
        self.assertEqual(order["sizeFraction"], 0.5)
        self.assertEqual(order["instrument"], "")

    def test_perp_close_with_asset(self) -> None:
        order = parse_fractional_close("close a quarter of my btc short")
        assert order is not None
        self.assertEqual(order["direction"], "short")
        self.assertEqual(order["side"], "buy")  # closing a short buys
        self.assertEqual(order["sizeFraction"], 0.25)
        self.assertEqual(order["instrument"], "BTC/USDT")

    def test_over_100_percent_defers(self) -> None:
        self.assertIsNone(parse_fractional_close("sell 150% of my sol"))

    def test_unknown_asset_defers(self) -> None:
        self.assertIsNone(parse_fractional_close("sell half my pepe"))

    def test_absolute_sizes_still_parse_unchanged(self) -> None:
        order = parse_order("sell 0.5 sol")
        self.assertEqual(
            order,
            {"side": "sell", "size": "0.5", "instrument": "SOL/USDT", "orderType": "market"},
        )
        order = parse_order("close long 0.5 btc")
        assert order is not None
        self.assertNotIn("sizeFraction", order)
        self.assertEqual(order["size"], "0.5")

    def test_fast_path_fractional_is_action_with_order(self) -> None:
        result = fast_path("sell half my sol position")
        assert result is not None
        self.assertEqual(result["intent"], "action")
        self.assertEqual(result["order"]["sizeFraction"], 0.5)

    def test_rule_classify_vague_still_no_order(self) -> None:
        result = rule_classify("sell some of my sol position")
        self.assertEqual(result["intent"], "action")
        self.assertNotIn("order", result)


class AmendParsing(unittest.TestCase):
    def test_move_limit_price_k_suffix(self) -> None:
        self.assertEqual(parse_amend("move my limit to 61k"), {"price": "61000"})

    def test_change_order_small_value_is_size(self) -> None:
        self.assertEqual(parse_amend("change my order to 0.2"), {"size": "0.2"})

    def test_explicit_price_word(self) -> None:
        self.assertEqual(parse_amend("update my order price to 60,000"), {"price": "60000"})

    def test_explicit_size_word(self) -> None:
        self.assertEqual(parse_amend("amend my order size to 1500"), {"size": "1500"})

    def test_bare_large_value_is_price(self) -> None:
        self.assertEqual(parse_amend("change my order to 61,500"), {"price": "61500"})

    def test_no_trigger_defers(self) -> None:
        self.assertIsNone(parse_amend("show my orders"))

    def test_no_value_defers(self) -> None:
        self.assertIsNone(parse_amend("change my order please"))

    def test_zero_value_defers(self) -> None:
        self.assertIsNone(parse_amend("change my order to 0"))

    def test_fast_path_amend_beats_orders_query(self) -> None:
        # Contains "order" but is a mutation — must not classify as orders_query.
        result = fast_path("change my order to 0.2")
        assert result is not None
        self.assertEqual(result["intent"], "action")
        self.assertEqual(result["amend"], {"size": "0.2"})
        self.assertNotIn("order", result)

    def test_fast_path_move_limit(self) -> None:
        result = fast_path("move my limit to 61k")
        assert result is not None
        self.assertEqual(result["intent"], "action")
        self.assertEqual(result["amend"], {"price": "61000"})

    def test_orders_query_still_wins_for_queries(self) -> None:
        result = fast_path("show all my orders")
        assert result is not None
        self.assertEqual(result["intent"], "orders_query")


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
        # ("half" now parses as a fraction — see FractionalCloseParsing — so
        # the still-vague phrasing here uses "some".)
        result = rule_classify("sell some of my sol position")
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

    async def test_fast_path_still_carries_interpretation(self) -> None:
        # No LLM call, but stage-1 output must still be present (templated).
        router = ScriptedRouter([])
        result = await classify("buy 1 btc", router)
        self.assertEqual(router.calls, 0)
        self.assertTrue(result["interpretation"])
        self.assertEqual(result["restructuredQuery"], "buy 1 btc")

    async def test_llm_interpretation_and_restructure_pass_through(self) -> None:
        router = ScriptedRouter(
            [
                '{"intent":"research","confidence":0.9,"language":"en",'
                '"interpretation":"Wants the drivers behind the BTC drop.",'
                '"restructuredQuery":"What is driving the BTC/USDT price decline today?"}'
            ]
        )
        result = await classify("why btc down", router)
        self.assertEqual(result["interpretation"], "Wants the drivers behind the BTC drop.")
        self.assertEqual(
            result["restructuredQuery"],
            "What is driving the BTC/USDT price decline today?",
        )

    async def test_missing_interpretation_gets_deterministic_default(self) -> None:
        # Model omitted the new fields — the validator must not drop the result,
        # and _ensure_interpretation backfills both.
        router = ScriptedRouter(['{"intent":"research","confidence":0.9,"language":"en"}'])
        result = await classify("why btc down", router)
        self.assertEqual(result["intent"], "research")
        self.assertTrue(result["interpretation"])
        self.assertEqual(result["restructuredQuery"], "why btc down")


class HostActionParsing(unittest.TestCase):
    def test_timeframe_candles(self) -> None:
        for text, tf in (
            ("switch the chart to 5m candles", "5m"),
            ("show me the 15m candles", "15m"),
            ("change timeframe to 1h", "1h"),
            ("set the chart to 4h", "4h"),
            ("switch to daily", "1d"),
            ("make it 1 minute candles", "1m"),
        ):
            ha = parse_host_action(text)
            self.assertIsNotNone(ha, text)
            assert ha is not None
            self.assertEqual(ha["action"], "set_timeframe")
            self.assertEqual(ha["timeframe"], tf, text)

    def test_bare_timeframe_without_trigger_is_not_host_action(self) -> None:
        # "in the last 5m" is not a chart command — no trigger word.
        self.assertIsNone(parse_host_action("why is btc up in the last 5m"))

    def test_apply_indicator(self) -> None:
        for text, ind in (
            ("apply RSI", "rsi"),
            ("add the 20 day moving average", "sma20"),
            ("show volume", "vol"),
            ("overlay a 50 day ma", "sma50"),
            ("apply ema", "ema20"),
            ("add sma20", "sma20"),
        ):
            ha = parse_host_action(text)
            self.assertIsNotNone(ha, text)
            assert ha is not None
            self.assertEqual(ha["action"], "apply_indicator")
            self.assertEqual(ha.get("indicator"), ind, text)

    def test_remove_indicator(self) -> None:
        ha = parse_host_action("remove the moving average")
        assert ha is not None
        self.assertEqual(ha["action"], "remove_indicator")
        self.assertEqual(ha["indicator"], "sma20")
        ha = parse_host_action("hide rsi")
        assert ha is not None
        self.assertEqual(ha["action"], "remove_indicator")
        self.assertEqual(ha["indicator"], "rsi")

    def test_unsupported_indicator_omits_slug(self) -> None:
        # An indicator hint is present ("indicator") but "ichimoku" isn't in the
        # demo set — classify host_action, no slug, so the gateway declines
        # honestly instead of guessing.
        ha = parse_host_action("apply the ichimoku indicator")
        assert ha is not None
        self.assertEqual(ha["action"], "apply_indicator")
        self.assertNotIn("indicator", ha)

    def test_canonicalisers(self) -> None:
        self.assertEqual(canonical_timeframe("15m"), "15m")
        self.assertIsNone(canonical_timeframe("3m"))  # unsupported minute
        self.assertEqual(canonical_indicator("20 day moving average"), "sma20")
        self.assertEqual(canonical_indicator("volume"), "vol")
        self.assertIsNone(canonical_indicator("macd"))

    def test_fast_path_classifies_host_action(self) -> None:
        result = fast_path("switch to 5m candles")
        assert result is not None
        self.assertEqual(result["intent"], "host_action")
        self.assertEqual(result["hostAction"]["timeframe"], "5m")


class OrdersQueryParsing(unittest.TestCase):
    def test_all_scope_default(self) -> None:
        for text in ("show all my orders", "my orders", "list my orders"):
            oq = parse_orders_query(text)
            self.assertIsNotNone(oq, text)
            assert oq is not None
            self.assertEqual(oq["scope"], "all", text)

    def test_session_scope(self) -> None:
        for text in (
            "orders in this session",
            "what have I traded today",
            "my orders right now",
            "current session orders",
        ):
            oq = parse_orders_query(text)
            self.assertIsNotNone(oq, text)
            assert oq is not None
            self.assertEqual(oq["scope"], "session", text)

    def test_non_orders_defers(self) -> None:
        self.assertIsNone(parse_orders_query("what is the btc price"))

    def test_fast_path_orders_query_beats_portfolio(self) -> None:
        # "my orders" is the blotter query, not the positions/P&L portfolio view.
        result = fast_path("show all my orders")
        assert result is not None
        self.assertEqual(result["intent"], "orders_query")
        self.assertEqual(result["ordersQuery"]["scope"], "all")

    def test_portfolio_still_wins_for_positions(self) -> None:
        result = fast_path("what are my positions?")
        assert result is not None
        self.assertEqual(result["intent"], "portfolio")


class HostActionOrdersLLMPath(unittest.IsolatedAsyncioTestCase):
    async def test_llm_host_action_validated(self) -> None:
        router = ScriptedRouter(
            [
                '{"intent":"host_action","confidence":0.9,"language":"en",'
                '"hostAction":{"action":"set_timeframe","timeframe":"1h"}}'
            ]
        )
        result = await classify("put it on the hourly", router)
        self.assertEqual(result["intent"], "host_action")
        self.assertEqual(result["hostAction"]["timeframe"], "1h")

    async def test_llm_host_action_missing_payload_falls_back(self) -> None:
        # Claimed host_action but no usable payload → retry, then rules fallback
        # (which reclassifies deterministically — here, research).
        router = ScriptedRouter(
            [
                '{"intent":"host_action","confidence":0.9,"language":"en"}',
                '{"intent":"host_action","confidence":0.9,"language":"en"}',
            ]
        )
        result = await classify("why is btc down today", router)
        self.assertEqual(router.calls, 2)
        self.assertEqual(result["intent"], "research")

    async def test_llm_orders_query_scope(self) -> None:
        router = ScriptedRouter(
            [
                '{"intent":"orders_query","confidence":0.9,"language":"en",'
                '"ordersQuery":{"scope":"session"}}'
            ]
        )
        result = await classify("everything I've done in here", router)
        self.assertEqual(result["intent"], "orders_query")
        self.assertEqual(result["ordersQuery"]["scope"], "session")

    async def test_host_action_carries_interpretation(self) -> None:
        router = ScriptedRouter([])  # fast-path hit, no LLM
        result = await classify("apply RSI", router)
        self.assertEqual(router.calls, 0)
        self.assertEqual(result["intent"], "host_action")
        self.assertTrue(result["interpretation"])


if __name__ == "__main__":
    unittest.main()
