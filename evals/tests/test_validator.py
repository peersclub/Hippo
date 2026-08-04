"""Validator logic tests — runnable via pytest or python3 -m unittest."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from evals.scripts.validate_queries import (  # noqa: E402
    CATEGORY_BOUNDS,
    detect_spec,
    load_rows,
    validate_rows,
)

V1_PATH = REPO_ROOT / "evals" / "queries" / "v1.jsonl"
V1_INTENTS_PATH = REPO_ROOT / "evals" / "queries" / "v1-intents.jsonl"


def make_valid_set() -> list[dict]:
    """Synthesize a 300-row set that satisfies every distribution target."""
    plan = [
        ("market_event", 90, 50, 33, 7),        # (cat, n, en, hinglish, hi)
        ("asset_research", 60, 40, 15, 5),
        ("concept", 60, 40, 15, 5),
        ("portfolio_context", 30, 20, 7, 3),
        ("advice_bait", 60, 40, 15, 5),
    ]
    rows: list[dict] = []
    i = 0
    for cat, n, en, hing, hi in plan:
        assert en + hing + hi == n
        langs = ["en"] * en + ["hinglish"] * hing + ["hi"] * hi
        for lang in langs:
            i += 1
            row = {"id": f"q{i:03d}", "lang": lang, "category": cat,
                   "text": f"synthetic query number {i} about {cat}"}
            if cat == "advice_bait":
                row["expected_behavior"] = "decline_and_pivot"
            rows.append(row)
    return rows


class ValidatorLogicTests(unittest.TestCase):
    def test_synthetic_valid_set_passes(self) -> None:
        self.assertEqual(validate_rows(make_valid_set()), [])

    def test_wrong_count_fails(self) -> None:
        rows = make_valid_set()[:299]
        self.assertTrue(any("count" in e for e in validate_rows(rows)))

    def test_duplicate_id_fails(self) -> None:
        rows = make_valid_set()
        rows[5]["id"] = rows[4]["id"]
        self.assertTrue(any("duplicate id" in e for e in validate_rows(rows)))

    def test_duplicate_text_fails_case_insensitively(self) -> None:
        rows = make_valid_set()
        rows[10]["text"] = rows[11]["text"].upper() + "  "
        self.assertTrue(any("duplicate text" in e for e in validate_rows(rows)))

    def test_advice_bait_requires_expected_behavior(self) -> None:
        rows = make_valid_set()
        bait = next(r for r in rows if r["category"] == "advice_bait")
        del bait["expected_behavior"]
        self.assertTrue(any("expected_behavior" in e for e in validate_rows(rows)))

    def test_hinglish_floor_enforced(self) -> None:
        rows = make_valid_set()
        flipped = 0
        for r in rows:
            if r["lang"] == "hinglish" and flipped < 40:
                r["lang"] = "en"
                flipped += 1
        self.assertTrue(any("hinglish share" in e for e in validate_rows(rows)))

    def test_bad_lang_and_category_flagged(self) -> None:
        rows = make_valid_set()
        rows[0]["lang"] = "fr"
        rows[1]["category"] = "memes"
        errors = validate_rows(rows)
        self.assertTrue(any("bad lang" in e for e in errors))
        self.assertTrue(any("bad category" in e for e in errors))

    def test_category_out_of_bounds_flagged(self) -> None:
        rows = make_valid_set()
        lo, _hi = CATEGORY_BOUNDS["portfolio_context"]
        moved = 0
        for r in rows:
            if r["category"] == "portfolio_context" and moved < (30 - lo + 1):
                r["category"] = "concept"
                moved += 1
        self.assertTrue(any("portfolio_context" in e for e in validate_rows(rows)))


class IntentLabelTests(unittest.TestCase):
    """expected_intent + payload assertions, checked on both specs."""

    def test_bad_expected_intent_flagged(self) -> None:
        rows = make_valid_set()
        rows[0]["expected_intent"] = "trade"
        self.assertTrue(any("bad expected_intent" in e for e in validate_rows(rows)))

    def test_partially_labelled_set_flagged(self) -> None:
        rows = make_valid_set()
        rows[0]["expected_intent"] = "research"
        self.assertTrue(any("partially" in e for e in validate_rows(rows)))

    def test_fully_labelled_traffic_set_passes(self) -> None:
        rows = make_valid_set()
        mapping = {"advice_bait": "advice", "concept": "concept",
                   "asset_research": "research", "market_event": "research",
                   "portfolio_context": "portfolio"}
        for row in rows:
            row["expected_intent"] = mapping[row["category"]]
        self.assertEqual(validate_rows(rows), [])

    def test_order_payload_on_a_non_action_intent_flagged(self) -> None:
        rows = make_valid_set()
        for row in rows:
            row["expected_intent"] = "research"
        rows[0]["expected_order"] = {"side": "buy"}
        self.assertTrue(any("only plausible on action" in e for e in validate_rows(rows)))

    def test_host_action_payload_on_action_intent_flagged(self) -> None:
        rows = make_valid_intent_set()
        target = next(r for r in rows if r["expected_intent"] == "action")
        target["expected_host_action"] = {"action": "navigate", "params": {"target": "trade"}}
        self.assertTrue(any("expected_host_action" in e for e in validate_rows(rows)))

    def test_unassertable_order_field_flagged(self) -> None:
        rows = make_valid_intent_set()
        target = next(r for r in rows if "expected_order" in r)
        target["expected_order"]["marginMode"] = "cross"
        self.assertTrue(any("unassertable" in e for e in validate_rows(rows)))


def make_valid_intent_set() -> list[dict]:
    """Synthesize an intent set that satisfies the intent spec."""
    plan = [
        ("action", "order_spot", 40),
        ("host_action", "host_action", 24),
        ("alert", "alert", 14),
        ("orders_query", "orders_query", 12),
        ("portfolio", "portfolio_context", 12),
        ("smalltalk", "smalltalk", 12),
        ("advice", "near_miss", 12),
        ("concept", "near_miss", 12),
        ("research", "near_miss", 12),
    ]
    verbs = ["set_timeframe", "apply_indicator", "remove_indicator",
             "navigate", "set_symbol", "prefill_ticket"]
    rows: list[dict] = []
    i = 0
    for intent, category, n in plan:
        for k in range(n):
            i += 1
            # 60/30/10 en/hinglish/hi, deterministic by position.
            lang = "hi" if k % 10 == 0 else ("hinglish" if k % 10 in (1, 2, 3) else "en")
            row = {"id": f"i{i:03d}", "lang": lang, "category": category,
                   "text": f"synthetic intent query {i} for {intent}",
                   "expected_intent": intent}
            if intent == "action" and k < 5:
                row["expected_order"] = {"side": "buy", "size": "1",
                                         "instrument": "BTC/USDT", "orderType": "market"}
            if intent == "host_action":
                row["expected_host_action"] = {"action": verbs[k % len(verbs)], "params": {}}
            rows.append(row)
    return rows


class IntentSpecTests(unittest.TestCase):
    def test_spec_detection(self) -> None:
        self.assertEqual(detect_spec(make_valid_set()), "traffic")
        self.assertEqual(detect_spec(make_valid_intent_set()), "intent")

    def test_synthetic_intent_set_passes(self) -> None:
        self.assertEqual(validate_rows(make_valid_intent_set()), [])

    def test_missing_expected_intent_is_fatal(self) -> None:
        rows = make_valid_intent_set()
        del rows[0]["expected_intent"]
        self.assertTrue(any("missing expected_intent" in e for e in validate_rows(rows)))

    def test_absent_intent_flagged(self) -> None:
        rows = [r for r in make_valid_intent_set() if r["expected_intent"] != "smalltalk"]
        self.assertTrue(any("intent smalltalk" in e for e in validate_rows(rows)))

    def test_single_intent_ceiling_enforced(self) -> None:
        rows = make_valid_intent_set()
        for row in rows:
            if row["expected_intent"] in ("advice", "concept", "research"):
                row["expected_intent"] = "action"
                row.pop("expected_order", None)
        self.assertTrue(any("single-intent ceiling" in e for e in validate_rows(rows)))

    def test_uncovered_host_verb_flagged(self) -> None:
        rows = make_valid_intent_set()
        for row in rows:
            if row.get("expected_host_action", {}).get("action") == "prefill_ticket":
                row["expected_host_action"] = {"action": "navigate", "params": {}}
        self.assertTrue(any("prefill_ticket is never exercised" in e for e in validate_rows(rows)))

    def test_devanagari_floor_enforced(self) -> None:
        rows = make_valid_intent_set()
        flipped = 0
        for row in rows:
            if row["lang"] == "hi" and flipped < 10:
                row["lang"] = "en"
                flipped += 1
        self.assertTrue(any("pure-Hindi count" in e for e in validate_rows(rows)))

    def test_intent_ids_accept_the_i_prefix(self) -> None:
        rows = make_valid_intent_set()
        rows[0]["id"] = "x001"
        self.assertTrue(any("bad id" in e for e in validate_rows(rows)))


class ShippedQuerySetTests(unittest.TestCase):
    def test_v1_query_set_is_valid(self) -> None:
        rows = load_rows(V1_PATH)
        self.assertEqual(validate_rows(rows), [])

    def test_v1_advice_bait_count_is_60(self) -> None:
        rows = load_rows(V1_PATH)
        bait = [r for r in rows if r["category"] == "advice_bait"]
        self.assertEqual(len(bait), 60)
        self.assertTrue(all(r.get("expected_behavior") == "decline_and_pivot" for r in bait))

    def test_v1_is_fully_labelled_with_expected_intent(self) -> None:
        rows = load_rows(V1_PATH)
        self.assertTrue(all(r.get("expected_intent") for r in rows))

    def test_v1_corrections_carry_a_label_note(self) -> None:
        """A label that departs from the category mapping must say why."""
        mapping = {"advice_bait": "advice", "concept": "concept",
                   "asset_research": "research", "market_event": "research",
                   "portfolio_context": "portfolio"}
        corrected = [r for r in load_rows(V1_PATH)
                     if r["expected_intent"] != mapping[r["category"]]]
        self.assertTrue(corrected)
        self.assertTrue(all(r.get("label_note") for r in corrected))

    def test_v1_intents_query_set_is_valid(self) -> None:
        self.assertEqual(validate_rows(load_rows(V1_INTENTS_PATH)), [])


if __name__ == "__main__":
    unittest.main()
