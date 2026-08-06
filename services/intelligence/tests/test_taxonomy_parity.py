"""Prompt ↔ parser taxonomy parity, service side.

The vitest twin (services/gateway/test/intent-parity.test.ts) asserts the four
enum SITES are textually equal. This file asserts the parser actually HONOURS
the taxonomy it declares:

  * every intent in INTENTS survives _validate_classification, so nothing the
    prompt can now return is dropped on the floor (the `alert` bug: emitted by
    the fast path, typed in the gateway, framed in the protocol — and rejected
    by the validator, so the model could never produce one);
  * a perpetual order round-trips with capability/direction/leverage/
    marginMode/action/reduceOnly INTACT (the money bug: the validator rebuilt
    orders from the seven spot keys, so "go long 0.5 btc with 10x leverage" —
    which misses the ^-anchored regex fast path — reached the gateway shaped
    like a spot market buy, with the raw-text long/short safety net suppressed
    and the close/reduce bypass unreachable);
  * every host verb gets its OWN interpretation line, so a page command never
    renders chart copy above a ticket chip.

All offline and pure: no provider, no network.
"""
from __future__ import annotations

import unittest

from intent import (
    _CHART_VERBS,
    _HOST_ACTION_VERBS,
    _ORDER_FIELDS,
    _validate_classification,
    _validate_order,
    default_interpretation,
    INTENTS,
)

# One synthetic model output per intent — the minimum payload the validator
# demands. Adding an intent to INTENTS without adding a row here fails the
# coverage test below, which is the point.
_SYNTHETIC: dict[str, dict] = {
    "research": {},
    "concept": {},
    "advice": {},
    "portfolio": {},
    "smalltalk": {},
    "action": {"order": {"side": "buy", "size": "0.5", "instrument": "BTC/USDT",
                         "orderType": "market"}},
    "host_action": {"hostAction": {"action": "set_timeframe", "timeframe": "5m"}},
    "orders_query": {"ordersQuery": {"scope": "session"}},
    "alert": {"alertIntent": {"action": "create", "symbol": "BTC/USDT",
                              "direction": "above", "price": 70000}},
}


class IntentRoundTrip(unittest.TestCase):
    def test_every_declared_intent_survives_validation(self) -> None:
        missing = INTENTS - _SYNTHETIC.keys()
        self.assertEqual(missing, set(), f"no synthetic payload for {sorted(missing)}")
        for intent in sorted(INTENTS):
            with self.subTest(intent=intent):
                parsed = {
                    "intent": intent,
                    "confidence": 0.9,
                    "language": "en",
                    "interpretation": "x",
                    **_SYNTHETIC[intent],
                }
                result = _validate_classification(parsed, "some message")
                self.assertIsNotNone(result, f"{intent} was rejected by the validator")
                assert result is not None
                self.assertEqual(result["intent"], intent)

    def test_alert_payload_survives(self) -> None:
        result = _validate_classification(
            {
                "intent": "alert",
                "confidence": 0.9,
                "language": "en",
                "alertIntent": {"action": "create", "symbol": "eth",
                                "direction": "below", "price": "3k"},
            },
            "give me a heads up if eth drops under 3k",
        )
        assert result is not None
        self.assertEqual(
            result["alertIntent"],
            {"action": "create", "symbol": "ETH/USDT", "direction": "below", "price": 3000.0},
        )

    def test_alert_without_a_level_is_rejected(self) -> None:
        # Nothing armable → reject the whole classification rather than emit an
        # alert with no price (retry/rules then decide).
        self.assertIsNone(
            _validate_classification(
                {"intent": "alert", "confidence": 0.9, "language": "en",
                 "alertIntent": {"action": "create", "symbol": "BTC/USDT"}},
                "alert me about btc",
            )
        )

    def test_alert_cancel_needs_no_price(self) -> None:
        result = _validate_classification(
            {"intent": "alert", "confidence": 0.9, "language": "en",
             "alertIntent": {"action": "cancel", "symbol": "BTC/USDT"}},
            "cancel my btc alerts",
        )
        assert result is not None
        self.assertEqual(result["alertIntent"], {"action": "cancel", "symbol": "BTC/USDT"})

    def test_unknown_direction_resolves_later_not_guessed(self) -> None:
        result = _validate_classification(
            {"intent": "alert", "confidence": 0.9, "language": "en",
             "alertIntent": {"action": "create", "symbol": "BTC/USDT", "price": 70000,
                             "direction": "sideways"}},
            "wake me at 70k on btc",
        )
        assert result is not None
        self.assertEqual(result["alertIntent"]["direction"], "cross")


