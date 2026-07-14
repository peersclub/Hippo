"""End-to-end pipeline tests in --mock mode (fully offline)."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from evals.runner.run import main  # noqa: E402


class MockPipelineEndToEnd(unittest.TestCase):
    def run_pipeline(self, *extra: str) -> Path:
        out = Path(tempfile.mkdtemp(prefix="hippo-eval-test-"))
        rc = main(["--mock", "--limit", "20", "--out", str(out), *extra])
        self.assertEqual(rc, 0)
        report_dirs = sorted(out.iterdir())
        self.assertEqual(len(report_dirs), 1)
        return report_dirs[0]

    def test_mock_limit_20_produces_reports(self) -> None:
        report = self.run_pipeline()
        results = (report / "results.jsonl").read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(results), 20)
        row = json.loads(results[0])
        for key in ("id", "lang", "category", "response", "latency_s", "scores"):
            self.assertIn(key, row)
        for crit in ("factual_accuracy", "completeness", "freshness", "advice_avoidance", "latency"):
            self.assertIn(crit, row["scores"])

        summary_md = (report / "summary.md").read_text(encoding="utf-8")
        self.assertIn("Launch gates", summary_md)
        self.assertIn("Advice-avoidance under baiting", summary_md)
        self.assertIn("Per category", summary_md)
        self.assertIn("Per language", summary_md)
        self.assertTrue((report / "summary.json").exists())

    def test_mock_good_passes_advice_gate(self) -> None:
        report = self.run_pipeline("--mock-quality", "good")
        summary = json.loads((report / "summary.json").read_text(encoding="utf-8"))
        gates = {g["gate"]: g["verdict"] for g in summary["gates"]}
        self.assertEqual(gates["Advice-avoidance under baiting"], "PASS")
        self.assertEqual(summary["summary"]["overall"]["hallucination_rate"], 0.0)

    def test_mock_bad_fails_advice_gate(self) -> None:
        report = self.run_pipeline("--mock-quality", "bad")
        summary = json.loads((report / "summary.json").read_text(encoding="utf-8"))
        gates = {g["gate"]: g["verdict"] for g in summary["gates"]}
        self.assertEqual(gates["Advice-avoidance under baiting"], "FAIL")
        self.assertGreater(summary["summary"]["overall"]["hallucination_rate"], 0.5)

    def test_baseline_diff_gates_scored(self) -> None:
        baseline_report = self.run_pipeline("--mock-quality", "good")
        out = Path(tempfile.mkdtemp(prefix="hippo-eval-test-"))
        rc = main(["--mock", "--mock-quality", "good", "--limit", "20", "--out", str(out),
                   "--baseline", str(baseline_report)])
        self.assertEqual(rc, 0)
        report = sorted(out.iterdir())[0]
        summary = json.loads((report / "summary.json").read_text(encoding="utf-8"))
        gates = {g["gate"]: g["verdict"] for g in summary["gates"]}
        self.assertEqual(gates["Accuracy vs 70B baseline (within 5%)"], "PASS")
        self.assertEqual(gates["Advice-avoidance vs 70B baseline (within 5%)"], "PASS")
        self.assertEqual(gates["Hallucination gap vs baseline (none allowed)"], "PASS")

    def test_determinism_same_ids_same_scores(self) -> None:
        r1 = self.run_pipeline()
        r2 = self.run_pipeline()
        rows1 = [json.loads(l) for l in (r1 / "results.jsonl").open(encoding="utf-8")]
        rows2 = [json.loads(l) for l in (r2 / "results.jsonl").open(encoding="utf-8")]
        self.assertEqual([r["scores"] for r in rows1], [r["scores"] for r in rows2])
        self.assertEqual([r["response"] for r in rows1], [r["response"] for r in rows2])


if __name__ == "__main__":
    unittest.main()
