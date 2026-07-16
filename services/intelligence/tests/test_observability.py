"""OpenTelemetry instrumentation (C2). In-memory metric + span readers — no
collector. Asserts the four rate-card instruments emit with the right names and
attributes when the service code paths run, plus the intent span.
"""
from __future__ import annotations

import unittest
from typing import Any
from unittest.mock import patch

from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import main
import research
from cache import AnswerCache
from main import IntentRequest, RespondRequest
from tests.test_research import fake_snapshot, offline_router

_READER = InMemoryMetricReader()
_SPANS = InMemorySpanExporter()


def setUpModule() -> None:
    # set_meter_provider / set_tracer_provider are one-shot per process; no
    # other test module registers a provider, so this wins. The proxy
    # instruments in observability.py start routing here immediately.
    metrics.set_meter_provider(MeterProvider(metric_readers=[_READER]))
    tp = TracerProvider()
    tp.add_span_processor(SimpleSpanProcessor(_SPANS))
    trace.set_tracer_provider(tp)


def points_by_metric() -> dict[str, list[Any]]:
    data = _READER.get_metrics_data()
    out: dict[str, list[Any]] = {}
    for rm in data.resource_metrics:
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                out.setdefault(metric.name, []).extend(metric.data.data_points)
    return out


class Instruments(unittest.IsolatedAsyncioTestCase):
    async def test_intent_duration_and_span(self) -> None:
        with patch.object(main, "router", offline_router()):
            result = await main.classify_intent(IntentRequest(text="why is btc down"))
        self.assertIn("intent", result)

        pts = points_by_metric()
        self.assertIn("hippo.intent.classification.duration", pts)
        self.assertTrue(
            any("intent" in p.attributes for p in pts["hippo.intent.classification.duration"])
        )

        span_names = [s.name for s in _SPANS.get_finished_spans()]
        self.assertIn("hippo.intent.classify", span_names)

    async def test_first_token_duration(self) -> None:
        with (
            patch.object(main, "router", offline_router()),
            patch.object(main, "answer_cache", AnswerCache()),
            patch.object(research, "fetch_snapshot", fake_snapshot),
        ):
            resp = await main.respond_stream(
                RespondRequest(text="why is btc down", intent="research")
            )
            chunks = [chunk async for chunk in resp.body_iterator]
        self.assertTrue(any("done" in c or "delta" in c for c in chunks))

        pts = points_by_metric()
        self.assertIn("hippo.first_token.duration", pts)
        self.assertTrue(
            any(p.attributes.get("intent") == "research" for p in pts["hippo.first_token.duration"])
        )

    async def test_cache_hit_rate_counter(self) -> None:
        cache = AnswerCache()
        t0 = 1_000_000_000.0
        cache.set("why is btc down", "BTC", {"kind": "brief"}, now=t0)
        cache.get("why is btc down", "BTC", now=t0 + 1)  # hit
        cache.get("totally unrelated", "BTC", now=t0 + 1)  # miss

        pts = points_by_metric()
        self.assertIn("hippo.answer_cache.requests", pts)
        results = {p.attributes.get("result") for p in pts["hippo.answer_cache.requests"]}
        self.assertIn("hit", results)
        self.assertIn("miss", results)

    async def test_advice_decline_counter(self) -> None:
        await research.respond("should i buy btc?", "advice", offline_router(), AnswerCache())

        pts = points_by_metric()
        self.assertIn("hippo.advice.turns", pts)
        outcomes = {p.attributes.get("outcome") for p in pts["hippo.advice.turns"]}
        self.assertIn("declined", outcomes)


if __name__ == "__main__":
    unittest.main()
