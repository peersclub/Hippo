# 10 · BE Architecture — Gateway & Core Services

**Stack (locked July 2026):** Node 24 LTS + Fastify 5 + TypeScript (gateway, seam, mock) · Python 3.12 + FastAPI + vLLM ≥ 0.11 (intelligence) · Redis (cache/sessions/streams) · Postgres (memory, telemetry, journal) · CCXT + CoinGecko (dev market data) · OpenTelemetry.
**Repo:** `hippo-app/services/*`

---

## 1. Gateway (Fastify, one per regional pod)

The only service the SDK ever talks to. Plugin layout:

```
services/gateway/src/
├── app.ts                 # fastify factory, fastify-type-provider-zod wiring
├── plugins/
│   ├── auth.ts            # partner-signed JWT verification (JWKS per partner), session mint
│   ├── sse.ts             # SSE channel: frame serialization, heartbeat, Last-Event-ID resume
│   ├── config.ts          # signed config blob endpoint (venue name, locales, panelUrl hash, flags)
│   └── telemetry.ts       # OTel + MAU-event emission (research_answered / order_executed)
├── routes/
│   ├── session.ts         # POST /v1/session  (partner JWT → hippo session)
│   ├── stream.ts          # GET  /v1/stream   (SSE: cards down)
│   ├── turns.ts           # POST /v1/turns    (user text, chip taps, confirms, feedback, consent)
│   └── health.ts
└── orchestrator/          # conversation state machine (below)
```

**Session lifecycle:** partner backend mints a short-lived JWT asserting `venue_user_id` (+ region, locale) → SDK exchanges it at `/v1/session` → gateway session (Redis, TTL-refreshed) → all turns and streams carry the session. Hippo never sees venue credentials; PII stays in the regional pod (L1).

**Frame journal:** every frame emitted to a session is appended to a Redis Stream (`session:{id}:frames`) — SSE resume replays from `Last-Event-ID`, and lifecycle events that arrive while the trader is disconnected backfill on reconnect. This is the mechanism behind "status changes made elsewhere still arrive in the thread."

## 2. Orchestrator — the card state machine

Per turn: validate uplink (Zod) → route:

```
turn ──► intent svc (small model)
  ├─ research  ──► cache key canonicalize ──► Redis cache ──► HIT: personalize → frames
  │                                     └──► MISS: research svc (stream deltas) → cache set
  ├─ action    ──► seam.prepare() → order_ticket frame → awaiting venue events
  ├─ advice    ──► advice_decline frame (facts fetched like research)
  ├─ portfolio ──► seam.positions/orders → positions frame  (never cached)
  └─ concept   ──► research svc (concept mode, experience-calibrated via memory)
```

Emits `thinking` immediately (< 150ms), `skeleton` when shape is known, then content frames. All timing decisions live here — the SDK only draws. The orchestrator is deliberately a plain TS state machine, not an agent framework: routing is deterministic; only the model calls are model-driven.

## 3. Service topology

| Service | Runtime | Pod | Notes |
|---|---|---|---|
| gateway | Fastify/TS | regional | sessions, SSE, orchestration |
| intent | Python/FastAPI → vLLM 7–8B | regional | classify + order param extraction + memory writes; < 300ms p95 |
| research | Python/FastAPI → vLLM ~30B (Qwen3.6-35B-A3B primary) | **global** | grounded generation over market-data retrieval; token streaming |
| market-data | TS (Fastify) | global | CCXT public feeds + CoinGecko dev tier; normalized snapshot API + as-of stamps; recorded-fixture mode for tests |
| memory | TS | regional | opt-in persona (Postgres); experience level, followed assets, threads; clear-all endpoint |
| seam | TS | regional | Canonical Trading Interface; per-venue adapter loaded by config; webhook receiver + poll reconciler ([[04 Execution Seam & Partner Adapter]]) |
| eval-runner | Python | global | harness CI + continuous adversarial probing ([[06 Eval Harness & Data]]) |

Interservice: HTTP + JSON validated against `@hippo/protocol`'s exported JSON Schemas (the Zod source of truth compiles to both TS types and JSON Schema for Python).

## 4. Data model

**Redis:** sessions · answer cache (`cache:{canonical_q}:{asset}:{window}` → frames + as-of, TTL scaled by volatility) · frame journals (Streams) · rate limits.
**Postgres:** `users_memory` (opt-in persona, per partner, in-region) · `orders_shadow` (prepared refs ↔ venue order IDs, lifecycle audit) · `telemetry_events` (MAU events, feedback labels → L2 export pipeline) · `partners` (config blobs, JWKS, adapter refs).
**L2 export:** nightly anonymization job (drop identifiers, k-anonymity check) → conversation corpus store (global) feeding evals. Un-linkable to PII by construction.

## 5. Cache design (the unit-economics engine)

- Intent service canonicalizes phrasing → cache key; suggested chips are engineered to be high-hit keys.
- Market-level briefs cached fleet-wide; personalization (name, position context, depth) applied per user at serve time from a template + slots — the cached artifact carries no user data, so the cache tier is global.
- Volatility monitor (threshold rules on market-data service) does two things: shrinks TTLs and **pre-warms burst GPU capacity** before the query wave.
- Degraded mode: gateway serves cache with `cached: true, age` → SDK shows labeled CACHED BRIEF badge; intent + order flow stay live (the contractual graceful-degradation behavior).
- **Cache hit rate is a first-class OTel metric** — it underwrites the rate card.

## 6. Mock gateway (dev/demo/CI — ships in scaffold)

Same Fastify skeleton, same routes, same protocol — but the orchestrator is a **golden-conversation player**: scripted frame sequences (extracted from the prototype: research brief → order ticket → advice decline, plus lifecycle and edge-state scripts) with realistic timing. Powers SDK dev, Playwright visual regression, and partner demos without GPUs. Fixture-driven: `golden/*.json` are protocol-valid frame scripts validated in CI against the schemas.

## 7. Observability & ops

- OTel traces gateway → intent → research with turn-level spans; metrics: intent p95, first-token p95, cache hit rate, fleet utilization (the 60–75% KPI), advice-decline rate, MAU events.
- Structured audit log on the seam: every prepare/confirm/venue-event with idempotency keys.
- Local dev: `docker-compose` (redis, postgres, mock market-data fixtures); services via turbo `dev` pipeline. GPU-backed services stub to fixture responses locally.
- Deploy target (pilot): certified GPU cloud, India region — k8s manifests deferred to Phase 2/3; nothing in the code assumes a specific cloud.

Related: [[08 PRD v1]] · [[09 FE Architecture]] · [[01 System Architecture]] · [[03 Intelligence Layer]] · [[07 Infrastructure & Pods]]
