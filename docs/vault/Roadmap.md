# 🦛 Hippo Roadmap — Done vs Pending

**As of:** July 18, 2026 · **Repo:** `peersclub/Hippo` (`hippo-app/`, main @ `b2d1990`) · Detail per phase: [[00 Build Plan Overview]]

> [!summary] Where we are
> Phase 0 ✅ done · Phase 1 (SDK) ✅ core complete (postures #12, i18n Phase 1 #15, fold release, stop control #18) · Phase 2 (intelligence backend) ✅ core + Redis stores + OTel **merged to main**; bake-off pending (GPU) · Phase 3 (execution seam) 🚧 seam + sim + KoinBX adapter **merged to main**; blocked on Open Decisions #6/#9 · Phase 4 (CLI) 🚧 scan → conform → config codegen → `embed`/`verify` (stages 5–6, #19) all landed; model-driven codegen pending · Phase 5 (pilot) ⬜ · **Ops: admin panel + durable stores + provisioning (`hippo register`) merged to main**.
> **New workstream (July 16–18): trade capabilities** — canonical order model keystone ([PR #16](https://github.com/peersclub/Hippo/pull/16), draft) + trade-type discovery ([PR #20](https://github.com/peersclub/Hippo/pull/20), draft) + seam/intelligence/SDK capability WIP in `wt-cap-*` worktrees.
> The whole conversational loop is **verified end-to-end on main**: protocol turn → gateway orchestrator → intent/research engines (Ollama qwen3:4b) → live market data → research_brief / advice_decline / order_ticket frames — including the degraded-mode banner path when the model is cold.

---

## ✅ Done (merged to main)

### Phase 0 — Foundations
- [x] Monorepo scaffold (pnpm + Turborepo): `packages/`, `services/`, `apps/`, `tools/`, `evals/`
- [x] **Card protocol v1** — `packages/protocol` Zod schemas (`frames.ts`/`uplinks.ts`), additive-only + per-frame `fallback`
- [x] **Eval harness v1** — 300-query bake-off set (≥25% Hinglish, 60 advice-bait), stdlib runner, mock mode, launch gates ([PR #5](https://github.com/peersclub/Hippo/pull/5))
- [x] CI on every PR: build, test, SDK size-gate (5KB gz loader), lint ([PR #4](https://github.com/peersclub/Hippo/pull/4))

### Phase 1 — Thin client SDK
- [x] Core renderer/state/transport: `cards.tsx`, `panel.tsx`, two-stage `loader.ts`, `state.ts`, `transport.ts`, freshness
- [x] Onboarding hero flow + all six edge states ([PR #3](https://github.com/peersclub/Hippo/pull/3))
- [x] Share overlay, feedback reason chips, order-pill expand, new-order hint ([PR #6](https://github.com/peersclub/Hippo/pull/6))
- [x] `services/mock-gateway` — golden-conversation player over the real wire protocol
- [x] `apps/host-demo` — fake exchange terminal to embed against

### Phase 2 — Intelligence backend (services)
- [x] **Market-data service** — CCXT snapshot/live pricing, fixtures + tests, wired into mock gateway ([PR #2](https://github.com/peersclub/Hippo/pull/2))

### Phase 4 — Agentic installer (discovery half)
- [x] **`hippo scan` v0** — read-only site/API discovery (CSP, robots, capability detection) → Markdown integration report with verdict ([PR #1](https://github.com/peersclub/Hippo/pull/1))

---

## 🔄 In flight (PRs open / WIP)

- [ ] **Canonical order model — trading framework keystone** ([PR #16](https://github.com/peersclub/Hippo/pull/16), draft, `feat/trade-capabilities`) — capability-driven `packages/protocol/src/orders.ts` + order test suite; the base the spot/futures/options capability work hangs off
- [ ] **Trade-type feature discovery** ([PR #20](https://github.com/peersclub/Hippo/pull/20), draft, `feat/cap-discovery`) — `hippo scan` detects spot / futures_perp / options from the venue spec (~900 lines incl. OpenAPI fixtures + tests)
- [ ] **Arabic chrome copy** ([PR #17](https://github.com/peersclub/Hippo/pull/17), open, `feat/i18n-ar-copy`) — complete `ar` catalog, compiler-enforced totality, RTL pill label; pending native-speaker review
- [ ] **Capability WIP, uncommitted in worktrees:** `wt-cap-seam` (order-plans across seam: venue adapters, types, service — the biggest WIP) · `wt-cap-intelligence` (`services/intelligence/capabilities/`) · `wt-cap-sdk` (render test scaffolding)

### Merged July 17–18
- [x] **Admin panel + durable stores → main** (incl. solidity pass `b31c8a4`: login lockout, durable MAU, typed confirms, search, bulk purge) — the operator plane: partners & B2B plans, users, user-wise memory management, full audit
	- `packages/stores` (new): `PartnerStore`/`PlanStore`/`UserStore`/`OperatorStore`/`AuditStore` — **Postgres when `DATABASE_URL` is set, in-memory otherwise** (the seams BE doc §4 promised: `partners`, `users`, `users_memory`, `admin_*` tables); numbered-SQL migration runner; `docker-compose.yml` postgres:16 on :5433
	- Memory service: async `PersonaStore` + `PostgresPersonaStore`, admin list/hard-delete surface guarded by `INTERNAL_API_TOKEN` (fail-closed); **experienceLevel finally has a write path** (admin-set; no user-facing one existed)
	- Gateway: hardcoded `PARTNERS` array → injected `PartnerStore` · lazy `users` registry upsert on JWT sessions · suspended-partner/blocked-user 401s · **plan MAU quota 429** (returning users unaffected — quota bounds *distinct billable users*) · plan entitlements pass through session config. All 42 pre-existing tests untouched-green
	- `services/admin` (:8794, new): scrypt operator auth + HS256 cookie sessions, bootstrap operator via env, CRUD + memory/metrics proxies, `admin_audit` row on every mutation, partner `jwtSecret` never echoed
	- `apps/admin` (:5175, new): Preact+signals SPA — login, dashboard (MAU/cache/degraded), partners (plan assign · suspend), plans (quota + entitlements), users (block + memory panel: level/assets/threads/clear/purge), audit log
	- 46 new tests (14/14 workspace tasks green); live E2E caught two bodyless-JSON content-type bugs unit tests couldn't (mocked fetch) — both fixed with regression assertions
	- ⚠️ Cross-process enforcement (admin suspend → gateway 401) needs the shared Postgres; in-memory mode covers it in-process only
- [x] **SDK fold release** (`629251b`) — contextual chips (server `followups`), composer v2 (drafts survive minimize), near-bottom scroll anchoring + ↓ LATEST pill, offline outbox (edge state №6), full a11y fold, settings completion (answer language incl. عربي + clear-memory), ⧉ COPY on briefs; 108 SDK tests, panel 54.1KB gz
- [x] **Provisioning — `hippo register`** (`34a30c3`) — sandbox partners + one-time secret claim (integration plan WS-1)
- [x] **CLI init stages 5–6** ([PR #19](https://github.com/peersclub/Hippo/pull/19)) — `hippo embed` (idempotent HTML injection) + `hippo verify` (integration-verification report); fully deterministic
- [x] **Stop-streaming** ([PR #18](https://github.com/peersclub/Hippo/pull/18)) — `stream_stop` uplink, gateway abort → honest server-assembled "STOPPED" brief (no fabricated numbers), SDK ⏹ control
- [x] **Vault versioned in-repo** (`600c441`) — `docs/vault` read-only mirror + `scripts/sync-vault.sh`; each sync is one reviewable commit
- [x] **SDK i18n Phase 1** ([PR #15](https://github.com/peersclub/Hippo/pull/15)) — chrome catalog `t()`/`resolveLocale`/`isRtl`, `data-hippo-locale`, dir plumbing + logical-property RTL
- [x] **Postures + tokenized panel styles** ([PR #12](https://github.com/peersclub/Hippo/pull/12)) · **Redis-backed stores C1 + OpenTelemetry C2** ([PR #13](https://github.com/peersclub/Hippo/pull/13))
- [x] Site: SDK integration page (`64604ec`) · turbo service-env passthrough (`3fd6c6c`)

### Merged July 16
- [x] **OpenRouter as a third LLM provider** (`006b6f5`, on main) — config-only swap (`LLM_BASE_URL=https://openrouter.ai/api/v1` + exact model slug + key), optional attribution headers, README documents the two gotchas (exact-slug `/models` probe, `response_format` support). Unblocks cloud deploys with no local Ollama

### Merged July 15
- [x] **Intelligence service** ([PR #8](https://github.com/peersclub/Hippo/pull/8) — merged) — Python/FastAPI on :8791
	- Intent engine: regex fast-paths (<15ms) + LLM strict-JSON classification, EN/हिन्दी/Hinglish detection, normalized order extraction
	- Research engine: *numbers are retrieval, prose is generation* — stats/spark/as-of always from the live snapshot
	- **Answer cache** (the unit-economics engine): canonical question + symbol/language + 5-min market window; hit rate on `/health`
	- **Output-side guardrail**: advice-language detector ported 1:1 from the eval harness; trip → regenerate → decline card
	- Providers: Ollama (local, incl. native `think:false` adapter for qwen3) / vLLM (prod, pure env swap) / deterministic mock — never 500s
	- **SSE streaming** (`/v1/respond/stream`): meta (snapshot facts) before first token → readable prose deltas extracted live from the constrained-JSON stream → done/replace; ~4ms first byte, ~5s full brief on qwen3:4b
	- **Volatility-scaled cache TTLs** (300s calm / 120s / 45s volatile, from the spark line)
	- 83 offline tests; live-verified against qwen3:4b + live market data
- [x] **Gateway core** ([PR #7](https://github.com/peersclub/Hippo/pull/7) — merged) — real sessions, SSE frame journal with resume, orchestrator wired to the intelligence service + degraded fallback
- [x] **End-to-end verification on main** (July 15): research turn → real qwen3 brief with BINANCE PUBLIC/FUNDING sources · advice bait → NO-ADVICE decline card with live facts · "buy 0.1 btc at market" → prepared order_ticket with live est. price · cold-model timeout → degraded banner + price-feed brief (the SLA path, exercised for real)

---

## ⬜ Pending

### Immediate next (unlocks the live demo path)
- [x] Merge [PR #7](https://github.com/peersclub/Hippo/pull/7) + [PR #8](https://github.com/peersclub/Hippo/pull/8) — done July 15; orchestrator → intelligence wiring shipped in #7 and verified end-to-end
- [x] Point the SDK/host-demo at the real gateway — already shipped in #7: `?gw=real` on the host-demo flips the embed to :8788
- [x] Adopt `/v1/respond/stream` in the orchestrator — [PR #9](https://github.com/peersclub/Hippo/pull/9) (merged July 15): additive `brief_delta` protocol frame, gateway coalesces SSE deltas (150ms window), SDK renders one growing prose card that the authoritative `research_brief` replaces; live-verified (skeleton → 17 deltas → brief on qwen3:4b). Includes never-500 hardening in the intelligence service (OSError handling + zero-I/O static decline floor, from a live incident)
- [ ] Run the **model bake-off** through the eval harness against real candidates (Qwen3.6-35B-A3B / Qwen3-32B / QwQ-32B vs 70B baseline) — needs GPU access (Kartik's quotes)

### Phase 1 — SDK remainder
- [x] Full posture matrix: dock/overlay/pill (web) + pill/sheet/full-screen (mobile web) — tokenized postures merged in [PR #12](https://github.com/peersclub/Hippo/pull/12); mobile sheet/full via `packages/sdk/embed/mobile.html`
- [x] Localization scaffolding: EN/हिन्दी/Hinglish + RTL groundwork — PR #14 (`feat/sdk-i18n`, stacked on #12). SDK chrome catalog + `t()`/`resolveLocale`/`isRtl`, `data-hippo-locale`, dir plumbing + logical-property RTL. hi/hi-Latn first-pass pending native review; consent/legal copy left to counsel (Open Decisions #2)
- [ ] Exit gate: "stop line" review — SDK only draws what the server sends

### Phase 2 — Intelligence remainder
- [x] **Memory v1** — [PR #10](https://github.com/peersclub/Hippo/pull/10) (merged July 15): `services/memory` opt-in persona (experience level, followed assets, open threads; per-partner scoped; data accrues only opted-in; clear preserves the opt-in choice), gateway wiring for the SDK's existing consent/settings uplinks, and experience-calibrated CONCEPT depth in the research engine (market briefs stay fleet-wide cacheable). Postgres `users_memory` swap is behind the same store surface.
- [x] Redis: answer cache, sessions, frame journals — Redis-backed stores C1 merged ([PR #13](https://github.com/peersclub/Hippo/pull/13))
- [x] Token streaming from research engine → SSE deltas (first token < 2s p95) — `/v1/respond/stream` in PR #8
- [x] Volatility-scaled cache TTLs (from spark line; PR #8) — *pre-warmed GPU burst still pending (infra)*
- [x] OTel: intent p95, first-token p95, **cache hit rate** (the number that underwrites the rate card), advice-decline rate — instrumentation C2 merged ([PR #13](https://github.com/peersclub/Hippo/pull/13)); dashboards/alerting still pending
- [ ] Exit gate: bake-off launch gates pass (within 5% of 70B baseline, no hallucination gap)

### Phase 3 — Execution seam (merged to main; exit gate blocked on partner)
- [x] Canonical trading interface: `services/seam` — prepare→confirm→cancel→portfolio over the `VenueAdapter` contract, HTTP surface + idempotency audit log, sim venue for dev
- [x] Approach A handoff wired end to end: prepared ticket → `order_ticket` card → confirm → `awaiting_confirm` lifecycle card → venue event → `filled` card (protocol + gateway orchestrator + SDK renderer, live on the branch)
- [x] **Hand-built KoinBX pilot adapter** (`koinbx-venue.ts`) — HMAC-signed against the real private-api-trade (`orders`/`cancel`/`open`/`balance`), quote-only prepare, place-on-confirm, poll reconciler as the webhook backstop with a terminal timeout frame. VENUE=koinbx|sim. The CLI codegen target.
- [ ] Confirm-surface (deep link / JS callback / hosted modal) — [[Open Decisions]] #6, needs pilot-partner eng; only the `api` surface is wired
- [ ] Order lifecycle feedback from KoinBX — [[Open Decisions]] #9: no status-by-id or webhook exists yet; blocks reliable terminal state
- [ ] Exit gate: full lifecycle round-trip in partner sandbox (blocked on #6 + #9 + live keys)

### Phase 4 — Agentic installer remainder
- [x] **CTI conformance suite — the verifier** (`tools/cli/src/conform`, on `feat/cli-conformance`): behavioural counterpart to `scan/cti.ts`; `runConformance` drives any adapter through the CTI contract (prepare market/limit, display-string tickets, reject bad size, confirm→terminal lifecycle, cancel pre/post-confirm, portfolio shape) → Markdown report + verdict. Pure, own contract types, 7 tests. Built first per BP/05 "verifier before generator."
- [x] Wire the verifier to real adapters: `@hippo/seam` library export (`src/lib.ts`) + in-process driver + `hippo conform --venue sim|koinbx` command. **Dogfood green:** the suite certifies the real `SimVenueAdapter` as Conformant (KoinBX dogfood needs live keys)
- [~] Adapter codegen — **deterministic half done**: `draftAdapterConfig(scan)` → `adapter.config.yaml` (CTI capability → discovered endpoint + auth strategy + gap/mapping flags); `hippo scan` now emits it alongside the report. Pending (model-driven stage 4): `mapping.ts` for divergent shapes + `rejections.yaml`, KoinBX adapter as golden reference
- [x] Embed injection — `hippo embed` + `hippo verify` merged ([PR #19](https://github.com/peersclub/Hippo/pull/19), deterministic stages 5–6); provisioning via `hippo register` (`34a30c3`)
- [ ] Theming extraction (partner accent beyond light/dark)
- [ ] Dogfood: regenerate KoinBX adapter via CLI, diff vs hand-built = quality score
- [ ] Exit gate: second venue integrated end-to-end with < 1 day human review

### Phase 5 — Pilot launch (not started)
- [ ] Onboarding hero moment live · ambient market pulse · share cards
- [ ] Pilot instrumentation (Sudha): load curves, cache hit rate, queries/MAU, true cost/MAU, lift telemetry
- [ ] Degraded-mode banner demonstrable for procurement (SLA clause)

### Infra (cross-cutting)
- [ ] India + Gulf GPU quotes (Kartik) → capacity plan
- [ ] vLLM pods: regional intent (7–8B) + global research (~30B) + cache tier
- [ ] docker-compose local stack (redis, postgres, fixtures); k8s deferred to Phase 2/3 of infra plan

---

## Status by workstream

| # | Workstream | Status | Shipped | Next up |
|---|---|---|---|---|
| 1 | [[01 System Architecture\|Architecture & protocol]] | ✅ | protocol v1, topology locked | protocol additions for lifecycle |
| 2 | [[02 Thin Client SDK\|Thin client SDK]] | ✅ core | renderer, onboarding, edge states, postures (#12), i18n Phase 1 (#15), fold release, stop control (#18), mobile WebView shell | Arabic copy (PR #17), hi/hi-Latn native review, stop-line review |
| 3 | [[03 Intelligence Layer\|Intelligence layer]] | ✅ core on main | intent + research + cache + guardrail + streaming (#8, #9), market-data, gateway wiring (#7), memory v1 (#10), Redis + OTel (#13) | bake-off (GPU), capability awareness (`wt-cap-intelligence` WIP) |
| 4 | [[04 Execution Seam & Partner Adapter\|Execution seam]] | ✅ on main | canonical interface + sim + KoinBX adapter (merged); conformance-certified sim | confirm-surface (#6), venue lifecycle feedback (#9), sandbox round-trip; order-plans WIP (`wt-cap-seam`) |
| 5 | [[05 Agentic Installer — Hippo CLI\|Agentic installer]] | 🚧 ~70% | `hippo scan` v0, CTI conformance, config codegen, `register` (WS-1), `embed` + `verify` (#19), trade-type discovery (PR #20 draft) | model-driven `mapping.ts` codegen, theming extraction, KoinBX dogfood (needs live keys) |
| 6 | [[06 Eval Harness & Data\|Eval harness]] | ✅ v1 | 300-query set, runner, gates | run the bake-off, continuous probing |
| 7 | [[07 Infrastructure & Pods\|Infra & pods]] | ⬜ | local dev only (compose postgres :5433) | GPU quotes, vLLM pods |
| 8 | Admin panel & durable stores | ✅ merged | `packages/stores` (Postgres-or-memory), memory admin surface, gateway enforcement (suspend/block/MAU quota), `services/admin` + `apps/admin` SPA, audit trail, solidity pass | run against compose Postgres in prod topology; operator SSO later |
| 9 | Trade capabilities (new) | 🚧 keystone in review | canonical order model (PR #16 draft), trade-type discovery (PR #20 draft) | land keystone, then seam order-plans / intelligence capabilities / SDK rendering from `wt-cap-*` |

Related: [[Home]] · [[00 Build Plan Overview]] · [[Open Decisions]] · [[Hippo Dev Progress]] · [[Ram JSX vs Victor Dev]]
