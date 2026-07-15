"""OpenTelemetry instruments for the pilot rate-card numbers.

Instruments use the API's proxy meter/tracer (`get_meter` / `get_tracer`): they
are no-ops until a MeterProvider / TracerProvider is registered, so the offline
test suite and a bare `uvicorn` run need no collector. `setup_otel()` wires real
SDK providers when observability is enabled (HIPPO_OTEL=1 or a standard OTEL
exporter endpoint); the proxy instruments created here start routing to them
the moment a provider is set.

The four numbers the rate card depends on:
  hippo.intent.classification.duration  (histogram, ms)     → intent p95
  hippo.first_token.duration            (histogram, ms)     → first-token p95
  hippo.answer_cache.requests           (counter, {result})  → cache hit rate
  hippo.advice.turns                    (counter, {outcome}) → advice-decline rate
"""
from __future__ import annotations

import os

from opentelemetry import metrics, trace

INSTRUMENTATION_NAME = "hippo-intelligence"

_meter = metrics.get_meter(INSTRUMENTATION_NAME)
tracer = trace.get_tracer(INSTRUMENTATION_NAME)

intent_duration = _meter.create_histogram(
    "hippo.intent.classification.duration",
    unit="ms",
    description="Intent classification latency (p95 underwrites the pilot SLA)",
)
first_token_duration = _meter.create_histogram(
    "hippo.first_token.duration",
    unit="ms",
    description="Time from request start to the first streamed brief token",
)
cache_requests = _meter.create_counter(
    "hippo.answer_cache.requests",
    description="Answer-cache lookups by result — hit rate underwrites the rate card",
)
advice_turns = _meter.create_counter(
    "hippo.advice.turns",
    description="Respond turns by outcome — the advice-decline rate",
)


def record_cache(hit: bool) -> None:
    cache_requests.add(1, {"result": "hit" if hit else "miss"})


def record_respond_outcome(kind: str) -> None:
    """A respond turn resolved to a brief or a decline (advice / guardrail)."""
    advice_turns.add(1, {"outcome": "declined" if kind == "decline" else "answered"})


def setup_otel() -> None:
    """Register SDK providers when observability is enabled. Turning the proxy
    instruments above into live ones is all this does; exporters are configured
    via the standard OTEL_* env vars in production. No-op (and no collector
    needed) unless HIPPO_OTEL / an OTLP endpoint is set."""
    enabled = os.getenv("HIPPO_OTEL", "").lower() in ("1", "true", "yes")
    if not (enabled or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")):
        return
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.trace import TracerProvider

    if not isinstance(metrics.get_meter_provider(), MeterProvider):
        metrics.set_meter_provider(MeterProvider())
    if not isinstance(trace.get_tracer_provider(), TracerProvider):
        trace.set_tracer_provider(TracerProvider())
