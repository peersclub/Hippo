"""Price-alert intent parsing: the deterministic phrase table.

All tests run offline — parse_alert and the fast_path dispatch are pure. The
"crosses"/"hits" family resolves to direction 'cross': the GATEWAY decides
above/below against the live price at creation, never this service.
"""
from __future__ import annotations

import unittest

from intent import fast_path, parse_alert, rule_classify


class AlertCreateParsing(unittest.TestCase):
    def test_phrase_table(self) -> None:
        cases = [
            # (text, symbol, direction, price)
            ("alert me when BTC crosses 70k", "BTC/USDT", "cross", 70000.0),
            ("alert me when btc hits 70000", "BTC/USDT", "cross", 70000.0),
            ("alert me when BTC goes above 70k", "BTC/USDT", "above", 70000.0),
            ("alert me when btc goes below 50,000", "BTC/USDT", "below", 50000.0),
            ("tell me if ETH drops under 3000", "ETH/USDT", "below", 3000.0),
            ("tell me when eth reaches $3,500", "ETH/USDT", "cross", 3500.0),
            ("notify me when sol rises above 150", "SOL/USDT", "above", 150.0),
            ("let me know when bitcoin falls below 55k", "BTC/USDT", "below", 55000.0),
            ("set an alert when doge touches 0.5", "DOGE/USDT", "cross", 0.5),
            ("warn me if xrp goes over 2", "XRP/USDT", "above", 2.0),
        ]
        for text, symbol, direction, price in cases:
            with self.subTest(text=text):
                self.assertEqual(
                    parse_alert(text),
                    {"action": "create", "symbol": symbol, "direction": direction, "price": price},
                )

    def test_explicit_above_below_beats_cross_verbs(self) -> None:
        # "crosses above" is an ABOVE alert, not an ambiguous cross.
        alert = parse_alert("alert me when btc crosses above 70k")
        assert alert is not None
        self.assertEqual(alert["direction"], "above")

    def test_kilo_suffix_multiplies(self) -> None:
        alert = parse_alert("alert me when btc crosses 70k")
        assert alert is not None
        self.assertEqual(alert["price"], 70000.0)
        alert = parse_alert("alert me when btc crosses 70000")
        assert alert is not None
        self.assertEqual(alert["price"], 70000.0)

    def test_strict_requirements_fall_through(self) -> None:
        # No cue → not an alert (an order, a question, whatever else).
        self.assertIsNone(parse_alert("btc above 70k"))
        # No price → never guess a level.
        self.assertIsNone(parse_alert("alert me when btc moons"))
        # No recognized asset → never guess an instrument.
        self.assertIsNone(parse_alert("alert me when it crosses 70k"))
        # No direction word → never guess a side.
        self.assertIsNone(parse_alert("alert me about btc at 70k"))


class AlertCancelParsing(unittest.TestCase):
    def test_cancel_with_symbol(self) -> None:
        self.assertEqual(
            parse_alert("cancel my btc alert"),
            {"action": "cancel", "symbol": "BTC/USDT"},
        )

    def test_cancel_without_symbol(self) -> None:
        self.assertEqual(parse_alert("remove my alerts"), {"action": "cancel"})
        self.assertEqual(parse_alert("delete the price alert"), {"action": "cancel"})


class AlertFastPathDispatch(unittest.TestCase):
    def test_fast_path_classifies_alert_with_payload(self) -> None:
        result = fast_path("alert me when BTC crosses 70k")
        assert result is not None
        self.assertEqual(result["intent"], "alert")
        self.assertGreaterEqual(result["confidence"], 0.9)
        self.assertEqual(
            result["alertIntent"],
            {"action": "create", "symbol": "BTC/USDT", "direction": "cross", "price": 70000.0},
        )
        self.assertIn("interpretation", result)

    def test_rule_classify_reaches_alerts_too(self) -> None:
        # The no-LLM fallback (mock mode) classifies alerts identically.
        result = rule_classify("tell me if eth drops under 3000")
        self.assertEqual(result["intent"], "alert")
        self.assertEqual(result["alertIntent"]["direction"], "below")

    def test_alert_phrasing_does_not_shadow_other_intents(self) -> None:
        # Orders, portfolio and advice keep their routes.
        fp = fast_path("buy 0.5 btc")
        assert fp is not None
        self.assertEqual(fp["intent"], "action")
        fp = fast_path("should i buy the dip?")
        assert fp is not None
        self.assertEqual(fp["intent"], "advice")
        self.assertIsNone(parse_alert("show my open orders"))


if __name__ == "__main__":
    unittest.main()
