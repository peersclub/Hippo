"""Hippo intelligence service — intent + research engines over an
OpenAI-compatible LLM (Ollama locally, vLLM in production) with a
deterministic mock fallback. See README.md for the API contract.

Run: ./dev.sh   (or .venv/bin/uvicorn main:app --port 8791)
"""
from __future__ import annotations

import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Literal

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import extract as extract_engine
import intent as intent_engine
import research
from cache import make_answer_cache
from observability import first_token_duration, intent_duration, setup_otel, tracer
from providers import AVAILABLE_MODELS, ProviderRouter

# App loggers ("intelligence*") are otherwise unconfigured — uvicorn only
# configures its own "uvicorn.*" tree — so without this every log.info/
# log.exception in the service is dropped or lands unformatted on stderr.
# LOG_LEVEL follows the fleet-wide convention (see .env.example).
_LEVEL = os.environ.get("LOG_LEVEL", "info").upper()
logging.basicConfig(
    level=_LEVEL if _LEVEL in logging.getLevelNamesMapping() else logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

log = logging.getLogger("intelligence")

router = ProviderRouter()


class ToggleableCache:
    """Wraps the answer cache with a runtime on/off switch (test lever). When
    disabled, get() always misses and set() no-ops, so every turn is a fresh
    model call — useful for observing live answers vs cached ones in chat."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.enabled = True

    def get(self, *a: Any, **k: Any) -> Any:
        return self.inner.get(*a, **k) if self.enabled else None

    def set(self, *a: Any, **k: Any) -> Any:
        return self.inner.set(*a, **k) if self.enabled else None

    def stats(self) -> dict[str, Any]:
        return {**self.inner.stats(), "enabled": self.enabled}


# In-memory by default; Redis-backed when REDIS_URL is set (same surface).
answer_cache = ToggleableCache(make_answer_cache())

# Global persona override (test lever). When set, it wins over the per-request
# persona so the host can force new/intermediate/pro concept-answer depth.
_persona_override: str | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_otel()
    await router.startup_probe()
    log.info("intelligence up — provider mode=%s model=%s", router.mode, router.model)
    yield


app = FastAPI(title="hippo-intelligence", lifespan=lifespan)


class IntentRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    language: str | None = None


class PersonaIn(BaseModel):
    """Thin personalization slots (memo §9). Experience level calibrates
    CONCEPT-answer depth only — market briefs stay fleet-wide cacheable."""

    experienceLevel: Literal["new", "intermediate", "pro"] | None = None


class RespondRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    intent: str
    symbol: str | None = None
    # Additive: future callers pass the language detected at intent time.
    language: Literal["en", "hi", "hinglish"] | None = None
    # Additive (Memory v1): opt-in persona from the gateway's memory read.
    persona: PersonaIn | None = None
    # Additive (Memory levels): the composed layered memory block (platform →
    # venue → user → session). Context only — the guardrail stays authoritative.
    memoryContext: str | None = Field(default=None, max_length=16_000)


@app.post("/v1/intent")
async def classify_intent(req: IntentRequest) -> dict[str, Any]:
    # Never 500 because a model is down: classify() falls back to the mock
    # provider and then to deterministic rules.
    start = time.perf_counter()
    with tracer.start_as_current_span("hippo.intent.classify") as span:
        try:
            result = await intent_engine.classify(req.text, router, req.language)
        except Exception:  # last-ditch: deterministic rules never raise
            log.exception("intent pipeline error; serving rule classification")
            result = intent_engine.rule_classify(req.text)
        intent = str(result.get("intent", "unknown"))
        span.set_attribute("hippo.intent", intent)
    # Intent-p95 rate-card number.
    intent_duration.record((time.perf_counter() - start) * 1000.0, {"intent": intent})
    return result


class FactIn(BaseModel):
    """A prior durable fact (untrusted DATA). Loosely typed on input — the
    extractor re-validates everything against its own allowlist anyway."""

    type: str = Field(max_length=64)
    value: str = Field(max_length=256)
    confidence: float | None = None


class ExtractMemoryRequest(BaseModel):
    """Post-turn fact extraction (Memory auto-learn, Track 1). All fields but
    `query` are optional context; priorFacts helps avoid re-proposing knowns."""

    query: str = Field(min_length=1, max_length=4000)
    interpretation: str | None = Field(default=None, max_length=4000)
    answer: str | None = Field(default=None, max_length=16_000)
    priorFacts: list[FactIn] | None = Field(default=None, max_length=64)


@app.post("/v1/extract-memory")
async def extract_memory(req: ExtractMemoryRequest) -> dict[str, Any]:
    """Extract durable, trading-relevant facts about the user from a finished
    turn. Additive to the pinned contract and side-effect free — it returns
    facts (untrusted DATA) for the caller's memory layer to persist; it never
    changes intent/research behaviour. Never 500s: on any error or in mock
    mode it returns {"facts": []}."""
    try:
        return await extract_engine.extract(
            req.query,
            router,
            interpretation=req.interpretation,
            answer=req.answer,
            prior_facts=[f.model_dump() for f in req.priorFacts] if req.priorFacts else None,
        )
    except Exception:
        # The engine already guarantees this, but the endpoint keeps the
        # promise absolute even if request marshalling somehow raises.
        log.exception("extract-memory endpoint error; serving empty facts")
        return {"facts": []}


@app.post("/v1/respond")
async def respond(req: RespondRequest) -> dict[str, Any]:
    try:
        return await research.respond(
            req.text,
            req.intent,
            router,
            answer_cache,
            symbol=req.symbol,
            language=req.language,
            experience_level=_persona_override or (req.persona.experienceLevel if req.persona else None),
            memory_context=req.memoryContext,
        )
    except Exception:
        # Never 500: degrade to a data-free decline-shaped card rather than
        # an error the SDK can't draw.
        log.exception("respond pipeline error; serving fallback decline")
        try:
            return await research.build_decline(
                req.text, "BTC", req.language or "en", snapshot=None
            )
        except Exception:
            # build_decline fetches live facts; if even that raises (seen
            # live: httpx client creation failing on a broken CA bundle),
            # serve the zero-I/O static shape. The promise is absolute.
            log.exception("fallback decline failed; serving static decline")
            return research.static_decline("BTC", req.language or "en")


@app.post("/v1/respond/stream")
async def respond_stream(req: RespondRequest) -> StreamingResponse:
    """SSE variant of /v1/respond: meta (snapshot facts) → delta* → done,
    or replace/decline. Additive to the pinned contract — the gateway can
    adopt it for the first-token < 2s budget without breaking /v1/respond."""

    def sse(event: str, data: dict[str, Any]) -> str:
        return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    async def generate() -> AsyncIterator[str]:
        start = time.perf_counter()
        first_token_sent = False
        try:
            async for ev in research.respond_stream(
                req.text,
                req.intent,
                router,
                answer_cache,
                symbol=req.symbol,
                language=req.language,
                experience_level=_persona_override or (req.persona.experienceLevel if req.persona else None),
                memory_context=req.memoryContext,
            ):
                # First readable output (any event past the retrieval-only
                # `meta`) → the first-token-p95 rate-card number.
                if not first_token_sent and ev["event"] != "meta":
                    first_token_duration.record(
                        (time.perf_counter() - start) * 1000.0, {"intent": req.intent}
                    )
                    first_token_sent = True
                yield sse(ev["event"], ev["data"])
        except Exception:
            log.exception("respond stream error; emitting fallback decline")
            fallback = await research.build_decline(
                req.text, "BTC", req.language or "en"
            )
            yield sse("decline", fallback)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "mode": router.mode,
        "model": router.model,
        "cache": answer_cache.stats(),
    }


class ModelIn(BaseModel):
    model: str = Field(min_length=1, max_length=128)


@app.get("/admin/model")
async def get_model() -> dict[str, Any]:
    """Current LLM model + the switchable shortlist (demo/test control). The
    configured model is always offered even if it isn't in the shortlist."""
    available = list(dict.fromkeys([router.configured_model, *AVAILABLE_MODELS]))
    return {"current": router.configured_model, "mode": router.mode, "available": available}


@app.post("/admin/model")
async def set_model(req: ModelIn) -> dict[str, Any]:
    """Switch the active LLM model at runtime. The next chat turn uses it and
    the brief card reports the new model — so the change is visible in-chat."""
    router.set_model(req.model)
    return {"ok": True, "current": router.configured_model, "mode": router.mode}


@app.get("/admin/status")
async def admin_status() -> dict[str, Any]:
    """Combined engine state for the host settings page (one round trip)."""
    available = list(dict.fromkeys([router.configured_model, *AVAILABLE_MODELS]))
    return {
        "current": router.configured_model,
        "mode": router.mode,
        "available": available,
        "forceMock": router.force_mock,
        "cacheEnabled": answer_cache.enabled,
        "personaLevel": _persona_override,
    }


class ModeIn(BaseModel):
    forceMock: bool = False


@app.post("/admin/mode")
async def set_mode(req: ModeIn) -> dict[str, Any]:
    """Force the deterministic mock engine on/off (observe the degraded brief)."""
    router.force_mock = req.forceMock
    if req.forceMock:
        router.mode = "mock"
    return {"ok": True, "forceMock": router.force_mock}


class CacheIn(BaseModel):
    enabled: bool = True


@app.post("/admin/cache")
async def set_cache(req: CacheIn) -> dict[str, Any]:
    """Enable/disable the answer cache (fresh model call every turn when off)."""
    answer_cache.enabled = req.enabled
    return {"ok": True, "cacheEnabled": answer_cache.enabled}


class PersonaIn2(BaseModel):
    level: Literal["new", "intermediate", "pro"] | None = None


@app.post("/admin/persona")
async def set_persona(req: PersonaIn2) -> dict[str, Any]:
    """Force a persona experience level (calibrates concept-answer depth)."""
    global _persona_override
    _persona_override = req.level
    return {"ok": True, "personaLevel": _persona_override}