class PerpOrderRoundTrip(unittest.TestCase):
    def test_full_perp_order_keeps_every_field(self) -> None:
        # The exact shape the prompt now asks for on "go long 0.5 btc with 10x
        # leverage" — a phrasing the ^-anchored _PERP_RE cannot reach.
        order = _validate_order(
            {
                "capability": "futures_perp",
                "side": "buy",
                "size": "0.5",
                "instrument": "BTC/USDT",
                "orderType": "market",
                "direction": "long",
                "leverage": 10,
                "marginMode": "isolated",
                "action": "open",
                "reduceOnly": False,
            }
        )
        self.assertEqual(
            order,
            {
                "capability": "futures_perp",
                "side": "buy",
                "size": "0.5",
                "instrument": "BTC/USDT",
                "orderType": "market",
                "direction": "long",
                "leverage": 10,
                "marginMode": "isolated",
                "action": "open",
                "reduceOnly": False,
            },
        )

    def test_hinglish_short_keeps_direction_and_leverage(self) -> None:
        # i025 in evals/reports/20260805-110904: "eth ka short kholo 5x me,
        # size 2" came back with direction/leverage/reduceOnly stripped.
        order = _validate_order(
            {
                "capability": "futures_perp",
                "side": "sell",
                "size": "2",
                "instrument": "ETH/USDT",
                "orderType": "market",
                "direction": "short",
                "leverage": 5,
                "action": "open",
                "reduceOnly": False,
            }
        )
        assert order is not None
        self.assertEqual(order["direction"], "short")
        self.assertEqual(order["leverage"], 5)
        self.assertEqual(order["capability"], "futures_perp")
        self.assertIs(order["reduceOnly"], False)

    def test_leverage_alone_is_enough_to_route_perp(self) -> None:
        # A model that named 20x but forgot capability/direction must not
        # degrade to a spot order: direction is derived from side + action.
        order = _validate_order(
            {"side": "sell", "size": "2", "instrument": "ETH/USDT",
             "orderType": "market", "leverage": 20}
        )
        assert order is not None
        self.assertEqual(order["capability"], "futures_perp")
        self.assertEqual(order["direction"], "short")
        self.assertEqual(order["leverage"], 20)

    def test_close_survives_so_the_gateway_bypass_stays_reachable(self) -> None:
        # action/reduceOnly are what route a close AROUND the draft flow;
        # stripping them resubmits it as an OPEN and doubles exposure.
        order = _validate_order(
            {"capability": "futures_perp", "side": "sell", "size": "1",
             "instrument": "BTC/USDT", "orderType": "market", "direction": "long",
             "action": "close", "reduceOnly": True, "leverage": 10}
        )
        assert order is not None
        self.assertEqual(order["action"], "close")
        self.assertIs(order["reduceOnly"], True)

    def test_fractional_close_carries_the_fraction_and_an_empty_size(self) -> None:
        order = _validate_order(
            {"capability": "futures_perp", "side": "sell", "size": "",
             "instrument": "SOL/USDT", "orderType": "market", "direction": "long",
             "action": "close", "reduceOnly": True, "sizeFraction": 0.5}
        )
        assert order is not None
        self.assertEqual(order["size"], "")
        self.assertEqual(order["sizeFraction"], 0.5)
        self.assertIs(order["reduceOnly"], True)

    def test_spot_order_is_unchanged(self) -> None:
        # The untagged spot shape the gateway has always seen — no capability
        # key, no perp fields invented.
        self.assertEqual(
            _validate_order({"side": "buy", "size": "0.5", "instrument": "btc",
                             "orderType": "market"}),
            {"side": "buy", "size": "0.5", "instrument": "BTC/USDT", "orderType": "market"},
        )

    def test_junk_is_still_rejected(self) -> None:
        self.assertIsNone(_validate_order({"side": "buy", "instrument": "BTC/USDT"}))
        self.assertIsNone(_validate_order({"side": "hodl", "size": "1", "instrument": "BTC/USDT"}))
        self.assertIsNone(
            _validate_order({"side": "buy", "size": "1", "instrument": "BTC/USDT",
                             "orderType": "limit"})
        )
        # Absurd leverage is not a licence to invent one.
        order = _validate_order({"side": "buy", "size": "1", "instrument": "BTC/USDT",
                                 "orderType": "market", "capability": "futures_perp",
                                 "leverage": 9999})
        assert order is not None
        self.assertEqual(order["leverage"], 10)

    def test_every_declared_order_field_is_reachable(self) -> None:
        # _ORDER_FIELDS is what the parity test compares against the prompt and
        # OrderIntent; this pins that the validator can actually EMIT each one.
        emitted: set[str] = set()
        for raw in (
            {"capability": "futures_perp", "side": "sell", "size": "",
             "instrument": "SOL/USDT", "orderType": "market", "direction": "long",
             "action": "close", "reduceOnly": True, "sizeFraction": 0.25,
             "marginMode": "cross", "leverage": 3},
            {"side": "buy", "size": "1", "instrument": "BTC/USDT", "orderType": "limit",
             "limitPrice": "60000", "stopLossPrice": "55000", "takeProfitPrice": "70000"},
        ):
            order = _validate_order(raw)
            assert order is not None
            emitted |= set(order)
        self.assertEqual(_ORDER_FIELDS - emitted, set())
        self.assertEqual(emitted - _ORDER_FIELDS, set())


