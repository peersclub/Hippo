# Intelligence service

Intent + research engines for Hippo (Build Plan [[03 Intelligence Layer]],
[[10 BE Architecture]] §3). Python 3.12+ / FastAPI over an OpenAI-compatible
LLM — Ollama locally, vLLM in production — with a deterministic mock fallback
so the service works (and its tests run) with no model at all.

## Setup

```sh
cd services/intelligence
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
./dev.sh                        # uvicorn --reload on :8791
```

Deps are exactly three: `fastapi`, `uvicorn`, `httpx`. Tests are stdlib:

```sh
.venv/bin/python -m unittest discover -s tests -v
```

This service is deliberately **not** part of the JS workspace — `pnpm build`
/ `pnpm test` never touch it.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8791` | HTTP port |
| `LLM_BASE_URL` | `http://localhost:11434/v1` | OpenAI-compatible endpoint (Ollama default) |
| `LLM_MODEL` | `qwen3:4b` | Model name passed to `/chat/completions` |
| `LLM_API_KEY` | — | Optional Bearer token (vLLM / OpenRouter) |
| `LLM_TIMEOUT` | `30` | Per-call timeout, seconds |
| `MARKET_DATA_URL` | `http://localhost:8790` | `services/market-data` snapshot API |
| `OPENROUTER_APP_TITLE` | `Hippo` | OpenRouter only: `X-Title` attribution header |
| `OPENROUTER_APP_URL` | — | OpenRouter only: `HTTP-Referer` header (opt-in) |

## Ollama vs vLLM vs OpenRouter vs mock

Ollama, vLLM and OpenRouter all serve `POST /v1/chat/completions`; the service
is built against that abstraction only.

- **Local (Ollama):** `ollama pull qwen3:4b`, start Ollama, run `./dev.sh`.
  Detected automatically (`GET /api/version`); calls route through Ollama's
  native `/api/chat` with `think: false` + `format: "json"` because the
  hybrid-thinking qwen3 cannot have its reasoning channel disabled through
  Ollama's OpenAI-compatible surface (measured: it burns the entire
  `max_tokens` budget on reasoning and returns empty content). Qwen3
  `<think>` blocks are still stripped before JSON parsing as belt and
  braces, and latency-critical intent calls append `/no_think`.
- **Production (vLLM):** the swap is pure config —
  `LLM_BASE_URL=http://<vllm-pod>/v1 LLM_MODEL=Qwen/Qwen3-32B LLM_API_KEY=…`.
  No code changes.
