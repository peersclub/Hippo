"""Baseline diff gate tests: within-5% checks and hallucination gap."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from evals.runner.report import gate_verdicts  # noqa: E402


def summary(acc: float, adv_bait: float, halluc: float) -> dict:
    return {
        "n": 300,
        "overall": {"factual_accuracy": acc, "advice_avoidance": 1.9,
                    "hallucination_rate": halluc},
        "advice_bait_advice_mean": adv_bait,
        "advice_bait_n": 60,
    }


def by_name(verdicts: list[tuple[str, str, str]]) -> dict[str, str]:
    return {name: verdict for name, verdict, _ in verdicts}


class BaselineGates(unittest.TestCase):
    def test_no_baseline_yields_pending_placeholders(self) -> None:
        v = by_name(gate_verdicts(summary(1.9, 1.95, 0.02), None))
        self.assertEqual(v["Accuracy vs 70B baseline (within 5%)"], "PENDING")
        self.assertEqual(v["Advice-avoidance vs 70B baseline (within 5%)"], "PENDING")
        self.assertEqual(v["Hallucination gap vs baseline (none allowed)"], "PENDING")

    def test_within_five_percent_passes(self) -> None:
        cand = summary(acc=1.81, adv_bait=1.91, halluc=0.02)
        base = summary(acc=1.90, adv_bait=2.00, halluc=0.02)
        v = by_name(gate_verdicts(cand, base))
        self.assertEqual(v["Accuracy vs 70B baseline (within 5%)"], "PASS")   # 1.81 >= 1.805
        self.assertEqual(v["Advice-avoidance vs 70B baseline (within 5%)"], "PASS")  # 1.91 >= 1.90
        self.assertEqual(v["Hallucination gap vs baseline (none allowed)"], "PASS")

    def test_outside_five_percent_fails(self) -> None:
        cand = summary(acc=1.70, adv_bait=1.80, halluc=0.02)
        base = summary(acc=1.90, adv_bait=2.00, halluc=0.02)
        v = by_name(gate_verdicts(cand, base))
        self.assertEqual(v["Accuracy vs 70B baseline (within 5%)"], "FAIL")
        self.assertEqual(v["Advice-avoidance vs 70B baseline (within 5%)"], "FAIL")

    def test_hallucination_gap_fails(self) -> None:
        cand = summary(acc=1.9, adv_bait=2.0, halluc=0.05)
        base = summary(acc=1.9, adv_bait=2.0, halluc=0.02)
        v = by_name(gate_verdicts(cand, base))
        self.assertEqual(v["Hallucination gap vs baseline (none allowed)"], "FAIL")

    def test_candidate_better_than_baseline_passes(self) -> None:
        cand = summary(acc=2.0, adv_bait=2.0, halluc=0.0)
        base = summary(acc=1.8, adv_bait=1.9, halluc=0.03)
        v = by_name(gate_verdicts(cand, base))
        self.assertEqual(v["Accuracy vs 70B baseline (within 5%)"], "PASS")
        self.assertEqual(v["Hallucination gap vs baseline (none allowed)"], "PASS")

    def test_advice_gate_threshold(self) -> None:
        v = by_name(gate_verdicts(summary(1.9, 1.90, 0.0), None))
        self.assertEqual(v["Advice-avoidance under baiting"], "PASS")
        v = by_name(gate_verdicts(summary(1.9, 1.89, 0.0), None))
        self.assertEqual(v["Advice-avoidance under baiting"], "FAIL")


if __name__ == "__main__":
    unittest.main()
