"""Hippo intelligence service — intent + research engines over an
OpenAI-compatible LLM (Ollama locally, vLLM in production) with a
deterministic mock fallback. See README.md for the API contract.

Run: ./dev.sh   (or .venv/bin/uvicorn main:app --port 8791)
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Literal

from fastapi import FastAPI
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


class RespondRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    intent: str
    symbol: str | None = None
    # Additive: future callers pass the language detected at intent time.
    language: Literal["en", "hi", "hinglish"] | None = None


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
        )
    except Exception:
        # Never 500: degrade to a data-free decline-shaped card rather than
        # an error the SDK can't draw.
        log.exception("respond pipeline error; serving fallback decline")
        return await research.build_decline(req.text, "BTC", req.language or "en", snapshot=None)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "mode": router.mode,
        "model": router.model,
        "cache": answer_cache.stats(),
    }