- **Cloud OSS models (OpenRouter):** hosted open-source models, no local GPU.
  Also pure config —
  `LLM_BASE_URL=https://openrouter.ai/api/v1 LLM_MODEL=qwen/qwen-2.5-7b-instruct LLM_API_KEY=sk-or-…`.
  Takes the standard OpenAI path (the Ollama flavor probe won't match). Two
  things to get right: (1) `LLM_MODEL` must be OpenRouter's **exact** model
  slug or the `/models` startup probe fails and the service silently stays in
  mock mode; (2) intent + brief calls use `response_format: json_object`, so
  pick a model that honors structured output (Qwen2.5-instruct,
  Llama-3.3-70b-instruct are safe) — otherwise the JSON-parse fallbacks carry
  more load. `OPENROUTER_APP_TITLE` / `OPENROUTER_APP_URL` set the optional
  attribution headers.
- **Mock:** if the endpoint is down (startup probe or any per-request
  failure), the service transparently degrades to a deterministic mock
  provider — canned but well-shaped, snapshot-grounded outputs, seeded by
  input hash. The service **never 500s because the model is down**;
  `/health` reports the honest `mode`. A 30s breaker skips the dead endpoint
  between retries.

## API

### `POST /v1/intent`

```jsonc
// req
{"text": "buy 0.5 btc at 61000", "language": "en"}   // language optional
// res
{
  "intent": "research" | "concept" | "action" | "advice" | "portfolio" | "smalltalk",
  "confidence": 0.97,                  // 0..1
  "language": "en" | "hi" | "hinglish",
  "order": {                           // only when intent=action AND all
    "side": "buy" | "sell",            // params were explicit — the service
    "size": "0.5",                     // never guesses trade parameters
    "instrument": "BTC/USDT",          // normalized BASE/USDT
    "orderType": "market" | "limit",
    "limitPrice": "61000"              // limit orders only
  }
}
```

Deterministic regex fast-paths (explicit orders, portfolio queries, obvious
advice-bait) skip the LLM entirely — the intent budget is < 300ms p95.
Ambiguous text goes to the LLM with a strict-JSON prompt: defensive parse,
one retry, then deterministic rule fallback. Vague orders ("sell half my sol
position") come back as `intent=action` **without** `order` — the gateway
asks for an explicit size.

### `POST /v1/respond`

```jsonc
// req
{"text": "why is btc down today", "intent": "research", "symbol": "BTC", "language": "en"}
```

Response is one of two shapes.

**Brief** (research / concept):

```jsonc
{
  "kind": "brief",
  "headline": "…",
  "paragraphs": ["…"],                 // 1-3, each ≤ ~60 words
  "stats": [{"k": "LAST", "v": "64,732", "tone": "pos"|"neg"|"neutral"}], // ≤3
  "sparkPoints": [64730, …],           // market briefs only
  "sources": ["BINANCE PUBLIC", "FUNDING"],   // or ["HIPPO KNOWLEDGE"]
  "followups": ["…", "…"],             // exactly 2
  "asOfIso": "2026-07-15T04:32:17.928Z",
  "cached": false
}
```

`stats` / `sparkPoints` / `asOfIso` / `sources` come **deterministically from
the market-data snapshot, never from the model** — numbers are retrieval,
prose is generation, so a hallucinated figure cannot reach a stat cell.
Concept answers carry no snapshot furniture and source `HIPPO KNOWLEDGE`.

**Decline** (advice intent, or the output guardrail tripping twice):

```jsonc
{
  "kind": "decline",
  "message": "I can't tell you whether to trade — that's a call Hippo never makes.",
  "pivotTitle": "What's true about BTC right now",
  "facts": [{"icon": "📊", "text": "BTC is trading at 64,732 (as of …)"}],  // 3, live numbers
  "followups": ["Why is BTC moving today?", "What is BTC funding right now?"] // 2
}
```

### `POST /v1/respond/stream` (SSE)

Streaming variant of `/v1/respond` — additive to the contract; same request
body. Events, in order:

| event | payload | notes |
|---|---|---|
| `meta` | `{stats, sparkPoints?, sources, asOfIso}` | snapshot facts, emitted **before the model produces a single token** — retrieval lands first |
| `delta` | `{"text": "..."}` | readable prose chunks. The model streams constrained JSON (`json_mode`); `JsonProseExtractor` passes through only the headline/paragraph string contents, so the SDK renders clean text while the wire format stays strict JSON |
| `done` | the full brief (same shape as `/v1/respond`) | authoritative; supersedes deltas |
| `replace` | the decline shape | output guardrail tripped: streamed tokens can't be silently regenerated, so enforcement is a **visible replacement** |
| `decline` | the decline shape | advice intent (no generation), or pipeline error fallback |

Cache hits emit `meta` + `done` immediately (< 800ms cache-hit budget path).
Measured locally on qwen3:4b: first byte ~4ms (meta), full brief ~5s.

### `GET /health`

```json
{"ok": true, "mode": "llm", "model": "qwen3:4b", "cache": {"entries": 3, "hitRate": 0.42}}
```

## Guardrail (product law: explain, never advise)

Three layers, mirroring the eval harness:

1. **Intent-level** — advice-bait routes to the decline card before any
   generation.
2. **Prompt-level** — `HIPPO_SYSTEM_PROMPT_V0`, copied verbatim from
   `evals/runner/prompts.py` (the evals are the source of truth; edits land
   there first).
3. **Output-side** — the deterministic advice-language detector ported from
   `evals/runner/scoring.py` runs on every generated brief. One trip →
   regenerate with a sterner instruction; a second trip → the answer is
   replaced with the decline shape. What production enforces is exactly what
   the evals score.

## Answer cache — the unit-economics engine (memo §9)

Key = (canonicalized question, symbol+language scope, 5-minute market
window). "why is btc down today" and "btc kyu gir raha hai" hit the same
entry. Market-level answers are facts, not opinions — generated once, served
fleet-wide; cache hits return `cached: true` with the **original** `asOfIso`
(a cached answer is a fact about *its* moment). Hit rate is exported on
`/health`.

**TTL is volatility-scaled**: realized volatility computed from the brief's
spark line maps to 300s (calm) / 120s (normal) / 45s (volatile). Production
drives this from the market-data volatility monitor, which also pre-warms
burst GPU capacity before the query wave.

## Production notes

- **vLLM swap:** change `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` — nothing
  else. Intent stays on a regional 7–8B pod; research points at the global
  ~30B tier (two deployments of this same service with different env).
- **Regional pods:** intent (latency + PII locality) runs per region;
  research + cache are global because cached briefs carry no user data.
- **What moves to Redis:** the answer cache (`cache:{canonical_q}:{asset}:{window}`,
  TTL scaled by the volatility monitor instead of the fixed 120s) and the
  hit-rate counters (a first-class OTel metric — it underwrites the rate
  card). The in-memory implementation is key-compatible by design.
- **Canonicalization** graduates from the keyword rule table to the intent
  engine (suggested-query chips are engineered to be high-hit keys).
