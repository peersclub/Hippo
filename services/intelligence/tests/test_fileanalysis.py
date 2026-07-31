"""File-analysis tests: CSV digest echo + image vision fallback, mock mode.

All offline: the router is pinned to mock (no LLM endpoint is contacted), so
these pin the deterministic behaviour the demo relies on when no LLM_API_KEY
is configured — plus the endpoint contract and the output guardrail on
file-derived prose.
"""
from __future__ import annotations

import unittest
from typing import Any

import fileanalysis
from providers import ProviderRouter
from tests.test_research import offline_router

DIGEST: dict[str, Any] = {
    "columns": ["asset", "qty", "price"],
    "rowCount": 4,
    "truncated": False,
    "numericSummary": {"qty": {"count": 4, "min": 0.5, "max": 10, "sum": 13.5}},
    "assetTotals": [
        {"asset": "BTC", "rows": 2, "totalQuantity": 1.5},
        {"asset": "ETH", "rows": 1, "totalQuantity": 10},
    ],
    "sampleRows": [["BTC", "0.5", "61240"]],
}


class CsvMockModeTests(unittest.IsolatedAsyncioTestCase):
    async def test_mock_mode_echoes_the_digest_as_a_brief(self) -> None:
        out = await fileanalysis.analyze_csv("holdings.csv", DIGEST, offline_router())
        self.assertEqual(out["kind"], "brief")
        self.assertEqual(out["model"], "mock")
        self.assertEqual(out["sources"], [fileanalysis.CSV_SOURCE])
        self.assertFalse(out["cached"])
        joined = " ".join([out["headline"], *out["paragraphs"]])
        self.assertIn("holdings.csv", joined)
        self.assertIn("BTC", joined)  # per-asset totals echoed
        self.assertIn("ETH", joined)
        # Stats are deterministic digest facts, never model output.
        self.assertIn({"k": "ROWS", "v": "4", "tone": "neutral"}, out["stats"])
        self.assertIn({"k": "COLUMNS", "v": "3", "tone": "neutral"}, out["stats"])
        self.assertTrue(out["asOfIso"])
        self.assertEqual(len(out["followups"]), 2)

    async def test_empty_digest_still_briefs(self) -> None:
        out = await fileanalysis.analyze_csv("odd.csv", {}, offline_router())
        self.assertEqual(out["kind"], "brief")
        self.assertEqual(out["model"], "mock")

    async def test_advice_language_from_a_hostile_file_is_declined(self) -> None:
        # A hostile CSV can plant advisory text in the strings the digest
        # echoes (column names, asset labels). The output guardrail must
        # catch it — file content never becomes a trading call.
        hostile = {
            "columns": ["asset", "you should buy BTC now it is a great entry"],
            "rowCount": 1,
            "assetTotals": [],
        }
        out = await fileanalysis.analyze_csv("evil.csv", hostile, offline_router())
        self.assertEqual(out["kind"], "decline")
        joined = " ".join(f["text"] for f in out["facts"])
        self.assertNotIn("buy", joined.lower())


class ImageMockModeTests(unittest.IsolatedAsyncioTestCase):
    async def test_mock_mode_serves_the_canned_vision_brief(self) -> None:
        out = await fileanalysis.analyze_image(
            "chart.png", "image/png", "aGVsbG8=", offline_router()
        )
        self.assertEqual(out["kind"], "brief")
        self.assertEqual(out["model"], "mock")
        self.assertEqual(out["sources"], [fileanalysis.IMAGE_SOURCE])
        joined = " ".join([out["headline"], *out["paragraphs"]])
        self.assertIn("unavailable", joined.lower())
        self.assertIn("chart.png", joined)

    async def test_forced_mock_never_calls_the_llm(self) -> None:
        router = ProviderRouter()
        router.force_mock = True  # breaker closed, but mock is forced
        out = await fileanalysis.analyze_image(
            "chart.png", "image/png", "aGVsbG8=", router
        )
        self.assertEqual(out["model"], "mock")


class EndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        # Pin the app's router to the deterministic mock for the duration of
        # the test — a developer machine with a live local LLM must not flip
        # these assertions (the endpoint contract under test IS mock mode).
        import main

        self._was_forced = main.router.force_mock
        main.router.force_mock = True
        self.addCleanup(setattr, main.router, "force_mock", self._was_forced)

    def _client(self):  # lazy import so engine tests never need starlette
        from fastapi.testclient import TestClient

        import main

        # No lifespan (plain client): no startup probe, no model calls.
        return TestClient(main.app)

    def test_analyze_file_csv_mock(self) -> None:
        res = self._client().post(
            "/v1/analyze-file",
            json={"kind": "csv", "name": "holdings.csv", "digest": DIGEST},
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["kind"], "brief")
        self.assertEqual(body["model"], "mock")
        self.assertIn("BTC", " ".join(body["paragraphs"]))

    def test_analyze_file_image_mock(self) -> None:
        res = self._client().post(
            "/v1/analyze-file",
            json={
                "kind": "image",
                "name": "chart.png",
                "mime": "image/png",
                "dataBase64": "aGVsbG8=",
            },
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["kind"], "brief")
        self.assertEqual(body["sources"], [fileanalysis.IMAGE_SOURCE])

    def test_analyze_file_rejects_bad_kind(self) -> None:
        res = self._client().post(
            "/v1/analyze-file", json={"kind": "exe", "name": "x.exe"}
        )
        self.assertEqual(res.status_code, 422)


if __name__ == "__main__":
    unittest.main()