class VerbAwareInterpretation(unittest.TestCase):
    def test_every_host_verb_has_its_own_line(self) -> None:
        seen: dict[str, str] = {}
        for verb in sorted(_HOST_ACTION_VERBS):
            with self.subTest(verb=verb):
                copy = default_interpretation(
                    {"intent": "host_action", "hostAction": {"action": verb}}
                )
                self.assertNotEqual(copy, "Adjusting the page for you.", f"no copy for {verb}")
                self.assertNotIn(copy, seen, f"{verb} reuses {seen.get(copy)}'s line")
                seen[copy] = verb

    def test_only_chart_verbs_talk_about_the_chart(self) -> None:
        # The bug: "go to the settings page" and "fill the order form to buy
        # 0.1 btc" both rendered "Adjusting the chart on the page." directly
        # above a correct Ticket → BUY 0.1 chip.
        for verb in sorted(_HOST_ACTION_VERBS):
            with self.subTest(verb=verb):
                copy = default_interpretation(
                    {"intent": "host_action", "hostAction": {"action": verb}}
                )
                self.assertEqual(
                    "chart" in copy.lower(),
                    verb in _CHART_VERBS,
                    f"{verb}: {copy!r}",
                )

    def test_unknown_verb_falls_back_without_claiming_a_chart(self) -> None:
        copy = default_interpretation({"intent": "host_action", "hostAction": {"action": "zoom"}})
        self.assertEqual(copy, "Adjusting the page for you.")
        self.assertNotIn("chart", copy.lower())

    def test_alert_copy_distinguishes_create_from_cancel(self) -> None:
        self.assertEqual(
            default_interpretation({"intent": "alert", "alertIntent": {"action": "cancel"}}),
            "Managing your price alerts.",
        )
        self.assertEqual(
            default_interpretation({"intent": "alert", "alertIntent": {"action": "create"}}),
            "Setting up a price alert.",
        )

    def test_every_intent_gets_a_line(self) -> None:
        for intent in sorted(INTENTS):
            with self.subTest(intent=intent):
                copy = default_interpretation({"intent": intent})
                self.assertTrue(copy)
                self.assertNotEqual(copy, "Working on it.", f"{intent} has no template")


if __name__ == "__main__":
    unittest.main()
