"""The wider host verbs must classify on the PRIMARY path (this service),
not only in the gateway's degraded-mode mirror — the live bug this pins:
"switch to ETH" routed to research because parse_host_action only knew the
chart trio."""
from __future__ import annotations

import unittest

from intent import fast_path, parse_host_action


class TestPrimaryPathHostVerbs(unittest.TestCase):
    def test_navigate(self) -> None:
        for text, target in [
            ("go to the settings page", "settings"),
            ("open settings", "settings"),
            ("take me to the trade tab", "trade"),
            ("navigate to how", "how"),
        ]:
            got = parse_host_action(text)
            assert got is not None, text
            self.assertEqual(got["action"], "navigate", text)
            self.assertEqual(got["params"]["target"], target, text)

    def test_set_symbol(self) -> None:
        got = parse_host_action("switch to ETH")
        assert got is not None
        self.assertEqual(got["action"], "set_symbol")
        self.assertEqual(got["params"]["symbol"], "ETH/USDT")
        got = parse_host_action("change the pair to sol/usdt")
        assert got is not None
        self.assertEqual(got["params"]["symbol"], "SOL/USDT")

    def test_set_symbol_guards(self) -> None:
        # Timeframe reading wins; research suffixes stay research; non-assets skip.
        got = parse_host_action("switch to 5m")
        assert got is not None
        self.assertEqual(got["action"], "set_timeframe")
        self.assertIsNone(parse_host_action("show me ETH price"))
        self.assertIsNone(parse_host_action("switch to the chart"))

    def test_prefill_before_order_parsers(self) -> None:
        res = fast_path("fill the ticket to buy 0.1 btc at 61000")
        assert res is not None
        self.assertEqual(res["intent"], "host_action")
        ha = res["hostAction"]
        self.assertEqual(ha["action"], "prefill_ticket")
        self.assertEqual(ha["params"], {"side": "buy", "qty": "0.1", "price": "61000"})
        # No price said -> no price invented.
        res2 = fast_path("prefill a sell of 2 eth")
        assert res2 is not None
        self.assertNotIn("price", res2["hostAction"]["params"])

    def test_plain_order_still_an_order(self) -> None:
        res = fast_path("buy 0.05 btc")
        assert res is not None
        self.assertEqual(res["intent"], "action")


if __name__ == "__main__":
    unittest.main()
