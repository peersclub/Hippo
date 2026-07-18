# Hippo — Build Plan Overview

**Status:** Draft v1 · July 14, 2026
**Sources of truth:** [[Hippo Strategy Memo (Master)]] (business, pricing, AI stack, contracts) · [[Thin Client Frontend Baseline]] (front-end design & behavior) · `Reference/prototype-index.html` (living spec, deployed at https://project-iducy.vercel.app/)

---

## The one-paragraph brief

Hippo is a conversational trading agent that embeds into partner exchanges as a **thin client** — a lightweight SDK that renders a chat surface and a server-driven card vocabulary — while everything intelligent (intent engine, research models, caching, evals, memory) runs on Hippo infrastructure. Orders execute on the partner's rails (Approach A: Hippo prepares, partner confirms). The two build-side differentiators beyond the memo:

1. **A parasite that never harms the host.** The embed must attach to *any* website with one script tag — Shadow-DOM-isolated, zero host dependencies, unable to break or slow the host page — while maintaining a *deep* product connection: it understands the user (memory, positions, context) and places orders from inside the conversation.
2. **Agentic, CLI-based installation.** Integration is not a manual SI project. `hippo init` is an agent that runs against the partner's site and API surface, understands both, and *generates* the integration: the partner adapter, the embed config, the theming, and the verification suite. "Weeks, not quarters" becomes "days, mostly automated."

## Workstreams (six, each with its own doc)

| # | Workstream | Doc | Lead |
|---|-----------|-----|------|
| 1 | System architecture & protocol | [[01 System Architecture]] | Victor |
| 2 | Thin client SDK | [[02 Thin Client SDK]] | Victor |
| 3 | Intelligence layer (intent, research, cache, memory) | [[03 Intelligence Layer]] | Victor + Sudha |
| 4 | Execution seam & partner adapter | [[04 Execution Seam & Partner Adapter]] | Victor (+ Suresh decision) |
| 5 | Agentic installer — Hippo CLI | [[05 Agentic Installer — Hippo CLI]] | Victor |
| 6 | Eval harness & data | [[06 Eval Harness & Data]] | Sudha |
| 7 | Infrastructure & regional pods | [[07 Infrastructure & Pods]] | Kartik (quotes) + eng |

**Dev-kickoff docs (July 14, 2026):** [[08 PRD v1]] · [[09 FE Architecture]] · [[10 BE Architecture]] — tech stack locked (Preact SDK, Fastify gateway, Zod protocol, vLLM/Qwen3.6 serving, CCXT dev data). Monorepo scaffold: `/Users/Victor/Projects22/hippo/hippo-app/`.

## Phasing

**Phase 0 — Foundations (Weeks 1–2)** — ✅ done
- Monorepo scaffold (`hippo`): `packages/sdk`, `packages/protocol`, `services/gateway`, `services/intelligence`, `services/adapters`, `tools/cli`, `evals/`.
- **Card protocol v1 spec** — freeze the JSON schema for the card vocabulary already designed in the prototype (research brief, live-bar, order ticket, lifecycle set, advice-decline, positions, rejection, thinking, skeleton). This schema is the contract everything else builds against.
- Model bake-off spec final + eval harness v1 (already a named workstream in the memo — Victor + Sudha, ~2 weeks). 300 queries, ≥25% Hinglish, adversarial advice-baiting.
- Extract design tokens from the prototype into the SDK theme layer.
- *Shipped:* `packages/protocol` (Zod schemas, `frames.ts`/`uplinks.ts`, additive-only + per-frame `fallback`) · eval harness v1 (300-query set — 90 market_event/60 asset_research/60 concept/30 portfolio_context/60 advice_bait; 183 en/92 hinglish/25 hi; stdlib Python runner + launch gates) · CI (`build`/`test`/size-gate/lint on every PR).

**Phase 1 — Thin client SDK v1 (Weeks 2–6)** — ✅ done (July 16)
- Port the prototype into a production SDK: Shadow DOM embed, three postures (dock/overlay/pill on web; pill/sheet/full-screen mobile web), card renderer, onboarding flow, all six edge states, settings, localization scaffolding (EN/हिन्दी/Hinglish + RTL).
- **Mock gateway** replaying the golden conversation (the prototype script) over the real wire protocol — SDK is demo-able and testable before any model runs.
- Exit gate: SDK passes the "stop line" review (§8 of baseline) — it only draws what the server sends.
- *Shipped:* core renderer/state/transport (`cards.tsx`, `panel.tsx`, `loader.ts` two-stage loader, `state.ts`, `transport.ts`, `styles.ts`, `freshness.ts`) · onboarding hero flow + edge states · share overlay, feedback reason chips, order-pill expand, new-order hint · `services/mock-gateway` (Fastify + SSE golden-conversation player) · `apps/host-demo` fake exchange terminal · full posture matrix + tokenized themes (#12) · i18n chrome EN/हिन्दी/Hinglish + RTL groundwork (#15) · **the fold release (`629251b`)** — contextual followup chips (tap sends / hold edits), composer v2 (multiline, drafts survive minimize, char limit), scroll anchoring + jump-to-latest, offline outbox with queued row (edge state №6 spec compliance), Esc/focus/aria fold, settings completion (answer-language switcher + clear-memory confirm), brief copy with the advice line. 108 SDK tests.
- *Remaining:* Arabic copy for the `ar` catalog (RTL layout works; strings fall back to EN — counsel/native review pending).

**Phase 2 — Intelligence backend (Weeks 4–10, overlaps Phase 1)** — 🚧 just started
- Gateway: sessions, partner auth handshake, SSE/WebSocket streaming, card orchestration.
- Intent engine (7–8B class) → research engine (bake-off winner, ~30B class) → market-data retrieval → **cache layer** (the unit-economics engine: market-level answers generated once, personalization thin per user).
- Guardrail: advice-avoidance as tested product behavior, wired to the advice-decline card.
- Memory v1: opt-in persona (experience level, followed assets, open threads).
- Exit gate: bake-off launch gates pass (within 5% of 70B baseline on accuracy + advice-avoidance, no hallucination gap).
- *Shipped:* `services/market-data` (CCXT snapshot/live pricing, fixtures + tests, wired into mock-gateway) · **`services/intelligence`** ([PR #8](https://github.com/peersclub/Hippo/pull/8), in review) — Python/FastAPI: intent engine (regex fast-paths + LLM strict-JSON, EN/हिन्दी/Hinglish), research engine (numbers-are-retrieval/prose-is-generation over live snapshots), **answer cache** (canonical question + symbol/language + 5-min window, hit rate on `/health`), output-side guardrail ported 1:1 from `evals/runner/scoring.py` (trip → regenerate → decline), providers Ollama/vLLM/mock (never 500s; vLLM swap is pure env config), 67 offline tests, live-verified on qwen3:4b · **gateway core** ([PR #7](https://github.com/peersclub/Hippo/pull/7), in review) — real sessions, SSE frame journal with resume, orchestrator + degraded fallback.
- *Not started:* memory v1 · Redis-backed cache/sessions (in-memory versions are key-compatible) · wiring gateway orchestrator → intelligence service (after PRs #7/#8 merge) · the bake-off run itself (needs GPU).

**Phase 3 — Execution seam with pilot partner (Weeks 8–12)** — ⬜ not started
- Canonical trading interface (orders/positions/balances/prepare-confirm-status) + first adapter, hand-built for the pilot (KoinBX) — this hand-built adapter becomes the CLI's codegen target.
- Approach A handoff: prepared ticket → partner confirm → status webhooks → lifecycle cards. Governing sentence: *if a trader has to leave the conversation to find out what happened to their order, the seam has failed.*
- Exit gate: full lifecycle round-trip in partner sandbox, all lifecycle cards driven by real venue events.

**Phase 4 — Agentic installer (Weeks 10–14, overlaps Phase 3)** — 🚧 started (discovery half only)
- `hippo init`: site understanding (crawl, framework detection, design extraction) + API discovery (OpenAPI ingestion, auth mapping) + adapter codegen + embed injection + verification report.
- Dogfood: regenerate the KoinBX adapter from scratch with the CLI and diff against the hand-built one. That diff is the quality metric.
- Exit gate: a second (staging/test) venue integrated end-to-end by the CLI with < 1 day of human review.
- *Shipped:* `hippo scan v0` (`tools/cli/src/scan/`) — read-only site/API discovery (CSP, robots.txt, capability detection) producing a Markdown integration report with a High/Medium/Low verdict.
- *Not started:* adapter codegen, embed injection, verification suite.

**Phase 5 — Pilot launch & instrumentation (Weeks 12–16)** — ⬜ not started
- Onboarding hero moment live; ambient market pulse; share cards.
- Sudha's pilot instrumentation: load curves, **cache hit rate** (the number that underwrites the rate card), queries/MAU distribution, true cost/MAU, lift telemetry for the fundraise.
- Degraded-mode banner demonstrable for procurement (SLA graceful-degradation clause).

## Milestones tied to the memo's validation table

| Memo workstream | Build dependency |
|---|---|
| Model bake-off (Victor + Sudha) | Phase 0 eval harness v1 |
| India + Gulf GPU quotes (Kartik) | Phase 2 capacity plan inputs |
| Feeds conversation with pilot partner (Ram) | Phase 2 market-data service (swings footprint ₹0.4–0.8L) |
| Pilot instrumentation (Sudha) | Phase 5 telemetry |

## What we deliberately do NOT build (the stop line)

Client-side charting/indicators, client-side order validation or balance math, local market-data caching, client-owned watchlist/alert logic, white-label variants, frontier-API dependence in production, decentralized GPU. Test for every request: **if the SDK does more than draw what the server sends, it's thick.**

Related: [[Open Decisions]]
