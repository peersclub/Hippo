"""Confidence-aware clarification signals.

The gateway owns the POLICY (ask instead of guessing on a low-confidence costly
intent); this module owns the two signals it reads: the confidence itself, and
the optional ALTERNATIVE readings. What is asserted here is that those signals
stay trustworthy — the bimodal confidence split the threshold depends on, the
byte-identical high-confidence path, and the allowlisting of alternatives.
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from intent import (  # noqa: E402
    CLARIFY_THRESHOLD,
    _ensure_alternatives,
    _validate_alternatives,
    alternative_intents,
    fast_path,
    is_ambiguous_exit,
    rule_classify,
)

# Every phrasing the deterministic fast path claims to understand.
FAST_PATH_SAMPLES = [
    "buy 0.05 btc",
    "sell 12 sol at 140",
    "long 0.5 btc 10x",
    "close long 0.5 btc",
    "sell half my sol position",
    "move my limit to 61k",
    "switch to 5m candles",
    "apply rsi",
    "fill the ticket to buy 0.1 btc",
    "show all my orders",
    "alert me when btc goes above 70k",
    "cancel my btc alert",
    "should i buy btc",
    "my positions",
]

# Every phrasing that falls through to the deterministic rules.
FALLBACK_SAMPLES = [
    "sell some of my sol position",
    "close btc",
    "hey there",
    "what is a funding rate?",
    "why is btc down today",
]


class ConfidenceIsBimodal(unittest.TestCase):
    """The threshold needs no tuning because there is nothing between the two
    clusters. If a future branch lands a confidence inside the gap, this fails
    and the threshold has to be re-argued rather than silently drifting."""

    def test_every_fast_path_hit_is_above_the_threshold(self) -> None:
        for text in FAST_PATH_SAMPLES:
            with self.subTest(text=text):
                result = fast_path(text)
                assert result is not None, "sample no longer takes the fast path"
                self.assertGreaterEqual(result["confidence"], 0.92)
                self.assertGreater(result["confidence"], CLARIFY_THRESHOLD)

    def test_every_rule_fallback_is_below_the_threshold(self) -> None:
        for text in FALLBACK_SAMPLES:
            with self.subTest(text=text):
                self.assertIsNone(fast_path(text))
                confidence = rule_classify(text)["confidence"]
                self.assertLessEqual(confidence, 0.8)
                self.assertLess(confidence, CLARIFY_THRESHOLD)

    def test_threshold_sits_in_the_empty_gap(self) -> None:
        self.assertGreater(CLARIFY_THRESHOLD, 0.8)
        self.assertLess(CLARIFY_THRESHOLD, 0.92)


class AmbiguousExit(unittest.TestCase):
    def test_bare_exit_naming_an_asset_is_a_low_confidence_action(self) -> None:
        result = rule_classify("close btc")
        self.assertEqual(result["intent"], "action")
        self.assertLess(result["confidence"], CLARIFY_THRESHOLD)
        # Never a guessed order — the gateway asks, it does not place.
        self.assertNotIn("order", result)

    def test_exit_phrasings(self) -> None:
        for text in ("close btc", "exit my eth", "get me out of SOL", "flatten my position"):
            with self.subTest(text=text):
                self.assertTrue(is_ambiguous_exit(text))

    def test_needs_a_market_or_a_position_to_count(self) -> None:
        # "close the settings page" is not a trade — it must not become one.
        self.assertFalse(is_ambiguous_exit("close the settings page"))
        self.assertFalse(is_ambiguous_exit("what does liquidation mean"))

    def test_fully_specified_closes_keep_their_fast_path(self) -> None:
        result = rule_classify("close long 0.5 btc")
        self.assertEqual(result["intent"], "action")
        self.assertEqual(result["confidence"], 0.97)
        self.assertEqual(result["order"]["action"], "close")


class AlternativeReadings(unittest.TestCase):
    def test_exit_phrasing_offers_the_blotter(self) -> None:
        self.assertEqual(alternative_intents("close btc", "action"), ["orders_query"])

    def test_position_phrasing_offers_the_positions_view(self) -> None:
        self.assertIn("portfolio", alternative_intents("sell some of my sol position", "action"))

    def test_alert_and_host_action_offer_a_brief(self) -> None:
        self.assertEqual(alternative_intents("btc 70k", "alert")[0], "research")
        self.assertEqual(alternative_intents("eth", "host_action")[0], "research")

    def test_cheap_intents_get_none(self) -> None:
        for intent in ("research", "concept", "smalltalk", "portfolio", "orders_query"):
            with self.subTest(intent=intent):
                self.assertEqual(alternative_intents("close btc", intent), [])

    def test_never_more_than_two_and_never_the_primary(self) -> None:
        alts = alternative_intents("close my btc position and orders", "action")
        self.assertLessEqual(len(alts), 2)
        self.assertNotIn("action", alts)


class ValidateAlternatives(unittest.TestCase):
    def test_allowlists_known_cheap_intents(self) -> None:
        self.assertEqual(
            _validate_alternatives(["portfolio", "research"], "action"),
            ["portfolio", "research"],
        )

    def test_drops_costly_unknown_duplicate_and_primary(self) -> None:
        self.assertEqual(
            _validate_alternatives(
                ["action", "alert", "host_action", "nonsense", 7, "portfolio", "portfolio"],
                "action",
            ),
            ["portfolio"],
        )

    def test_non_list_is_empty(self) -> None:
        self.assertEqual(_validate_alternatives("portfolio", "action"), [])
        self.assertEqual(_validate_alternatives(None, "action"), [])


class HighConfidenceIsUntouched(unittest.TestCase):
    def test_fast_path_results_are_byte_identical(self) -> None:
        for text in FAST_PATH_SAMPLES:
            with self.subTest(text=text):
                result = fast_path(text)
                assert result is not None
                before = dict(result)
                _ensure_alternatives(result, text)
                self.assertEqual(result, before)
                self.assertNotIn("alternatives", result)

    def test_low_confidence_costly_result_gains_alternatives(self) -> None:
        result = rule_classify("close btc")
        _ensure_alternatives(result, "close btc")
        self.assertEqual(result["alternatives"], ["orders_query"])

    def test_low_confidence_CHEAP_result_gains_nothing(self) -> None:
        result = rule_classify("why is btc down today")
        _ensure_alternatives(result, "why is btc down today")
        self.assertNotIn("alternatives", result)


if __name__ == "__main__":
    unittest.main()
