"""End-to-end --mode intent tests against the real deterministic classifier.

Fully offline: the backend imports `rule_classify` out of
services/intelligence/intent.py by path, so these tests need no server, no
model, and no pip install.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from evals.runner.intent_backends import OfflineRuleClassifier  # noqa: E402
from evals.runner.run import main  # noqa: E402

SERVICE_DIR = REPO_ROOT / "services" / "intelligence"
INTENT_QUERIES = REPO_ROOT / "evals" / "queries" / "v1-intents.jsonl"


class OfflineBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.backend = OfflineRuleClassifier(SERVICE_DIR)

    def test_name_says_what_was_graded(self) -> None:
        self.assertIn("rule_classify", self.backend.name)
        self.assertIn("intent.py", self.backend.name)

    def test_classifies_an_explicit_order(self) -> None:
        result, latency = self.backend.classify("buy 0.5 btc")
        self.assertEqual(result["intent"], "action")
        self.assertEqual(result["order"]["instrument"], "BTC/USDT")
        self.assertGreaterEqual(latency, 0.0)

    def test_classifies_each_fast_path_family(self) -> None:
        cases = {
            "tell me when BTC crosses 70k": "alert",
            "fill the ticket to buy 0.1 btc": "host_action",
            "show all my orders": "orders_query",
            "how are my positions doing?": "portfolio",
            "should I buy BTC": "advice",
            "hey": "smalltalk",
        }
        for text, expected in cases.items():
            self.assertEqual(self.backend.classify(text)[0]["intent"], expected, text)

    def test_deterministic_across_calls(self) -> None:
        a, _ = self.backend.classify("long 0.5 BTC 10x stop 60k tp 75k")
        b, _ = self.backend.classify("long 0.5 BTC 10x stop 60k tp 75k")
        self.assertEqual(a, b)


class IntentModeEndToEnd(unittest.TestCase):
    def run_intent(self, *extra: str, expect_rc: int = 0) -> Path:
        out = Path(tempfile.mkdtemp(prefix="hippo-intent-test-"))
        rc = main(["--mode", "intent", "--limit", "40", "--out", str(out), *extra])
        self.assertEqual(rc, expect_rc)
        report_dirs = sorted(out.iterdir())
        self.assertEqual(len(report_dirs), 1)
        return report_dirs[0]

    def test_writes_results_and_both_summaries(self) -> None:
        report = self.run_intent()
        results = (report / "intent-results.jsonl").read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(results), 40)
        row = json.loads(results[0])
        for key in ("id", "lang", "category", "text", "expected_intent",
                    "predicted_intent", "correct", "payloads"):
            self.assertIn(key, row)

        summary_md = (report / "intent-summary.md").read_text(encoding="utf-8")
        self.assertIn("Confusion matrix", summary_md)
        self.assertIn("Per-intent precision / recall / F1", summary_md)
        self.assertIn("Per language", summary_md)
        self.assertIn("Worst confusions", summary_md)
        self.assertIn("rule_classify", summary_md)  # the backend is named in the report

        summary = json.loads((report / "intent-summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["summary"]["n"], 40)
        self.assertIn("confusion", summary["summary"])

    def test_fail_under_gate_exits_nonzero(self) -> None:
        self.run_intent("--fail-under", "1.0", expect_rc=1)

    def test_fail_under_gate_passes_when_met(self) -> None:
        self.run_intent("--fail-under", "0.0", expect_rc=0)

    def test_answer_mode_is_still_the_default(self) -> None:
        """--mode answer must stay byte-identical: no query set, no intent files."""
        out = Path(tempfile.mkdtemp(prefix="hippo-intent-test-"))
        rc = main(["--mock", "--limit", "5", "--out", str(out)])
        self.assertEqual(rc, 0)
        report = sorted(out.iterdir())[0]
        self.assertTrue((report / "summary.md").exists())
        self.assertFalse((report / "intent-summary.md").exists())

    def test_unlabeled_set_is_refused(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="hippo-intent-test-"))
        queries = tmp / "unlabeled.jsonl"
        queries.write_text(
            json.dumps({"id": "q001", "lang": "en", "category": "concept",
                        "text": "what is a limit order"}) + "\n",
            encoding="utf-8",
        )
        rc = main(["--mode", "intent", "--queries", str(queries), "--out", str(tmp / "out")])
        self.assertEqual(rc, 2)


class ShippedIntentSetTests(unittest.TestCase):
    """The set must keep exercising the parsers it was built to exercise."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.rows = [json.loads(l) for l in INTENT_QUERIES.read_text(encoding="utf-8").splitlines() if l.strip()]

    def test_every_intent_is_covered(self) -> None:
        from evals.runner.intent_scoring import INTENTS
        covered = {r["expected_intent"] for r in self.rows}
        self.assertEqual(covered, set(INTENTS))

    def test_all_six_host_verbs_are_covered(self) -> None:
        verbs = {r["expected_host_action"]["action"]
                 for r in self.rows if "expected_host_action" in r}
        self.assertEqual(verbs, {"set_timeframe", "apply_indicator", "remove_indicator",
                                 "navigate", "set_symbol", "prefill_ticket"})

    def test_language_mix_mirrors_v1(self) -> None:
        n = len(self.rows)
        share = {lang: sum(1 for r in self.rows if r["lang"] == lang) / n
                 for lang in ("en", "hinglish", "hi")}
        self.assertGreaterEqual(share["hinglish"], 0.25)
        self.assertGreaterEqual(share["hi"], 0.08)
        self.assertLessEqual(share["en"], 0.70)

    def test_the_named_adversarial_pairs_are_present(self) -> None:
        texts = {r["text"] for r in self.rows}
        pairs = {
            "fill the ticket to buy 0.1 btc": "host_action",
            "buy 0.1 btc": "action",
            "change my order to 0.2": "action",
            "show all my orders": "orders_query",
            "should I buy BTC": "advice",
            "what is a limit order": "concept",
        }
        by_text = {r["text"]: r["expected_intent"] for r in self.rows}
        for text, intent in pairs.items():
            self.assertIn(text, texts)
            self.assertEqual(by_text[text], intent, text)


if __name__ == "__main__":
    unittest.main()
