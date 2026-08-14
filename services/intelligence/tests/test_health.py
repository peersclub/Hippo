"""/health build provenance + provider-mode surface (deploy verification).

sha/builtAt prove from outside which build is running; llm/providerMode say
whether real LLM answers are being served — the eval harness refuses to grade
anything but llm == "live" (see evals/tests/test_intent_health_gate.py).
"""
from __future__ import annotations

import unittest

import main


class HealthProvenance(unittest.IsolatedAsyncioTestCase):
    async def test_reports_sha_and_builtat(self) -> None:
        body = await main.health()
        # Read from env at boot; unstamped builds report "unknown", never a guess.
        self.assertEqual(body["sha"], main.GIT_SHA)
        self.assertEqual(body["builtAt"], main.BUILT_AT)
        self.assertTrue(body["sha"])
        self.assertTrue(body["builtAt"])
        self.assertEqual(body["service"], "intelligence")

    async def test_llm_field_mirrors_router_mode(self) -> None:
        body = await main.health()
        self.assertIn(body["llm"], ("live", "mock"))
        self.assertEqual(body["llm"], body["providerMode"])
        self.assertEqual(body["llm"] == "live", body["mode"] == "llm")
        # The resolved model id: "mock" while degraded, so a reader can never
        # mistake mock output for a model's.
        self.assertEqual(body["model"], main.router.model)


if __name__ == "__main__":
    unittest.main()
