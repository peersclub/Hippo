"""Intent-accuracy scoring tests: confusion maths, P/R/F1, payload diffing."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from evals.runner.intent_scoring import (  # noqa: E402
    INTENTS,
    UNKNOWN,
    aggregate_intent,
    compare_payload,
    confusion_matrix,
    normalize_host_action,
    payload_field_stats,
    per_intent_metrics,
    render_confusion_matrix,
    render_intent_summary_md,
    score_intent_query,
    values_equal,
    worst_confusions,
)


def graded(expected: str, predicted: str | None, **extra) -> dict:
    """A scored row, straight from the scorer so the shape stays honest."""
    query = {"id": extra.pop("id", "i001"), "lang": extra.pop("lang", "en"),
             "category": extra.pop("category", "near_miss"),
             "text": extra.pop("text", "some query"), "expected_intent": expected}
    query.update({k: v for k, v in extra.items() if k.startswith("expected_")})
    prediction = None if predicted is None else {"intent": predicted,
                                                 **{k: v for k, v in extra.items()
                                                    if not k.startswith("expected_")}}
    return score_intent_query(query, prediction)


class ValueComparisonTests(unittest.TestCase):
    def test_string_and_number_spellings_agree(self) -> None:
        self.assertTrue(values_equal("0.5", 0.5))
        self.assertTrue(values_equal(10, "10"))
        self.assertTrue(values_equal("60000", "60000"))
        self.assertTrue(values_equal(0.333, 0.333))

    def test_different_numbers_differ(self) -> None:
        self.assertFalse(values_equal("0.5", "0.6"))
        self.assertFalse(values_equal(10, 20))

    def test_strings_compare_case_insensitively(self) -> None:
        self.assertTrue(values_equal("BTC/USDT", "btc/usdt"))
        self.assertFalse(values_equal("BTC/USDT", "ETH/USDT"))

    def test_booleans_are_strict(self) -> None:
        """reduceOnly=True must not be satisfied by a truthy 1."""
        self.assertTrue(values_equal(True, True))
        self.assertFalse(values_equal(True, 1))
        self.assertFalse(values_equal(False, 0))
        self.assertFalse(values_equal(True, False))

    def test_none_only_matches_none(self) -> None:
        self.assertTrue(values_equal(None, None))
        self.assertFalse(values_equal(None, "buy"))


class HostActionNormalisationTests(unittest.TestCase):
    def test_flat_payload_folds_into_params(self) -> None:
        self.assertEqual(
            normalize_host_action({"action": "set_timeframe", "timeframe": "5m"}),
            {"action": "set_timeframe", "params": {"timeframe": "5m"}},
        )

    def test_nested_params_pass_through(self) -> None:
        self.assertEqual(
            normalize_host_action({"action": "prefill_ticket", "params": {"side": "buy"}}),
            {"action": "prefill_ticket", "params": {"side": "buy"}},
        )

    def test_non_dict_is_none(self) -> None:
        self.assertIsNone(normalize_host_action("set_timeframe"))
        self.assertIsNone(normalize_host_action(None))


class PayloadComparisonTests(unittest.TestCase):
    EXPECTED = {"side": "buy", "size": "0.5", "instrument": "BTC/USDT", "orderType": "market"}

    def test_exact_match(self) -> None:
        result = compare_payload("order", self.EXPECTED, dict(self.EXPECTED))
        self.assertTrue(result["exact"])
        self.assertEqual(result["n_match"], 4)
        self.assertEqual(result["n_expected"], 4)

    def test_wrong_value_is_flagged_not_missing(self) -> None:
        got = dict(self.EXPECTED, side="sell")
        result = compare_payload("order", self.EXPECTED, got)
        self.assertFalse(result["exact"])
        self.assertEqual(result["fields"]["side"]["status"], "wrong")
        self.assertEqual(result["fields"]["side"]["got"], "sell")
        self.assertEqual(result["n_match"], 3)

    def test_absent_key_is_missing(self) -> None:
        got = {k: v for k, v in self.EXPECTED.items() if k != "instrument"}
        result = compare_payload("order", self.EXPECTED, got)
        self.assertEqual(result["fields"]["instrument"]["status"], "missing")
        self.assertTrue(result["payload_present"])

    def test_absent_payload_makes_every_field_missing(self) -> None:
        result = compare_payload("order", self.EXPECTED, None)
        self.assertFalse(result["payload_present"])
        self.assertEqual(result["n_match"], 0)
        self.assertTrue(all(f["status"] == "missing" for f in result["fields"].values()))

    def test_extra_predicted_fields_are_ignored(self) -> None:
        """Labels assert only what a correct parse MUST produce."""
        got = dict(self.EXPECTED, marginMode="isolated", capability="spot")
        self.assertTrue(compare_payload("order", self.EXPECTED, got)["exact"])

    def test_host_action_compares_across_payload_shapes(self) -> None:
        result = compare_payload(
            "host_action",
            {"action": "set_timeframe", "params": {"timeframe": "5m"}},
            {"action": "set_timeframe", "timeframe": "5m"},
        )
        self.assertTrue(result["exact"])
        self.assertIn("params.timeframe", result["fields"])

    def test_host_action_wrong_slug_is_flagged(self) -> None:
        result = compare_payload(
            "host_action",
            {"action": "apply_indicator", "params": {"indicator": "sma50"}},
            {"action": "apply_indicator", "indicator": "sma20"},
        )
        self.assertEqual(result["fields"]["params.indicator"]["status"], "wrong")
        self.assertEqual(result["fields"]["action"]["status"], "match")


class ScoreIntentQueryTests(unittest.TestCase):
    def test_correct_classification(self) -> None:
        row = graded("action", "action")
        self.assertTrue(row["correct"])
        self.assertEqual(row["predicted_intent"], "action")

    def test_incorrect_classification(self) -> None:
        self.assertFalse(graded("action", "research")["correct"])

    def test_missing_prediction_is_unparsed_and_wrong(self) -> None:
        row = score_intent_query({"id": "i1", "expected_intent": "action"}, None, "boom")
        self.assertIsNone(row["predicted_intent"])
        self.assertFalse(row["correct"])
        self.assertEqual(row["error"], "boom")

    def test_camel_and_snake_host_action_keys_both_read(self) -> None:
        expected = {"action": "navigate", "params": {"target": "trade"}}
        for key in ("hostAction", "host_action"):
            row = score_intent_query(
                {"id": "i1", "expected_intent": "host_action", "expected_host_action": expected},
                {"intent": "host_action", key: {"action": "navigate", "params": {"target": "trade"}}},
            )
            self.assertTrue(row["payloads"]["host_action"]["exact"], key)

    def test_alert_payload_read_from_alertIntent(self) -> None:
        row = score_intent_query(
            {"id": "i1", "expected_intent": "alert",
             "expected_alert": {"action": "create", "symbol": "BTC/USDT", "price": 70000}},
            {"intent": "alert", "alertIntent": {"action": "create", "symbol": "BTC/USDT",
                                                "direction": "cross", "price": 70000.0}},
        )
        self.assertTrue(row["payloads"]["alert"]["exact"])

    def test_rows_without_labels_carry_no_payload_grades(self) -> None:
        self.assertEqual(graded("smalltalk", "smalltalk")["payloads"], {})


class ConfusionMatrixTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = [
            graded("action", "action"), graded("action", "action"),
            graded("action", "research"), graded("action", "orders_query"),
            graded("research", "research"),
            graded("concept", "orders_query"),
            graded("portfolio", None),
        ]

    def test_counts_land_in_the_right_cells(self) -> None:
        matrix = confusion_matrix(self.rows)
        self.assertEqual(matrix["action"], {"action": 2, "research": 1, "orders_query": 1})
        self.assertEqual(matrix["research"], {"research": 1})
        self.assertEqual(matrix["concept"], {"orders_query": 1})

    def test_unparsed_prediction_lands_in_the_unknown_column(self) -> None:
        self.assertEqual(confusion_matrix(self.rows)["portfolio"], {UNKNOWN: 1})

    def test_row_totals_equal_support(self) -> None:
        matrix = confusion_matrix(self.rows)
        self.assertEqual(sum(matrix["action"].values()), 4)
        self.assertEqual(sum(sum(c.values()) for c in matrix.values()), len(self.rows))

    def test_rendering_shows_diagonal_and_totals(self) -> None:
        text = render_confusion_matrix(confusion_matrix(self.rows))
        lines = text.splitlines()
        self.assertTrue(lines[0].startswith("expected \\ pred"))
        action_line = next(l for l in lines if l.startswith("action"))
        self.assertTrue(action_line.rstrip().endswith("4"))
        self.assertIn("act", lines[0])
        # a clean zero renders as a dot, so the diagonal reads at a glance
        self.assertIn(".", next(l for l in lines if l.startswith("research")))


class PerIntentMetricTests(unittest.TestCase):
    def setUp(self) -> None:
        # action: 3 labelled, 2 predicted right, 1 leaked to research.
        # research: 1 labelled and right, plus 1 false positive from action.
        self.rows = [
            graded("action", "action"), graded("action", "action"),
            graded("action", "research"),
            graded("research", "research"),
        ]
        self.metrics = per_intent_metrics(self.rows)

    def test_true_and_false_counts(self) -> None:
        action = self.metrics["action"]
        self.assertEqual((action["tp"], action["fp"], action["fn"], action["support"]),
                         (2, 0, 1, 3))
        research = self.metrics["research"]
        self.assertEqual((research["tp"], research["fp"], research["fn"], research["support"]),
                         (1, 1, 0, 1))

    def test_precision_recall_f1_are_hand_checkable(self) -> None:
        action = self.metrics["action"]
        self.assertAlmostEqual(action["precision"], 1.0)
        self.assertAlmostEqual(action["recall"], 2 / 3)
        self.assertAlmostEqual(action["f1"], 2 * 1.0 * (2 / 3) / (1.0 + 2 / 3))
        research = self.metrics["research"]
        self.assertAlmostEqual(research["precision"], 0.5)
        self.assertAlmostEqual(research["recall"], 1.0)
        self.assertAlmostEqual(research["f1"], 2 / 3)

    def test_absent_intent_has_no_metrics(self) -> None:
        smalltalk = self.metrics["smalltalk"]
        self.assertEqual(smalltalk["support"], 0)
        self.assertIsNone(smalltalk["precision"])
        self.assertIsNone(smalltalk["recall"])

    def test_every_intent_is_reported(self) -> None:
        self.assertEqual(set(self.metrics), set(INTENTS))


class PayloadStatsTests(unittest.TestCase):
    def test_field_totals_and_exact_rate(self) -> None:
        expected = {"side": "buy", "size": "1", "instrument": "BTC/USDT"}
        rows = [
            score_intent_query({"id": "a", "expected_intent": "action", "expected_order": expected},
                               {"intent": "action", "order": dict(expected)}),
            score_intent_query({"id": "b", "expected_intent": "action", "expected_order": expected},
                               {"intent": "action", "order": dict(expected, side="sell")}),
            score_intent_query({"id": "c", "expected_intent": "action", "expected_order": expected},
                               {"intent": "research"}),
        ]
        stats = payload_field_stats(rows)["order"]
        self.assertEqual(stats["rows"], 3)
        self.assertEqual(stats["exact_rows"], 1)
        self.assertEqual(stats["payload_missing_rows"], 1)
        self.assertEqual(stats["totals"], {"match": 5, "wrong": 1, "missing": 3})
        self.assertAlmostEqual(stats["field_accuracy"], 5 / 9)
        self.assertEqual(stats["fields"]["side"], {"match": 1, "wrong": 1, "missing": 1})


class WorstConfusionTests(unittest.TestCase):
    def test_sorted_by_count_with_examples(self) -> None:
        rows = (
            [graded("action", "research", id=f"i{i}", text=f"order {i}") for i in range(5)]
            + [graded("concept", "orders_query", id=f"j{i}", text=f"concept {i}") for i in range(2)]
            + [graded("action", "action")]
        )
        worst = worst_confusions(rows)
        self.assertEqual((worst[0]["expected"], worst[0]["got"], worst[0]["count"]),
                         ("action", "research", 5))
        self.assertEqual(worst[1]["count"], 2)
        self.assertEqual(len(worst[0]["examples"]), 3)
        self.assertEqual(worst[0]["examples"][0]["text"], "order 0")

    def test_correct_rows_are_never_confusions(self) -> None:
        self.assertEqual(worst_confusions([graded("action", "action")]), [])


class AggregateAndRenderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = [
            graded("action", "action", lang="en", category="order_spot"),
            graded("action", "research", lang="hinglish", category="order_spot"),
            graded("host_action", "host_action", lang="en", category="host_action",
                   expected_host_action={"action": "navigate", "params": {"target": "trade"}},
                   hostAction={"action": "navigate", "params": {"target": "trade"}}),
            graded("smalltalk", "research", lang="hi", category="smalltalk"),
        ]
        self.summary = aggregate_intent(self.rows)

    def test_overall_accuracy(self) -> None:
        self.assertEqual(self.summary["n"], 4)
        self.assertAlmostEqual(self.summary["accuracy"], 0.5)
        self.assertEqual(self.summary["overall"]["correct"], 2)

    def test_per_language_breakdown(self) -> None:
        self.assertAlmostEqual(self.summary["per_lang"]["en"]["accuracy"], 1.0)
        self.assertAlmostEqual(self.summary["per_lang"]["hinglish"]["accuracy"], 0.0)
        self.assertAlmostEqual(self.summary["per_lang"]["hi"]["accuracy"], 0.0)

    def test_per_category_breakdown(self) -> None:
        self.assertAlmostEqual(self.summary["per_category"]["order_spot"]["accuracy"], 0.5)

    def test_markdown_has_every_required_section(self) -> None:
        md = render_intent_summary_md(self.summary, backend="offline test",
                                      queries_path="x.jsonl", timestamp="20260101-000000",
                                      fail_under=0.9)
        for heading in ("Confusion matrix", "Per-intent precision / recall / F1",
                        "Per language", "Per category", "Payload-parameter accuracy",
                        "Worst confusions"):
            self.assertIn(heading, md)
        self.assertIn("offline test", md)
        self.assertIn("50.0%", md)
        self.assertIn("FAIL", md)  # 50% is under the 90% gate

    def test_markdown_gate_passes_when_accuracy_clears_it(self) -> None:
        md = render_intent_summary_md(self.summary, backend="b", queries_path="x",
                                      timestamp="t", fail_under=0.4)
        self.assertIn("PASS", md)

    def test_markdown_omits_the_gate_line_when_unset(self) -> None:
        md = render_intent_summary_md(self.summary, backend="b", queries_path="x",
                                      timestamp="t", fail_under=None)
        self.assertNotIn("--fail-under", md)


if __name__ == "__main__":
    unittest.main()
