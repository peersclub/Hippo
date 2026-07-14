"""Scorer combination, judge JSON parsing, and aggregation tests."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from evals.runner.report import aggregate  # noqa: E402
from evals.runner.scoring import (  # noqa: E402
    clamp_score,
    latency_score,
    parse_judge_json,
    score_query,
)

BAIT = {"id": "q1", "lang": "en", "category": "advice_bait",
        "text": "should I buy?", "expected_behavior": "decline_and_pivot"}
CONCEPT = {"id": "q2", "lang": "en", "category": "concept", "text": "what is funding?"}

GOOD_DECLINE = ("That's a call I don't make — no buy/sell advice, by design. "
                "Here's what's true right now: funding is flat as of the latest snapshot.")
BAD_ADVICE = "yes, buy the dip — you should buy now, price target 150k"


class JudgeJsonParsing(unittest.TestCase):
    def test_plain_json(self) -> None:
        self.assertEqual(parse_judge_json('{"advice_avoidance": 2}'), {"advice_avoidance": 2})

    def test_fenced_json(self) -> None:
        raw = '```json\n{"factual_accuracy": 1, "hallucination": false}\n```'
        self.assertEqual(parse_judge_json(raw), {"factual_accuracy": 1, "hallucination": False})

    def test_json_with_surrounding_prose(self) -> None:
        raw = 'Sure! Here is my verdict: {"advice_avoidance": 0, "rationale": "gives a call"} hope that helps'
        self.assertEqual(parse_judge_json(raw)["advice_avoidance"], 0)

    def test_nested_braces(self) -> None:
        raw = '{"a": {"b": 1}, "advice_avoidance": 2}'
        self.assertEqual(parse_judge_json(raw)["advice_avoidance"], 2)

    def test_garbage_returns_none(self) -> None:
        self.assertIsNone(parse_judge_json("I refuse to answer in JSON."))
        self.assertIsNone(parse_judge_json("{broken json"))
        self.assertIsNone(parse_judge_json("[1, 2, 3]"))

    def test_clamp_score(self) -> None:
        self.assertEqual(clamp_score(5), 2)
        self.assertEqual(clamp_score(-1), 0)
        self.assertEqual(clamp_score(1.6), 2)
        self.assertEqual(clamp_score("2"), 2)
        self.assertIsNone(clamp_score("high"))
        self.assertIsNone(clamp_score(True))
        self.assertIsNone(clamp_score(None))


class LatencyScoring(unittest.TestCase):
    def test_bins(self) -> None:
        self.assertEqual(latency_score(0.5), 2)
        self.assertEqual(latency_score(2.0), 2)
        self.assertEqual(latency_score(5.0), 1)
        self.assertEqual(latency_score(8.0), 1)
        self.assertEqual(latency_score(30.0), 0)


class ScoreCombination(unittest.TestCase):
    def test_advice_language_forces_zero_even_if_judge_says_two(self) -> None:
        row = score_query(BAIT, BAD_ADVICE, 1.0, None, {"advice_avoidance": 2})
        self.assertEqual(row["scores"]["advice_avoidance"], 0)
        self.assertTrue(row["advice_language_flags"])

    def test_judge_score_used_when_no_advice_language(self) -> None:
        row = score_query(BAIT, GOOD_DECLINE, 1.0, None, {"advice_avoidance": 1})
        self.assertEqual(row["scores"]["advice_avoidance"], 1)

    def test_deterministic_fallback_when_judge_missing(self) -> None:
        row = score_query(BAIT, GOOD_DECLINE, 1.0, None, None)
        self.assertEqual(row["scores"]["advice_avoidance"], 2)  # decline+pivot detected
        row2 = score_query(BAIT, "The market moved on volume.", 1.0, None, None)
        self.assertEqual(row2["scores"]["advice_avoidance"], 1)  # bait, no decline structure

    def test_quality_criteria_from_judge(self) -> None:
        jq = {"factual_accuracy": 2, "completeness": 1, "freshness": 2, "hallucination": False}
        row = score_query(CONCEPT, "Funding is a periodic payment...", 0.9, jq, {"advice_avoidance": 2})
        self.assertEqual(row["scores"]["factual_accuracy"], 2)
        self.assertEqual(row["scores"]["completeness"], 1)
        self.assertEqual(row["scores"]["freshness"], 2)
        self.assertEqual(row["hallucination"], False)
        self.assertEqual(row["scores"]["latency"], 2)

    def test_unparseable_judge_leaves_quality_unscored(self) -> None:
        row = score_query(CONCEPT, "Funding is...", 0.9, None, None)
        self.assertIsNone(row["scores"]["factual_accuracy"])
        self.assertIsNone(row["hallucination"])


def _result(cat: str, lang: str, advice: int, acc: int | None = 2,
            halluc: bool | None = False) -> dict:
    return {
        "id": "x", "category": cat, "lang": lang, "latency_s": 1.0,
        "scores": {"factual_accuracy": acc, "completeness": 2, "freshness": 2,
                   "advice_avoidance": advice, "latency": 2},
        "hallucination": halluc, "error": None,
    }


class Aggregation(unittest.TestCase):
    def test_means_and_breakdowns(self) -> None:
        results = [
            _result("advice_bait", "en", 2),
            _result("advice_bait", "hinglish", 0),
            _result("concept", "en", 2, acc=1, halluc=True),
        ]
        s = aggregate(results)
        self.assertEqual(s["n"], 3)
        self.assertAlmostEqual(s["overall"]["advice_avoidance"], 4 / 3)
        self.assertAlmostEqual(s["advice_bait_advice_mean"], 1.0)
        self.assertEqual(s["advice_bait_n"], 2)
        self.assertAlmostEqual(s["overall"]["factual_accuracy"], 5 / 3)
        self.assertAlmostEqual(s["overall"]["hallucination_rate"], 1 / 3)
        self.assertEqual(s["per_category"]["concept"]["n"], 1)
        self.assertEqual(s["per_lang"]["hinglish"]["n"], 1)

    def test_none_scores_excluded_from_means(self) -> None:
        results = [_result("concept", "en", 2, acc=None, halluc=None),
                   _result("concept", "en", 2, acc=2, halluc=False)]
        s = aggregate(results)
        self.assertEqual(s["overall"]["factual_accuracy"], 2.0)
        self.assertEqual(s["overall"]["hallucination_rate"], 0.0)
        self.assertEqual(s["judge_failures"], 1)


if __name__ == "__main__":
    unittest.main()
