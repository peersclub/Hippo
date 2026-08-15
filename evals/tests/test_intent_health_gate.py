"""Regression: the harness must refuse to grade a degraded backend.

A run against a credit-exhausted OpenRouter key once silently graded the MOCK
fallback and printed 68.3% — byte-identical to the offline run. Any run with
--intent-endpoint now probes the target's /health first and exits non-zero
unless it reports llm == "live"; a passing run stamps providerMode + model
into the report header.
"""
from __future__ import annotations

import contextlib
import http.server
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from evals.runner.run import main  # noqa: E402


class _StubIntelligence(http.server.BaseHTTPRequestHandler):
    """Minimal intelligence-service double: /health + /v1/intent."""

    health: dict = {}

    def _send(self, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/health":
            self._send(type(self).health)
        else:
            self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/v1/intent":
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            self._send({"intent": "unsupported", "confidence": 0.5})
        else:
            self.send_error(404)

    def log_message(self, *args: object) -> None:  # silence test output
        pass


class IntentHealthGate(unittest.TestCase):
    server: http.server.HTTPServer

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = http.server.HTTPServer(("127.0.0.1", 0), _StubIntelligence)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def run_intent(self, health: dict) -> tuple[int, str, Path]:
        _StubIntelligence.health = health
        out = Path(tempfile.mkdtemp(prefix="hippo-eval-health-gate-"))
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            rc = main([
                "--mode", "intent", "--intent-endpoint", self.endpoint,
                "--limit", "3", "--out", str(out),
            ])
        return rc, stderr.getvalue(), out

    def test_mock_backend_exits_nonzero_and_writes_nothing(self) -> None:
        rc, err, out = self.run_intent(
            {"ok": True, "llm": "mock", "providerMode": "mock", "model": "mock",
             "sha": "abc1234"}
        )
        self.assertNotEqual(rc, 0)
        self.assertIn("REFUSING TO GRADE", err)
        self.assertIn("llm='mock'", err)
        self.assertEqual(list(out.iterdir()), [])  # no report to mistake for a result

    def test_missing_llm_field_is_treated_as_degraded(self) -> None:
        # An old deployment without the field cannot prove it is live.
        rc, err, _ = self.run_intent({"ok": True, "mode": "llm"})
        self.assertNotEqual(rc, 0)
        self.assertIn("REFUSING TO GRADE", err)

    def test_live_backend_runs_and_stamps_provider(self) -> None:
        rc, _, out = self.run_intent(
            {"ok": True, "llm": "live", "providerMode": "live",
             "model": "anthropic/claude-haiku-4.5", "sha": "abc1234"}
        )
        self.assertEqual(rc, 0)
        report_dir = next(out.iterdir())
        summary = json.loads((report_dir / "intent-summary.json").read_text("utf-8"))
        self.assertEqual(summary["provider"], {
            "providerMode": "live",
            "model": "anthropic/claude-haiku-4.5",
            "sha": "abc1234",
        })
        md = (report_dir / "intent-summary.md").read_text("utf-8")
        self.assertIn("providerMode=live", md)
        self.assertIn("anthropic/claude-haiku-4.5", md)


if __name__ == "__main__":
    unittest.main()
