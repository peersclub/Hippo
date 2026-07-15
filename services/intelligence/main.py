"""Hippo intelligence service — intent + research engines over an
OpenAI-compatible LLM (Ollama locally, vLLM in production) with a
deterministic mock fallback. See README.md for the API contract.

Run: ./dev.sh   (or .venv/bin/uvicorn main:app --port 8791)
"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Literal

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import intent as intent_engine
import research
from cache import AnswerCache
from providers import ProviderRouter

log = logging.getLogger("intelligence")

router = ProviderRouter()
answer_cache = AnswerCache()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
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


@app.post("/v1/intent")
async def classify_intent(req: IntentRequest) -> dict[str, Any]:
    # Never 500 because a model is down: classify() falls back to the mock
    # provider and then to deterministic rules.
    try:
        return await intent_engine.classify(req.text, router, req.language)
    except Exception:  # last-ditch: deterministic rules never raise
        log.exception("intent pipeline error; serving rule classification")
        return intent_engine.rule_classify(req.text)


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
            experience_level=req.persona.experienceLevel if req.persona else None,
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
        try:
            async for ev in research.respond_stream(
                req.text,
                req.intent,
                router,
                answer_cache,
                symbol=req.symbol,
                language=req.language,
                experience_level=req.persona.experienceLevel if req.persona else None,
            ):
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
