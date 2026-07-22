# 🦛 Hippo Roadmap — Done vs Pending

**As of:** July 22, 2026 · **Repo:** `peersclub/Hippo` (`hippo-app/`, main @ `8ffb707`) · Detail per phase: [[00 Build Plan Overview]] · Live links + creds: [[🟢 Live Demo Status]]

> [!summary] Where we are
> Phase 0 ✅ done · Phase 1 (SDK) ✅ core complete (postures #12, i18n Phase 1 #15, fold release, stop control #18, partner-token session mint #27) · Phase 2 (intelligence backend) ✅ core + Redis stores + OTel **merged to main**; bake-off pending (GPU) · Phase 3 (execution seam) ✅ seam + sim + **Assetworks** adapter + **conversational futures/perps (#28)** merged to main; exit gate blocked on Open Decisions #6/#9 · Phase 4 (CLI) 🚧 scan → conform → config codegen → `embed`/`verify` (stages 5–6, #19) all landed; model-driven codegen pending · Phase 5 (pilot) ⬜ · **Ops: admin panel + durable stores + provisioning (`hippo register`) + partner portal V1 merged to main**.
> **Trade capabilities — DONE.** Canonical order model keystone (#16) + trade-type discovery (#20) + **the full capability modules across seam/intelligence/SDK landed via [PR #28](https://github.com/peersclub/Hippo/pull/28)** (`6383e0f`): order plans, `capabilities()`, `/v1/prepare-order`, conversational perps ("long 0.5 BTC 10x") end to end. The `wt-cap-*` worktrees are now superseded. Arabic chrome copy (#17) merged — dormant until a partner sets `ar`; native review gates activation.
> **Venue = Assetworks.** Per Victor "no KoinBX in Hippo for now" — the KoinBX venue adapter was removed (`e6660cb`), the client display name renamed KoinBX → Assetworks everywhere (`2e5e4ab`/`cd2b804`), and the demo partner slug renamed `koinbx-demo` → `assetworks-demo` (`418f7e1`). A self-contained **Assetworks test host** (`services/host-venue` + Next.js host app) is the venue Hippo parasites onto.
> **Live and shareable.** All 7 services on Railway + 4 frontends on Vercel; the full loop is verified over the public link — token endpoint → Bearer mint → streaming research brief (`anthropic/claude-haiku-4.5`) → prepared order ticket. Links + creds in [[🟢 Live Demo Status]]. The conversational loop is verified end-to-end (protocol turn → orchestrator → intent/research → live market data → research_brief / advice_decline / order_ticket frames, including the degraded-mode banner path).
> **New since July 21 (all merged to main).** **Two-stage interpret flow — Phase A** ([PR #31](https://github.com/peersclub/Hippo/pull/31), `8ffb707`): the fast model interprets *and* restructures every query before the answer model runs, the trader sees an "UNDERSTOOD" card, and the gateway forwards the clean rewrite (phases B–D of the memory feature still pending). **Honest order journey** ([PR #29](https://github.com/peersclub/Hippo/pull/29) + hotfix `61bb79b`): real lifecycle progress (SENDING → PLACED · WORKING → FILLED, one collapsing card) on additive `stage`/`side` fields, plus the fix for the seam never sending its internal token — **every cloud fill had been silently 401ing since the #24 hardening**. **Movable frosted-glass floating panel** ([PR #30](https://github.com/peersclub/Hippo/pull/30)): the overlay posture is now a draggable, translucent co-existence mode. **Host control center** (`ae12f91` + `2f5d0bd`): full operator console on the test host — embed/appearance, venue realism & chaos, capabilities, live Hippo-AI controls, order management, wallet reset. **Real-venue demo** (`fd69fd2`): the public demo's lifecycle is driven only by real Assetworks venue events, no scripted mock journey; real Hippo + AssetWorks logos replace the placeholder marks (`fee227e`).

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

- [ ] **Model-driven adapter codegen** — deterministic half done (`hippo scan` drafts `adapter.config.yaml`); pending the model-driven `mapping.ts` for divergent shapes + `rejections.yaml`
- [ ] **Tier-2 durability** — durable ticket routing + durable seam audit store (next migration `009`) so nothing rides only in memory
- [ ] **Cloud-wire the Assetworks host** — the Next.js host app is parked on branch `assetworks-exchange-app` (its `next` dep crashes Railway's Metal builder); the `host-venue` service still needs Railway wiring. See [[🟢 Live Demo Status]] known issues
- [ ] `ar` **native-speaker review** (Kartik/MENA) — gates enabling `data-hippo-locale="ar"` for any Arabic-market partner; copy itself is merged (#17)

### Merged July 21–22 — interpret flow, honest lifecycle, float panel, host console
- [x] **Two-stage interpret flow — Phase A** ([PR #31](https://github.com/peersclub/Hippo/pull/31), `8ffb707`) — the flow Victor described (small-model interpret → forward to main AI): `/v1/intent` now also returns `interpretation` (one-line "what I understood") + `restructuredQuery` (a clean rewrite), same fast model + extended prompt; gateway emits a **persistent additive `InterpretationFrame`** (with a `memoryScopes` seam for the later memory work) and forwards the restructured query — not the raw text — into the answer stream; SDK renders a persistent, collapsible "UNDERSTOOD" card that survives the skeleton→answer swap. Fast-path/degraded turns get a deterministic templated interpretation so the field is never missing. Tokens-only CSS, i18n ×4, loader 1.45KB. Verified live. **Phases B (4-level session/user/host/global memory stores + migrations), C (compose-into-prompt + session inspector), D (entitlement gating) are still TODO** (plan `~/.claude/plans/vast-swimming-rossum.md`)
- [x] **Honest order journey** ([PR #29](https://github.com/peersclub/Hippo/pull/29) + hotfix `61bb79b`) — lifecycle cards now show *real* progress: additive `stage` (open STRING by design — `placing`/`working`/`cancel_pending` today; an enum would break a parser on growth) + `side` on `LifecycleFrame`; both venues emit a PLACED · WORKING ack the moment an order is actually on the venue; SENDING → PLACED · WORKING → FILLED collapses into **one card per ticketId** with a fillPct bar and neutral cancelled states; meta-row upgrade (SVG thumbs, stale prefix, landed flash). Three latent drop-the-fill bugs fixed, all the same "non-partial phase = terminal" shape in the seam + gateway routers. **The keystone fix: `seam deliver()` never sent `x-hippo-internal-token`, so every placement ack + FILL to a guarded gateway 401'd — all cloud fills had been silently failing since the #24 hardening;** regression tests pin each. First fully-green CI since July 19
- [x] **Movable frosted-glass floating panel** ([PR #30](https://github.com/peersclub/Hippo/pull/30), `778f61b`) — the intermediate `overlay` posture becomes a true float: **draggable** by the header (pointer-capture, `clampToViewport` keeps it fully on-screen + re-clamps on resize, position persisted per embed key; desktop-only, mobile overlay stays full-screen) and a **frosted-glass** settings toggle makes it translucent with a backdrop blur so the host's own chart/orderbook stays visible around it — non-intrusive co-existence. All client presentation (`posture.ts` is explicitly *not* protocol); tokens-only, i18n ×4, loader untouched (1.45KB gz), 170 SDK tests (4 new clamp cases)
- [x] **Host control center** (`ae12f91` + `2f5d0bd`) — the test host grew a full operator console (`apps/host-demo/settings`): (1) embed & appearance (theme/locale/launcher-label/auto-open/partner-key → localStorage, read by the embed on load); (2) venue realism & chaos (fillMode working|instant|**manual** w/ host-approved fills, slippagePct, latencyMs, rejectRate, maintenance, makerFee); (3) instruments & capabilities (caps/leverage/margin modes/instruments — `/v1/capabilities` now **derived** from live config); (4) live Hippo-AI controls (runtime `router.set_model()` + force_mock + toggleable cache + persona override, all proxied same-origin so the browser never hits the internal AI service) + wallet reset. Cancel→chat phantom-fill fixed (terminal-aware `/status` so a host cancel shows CANCELLED, not a phantom FILLED). host-venue 12 tests
- [x] **Real-venue demo** (`fd69fd2`) — per product direction (no mock, all real data): the public demo's lifecycle journey is demonstrated only by real Assetworks venue events (seam `VENUE=assetworks` over the HTTP `host-venue`), the mock gateway keeps its original minimal script; `host-venue` Dockerfile added so Railway can run it. **Real logos** (`fee227e`): the Hippo mascot (SDK launcher/header/hero) + AssetWorks wordmark (host header/drawer) replace the letter-box placeholders; loader stays under the 5KB gate (mascot served by URL from SDK dist). Streaming-card flicker fixed (`0f2703b`, pinned id across deltas); site `cleanUrls` + live page URLs recorded (`270c028`)

### Merged July 20–21 — conversational futures, Assetworks, live deploy
- [x] **Conversational futures / perps — end to end** ([PR #28](https://github.com/peersclub/Hippo/pull/28), `6383e0f`) — finished + integrated the stranded `wt-cap-*` WIP onto main. Seam gains `OrderPlan` (spot/futures_perp/options) + `VenueAdapter.capabilities()` + optional `prepareOrder(plan)` + `GET /v1/capabilities` + `POST /v1/prepare-order` (capability-gated, 422 for unsupported, spot-fallback). `intent.py` parses perps ("long 0.5 BTC 10x" / "short 1 ETH 20x cross" / "close long"); gateway `OrderIntent` perp fields + orchestrator routes `futures_perp` to the plan path. **Spot stays byte-identical.** sim enables all 3 caps; Assetworks reads caps live from the host `/v1/capabilities` and places perps. Verified live + 31 seam / 83 gateway / 33 intent tests
- [x] **SDK partner-token session mint** ([PR #27](https://github.com/peersclub/Hippo/pull/27)) — a `data-hippo-token-url` attribute fetches a fresh Bearer per mint from the partner's own endpoint; no long-lived secret ever sits in the page. This is the production trust topology (blocker #4-SDK closed)
- [x] **Assetworks test host + adapter** (`5875aa6`) — self-contained venue `services/host-venue` :8796 on the HMAC-signed trade wire with a spot+perps fill engine; `services/seam/src/assetworks-venue.ts` (`VENUE=assetworks`), both confirm surfaces (`api` + `js_callback`) read live from host admin. `apps/host-demo` rebuilt as the Assetworks Exchange UI
- [x] **Venue = Assetworks, KoinBX removed** — KoinBX venue adapter deleted (`e6660cb`, "no KoinBX in Hippo for now"); seam venues are now `sim` + `assetworks`. Client display name renamed KoinBX → Assetworks everywhere (`2e5e4ab` / `cd2b804`); demo partner slug `koinbx-demo` → `assetworks-demo` (`418f7e1`). Zero KoinBX left in tracked source
- [x] **Cloud deploy — Railway + Vercel, live loop verified** — all 7 backend services + Postgres + Redis on Railway (intelligence in `mode=llm model=anthropic/claude-haiku-4.5`), 4 frontends on Vercel; `HIPPO_DEV=0` (no anonymous minting). Full loop verified over the public link. Non-ephemeral JWT secrets + Secure cookies ([PR #25](https://github.com/peersclub/Hippo/pull/25)) closed the redeploy-logout blocker. See [[🟢 Live Demo Status]]

### Merged July 20 — product-hardening batch (multi-agent audit + fix)
A 51-gap audit (cache/logs/placeholders/loaders/use-cases) across SDK, admin, services, and the protocol use-case matrix, then fixes in disjoint lanes over two batches:
- [x] **Resilience + observability sweep** (`f083c33`) — admin global live-sessions page (list + per-row revoke) + sandbox-partner visibility (`sandboxPartners` count + activate) + answer-cache stats on the dashboard + shared empty-state component (+77 admin tests); market-data **request coalescing** (in-flight map) + bounded LRU cache + CCXT timeouts (kills miss-storm hammering); Redis write-failure fallback with logged errors instead of decline cards; `LOG_LEVEL`/`LLM_TIMEOUT`/`LLM_INTENT_TIMEOUT` honored fleet-wide + structured startup logs; **model id on every `brief_delta` stream frame** (additive), rendered live in the streaming card; card-action interception (`refresh:`/`share:`/`manage:` no longer echo as chat — refresh re-runs in place via a frameId→turn map + additive `replaces` field); per-ticket lifecycle expiry timer (`TICKET_EVENT_TIMEOUT_MS`) so orders can't hang in `awaiting_confirm`
- [x] **SDK connection resilience** (`f1e9ca4`) — session re-mint on EventSource CLOSED (expired/revoked/gateway-restart) + `/v1/turns` 404 replay; distinct mint-failure states: 401 → `blocked` (surface disables quietly), 429 → `capacity` (friendly "busy this month" notice), 5xx → exponential backoff instead of a fixed 3s loop; +9 transport tests (122 SDK total)
- [x] **SDK medium-gap sweep** (`7595a07`) — refresh-in-place (`pushFrame` honors the `replaces` field; REFRESH holds a pending state, no fixed-time flash); stalled-stream watchdog (a delta stream with no terminal frame finalizes honestly instead of a forever cursor); unknown-frame spinner fix (forward-compat frames clear a preceding thinking/skeleton); outbox periodic flush (bounded timer drains queued uplinks while `live`, not only on a state transition); **trading-action failure feedback** (order-ticket confirm + lifecycle cancel + composer stop now surface a live `send()` failure inline via `action_failed`, all 4 locales — a silent trading-action failure was the worst-case gap). 137 SDK tests. All 51 audited gaps now closed.

### Merged July 17–18
- [x] **Model provenance on briefs** (`3eb6282`) — every brief carries the model id that actually generated it (real id, or `mock` when the provider router fell back), threaded `ProviderRouter.model` → pinned intelligence contract → gateway `research_brief` frame → additive `model` field in protocol v1; rendered as a tag in the SDK card eyebrow and as an **LLM · active model** dashboard stat (new `intelligence {mode, model}` block on admin `/v1/metrics`, 3s timeout, dashboard renders without it). Provenance travels with the artifact, not the config — a support question "why was this answer generic?" is answerable from the card
- [x] **One-URL demo + /how test guide** (`3eb6282` + `f4aa483`) — plain `localhost:4000` now drives the REAL gateway (`?gw=mock` opts into the scripted mock); the GW badge grew into a mini nav (HOW TO TEST → `/how`, ADMIN → :5175). `/how` is a shareable, self-contained how-to-test page covering every verified feature flow with expected results, wired into production build inputs
- [x] **`.env.example` — clone-to-running template** (`bdeb3ac`) — documents every `globalPassThroughEnv` var with what it unlocks and its fallback (mock LLM, in-memory stores, 503'd token-gated surfaces); `.gitignore` gains `!.env.example` (the `.env.*` pattern was silently swallowing it). Local dev env is now full-fidelity: Postgres-backed stores + OpenRouter `anthropic/claude-haiku-4.5` live end-to-end
- [x] **Partner admin portal V1** ([PR #21](https://github.com/peersclub/Hippo/pull/21), merged July 18) — partner-facing accounts on their own trust plane: `services/portal` :8795 + `apps/portal` :5176, operator invite mint → one-time claim, own data (MAU vs quota), integration (embed tag, secret rotation), plan view + change request, own audit; [[12 Partner Admin Portal]]
- [x] **Canonical order model — trading framework keystone** ([PR #16](https://github.com/peersclub/Hippo/pull/16), merged July 18) — capability-driven `packages/protocol/src/orders.ts` (spot / futures_perp / options discriminated union, money as strings, `VenueCapabilities` presence-=-enabled) + additive `capability` field on `order_ticket`
- [x] **Trade-type feature discovery** ([PR #20](https://github.com/peersclub/Hippo/pull/20), merged July 18) — `hippo scan` stage 3: deterministic spot/futures_perp/options detection from OpenAPI specs, `paramsIncomplete` honesty flag, mirrors `VenueCapabilities`
- [x] **Arabic chrome copy** ([PR #17](https://github.com/peersclub/Hippo/pull/17), merged July 18) — complete `ar` catalog (compiler-enforced totality), RTL pill label `اسأل Hippo`, brand in Latin script, Western numerals; dormant until enabled per-partner
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
- [x] **Two-stage interpret flow — Phase A** ([PR #31](https://github.com/peersclub/Hippo/pull/31)) — visible interpretation + restructured query, persistent `InterpretationFrame` with a `memoryScopes` seam; see the July 21–22 batch above
- [ ] **Memory feature phases B–D** (builds on the shipped interpret flow) — B: 4-level session/user/host/global memory stores + migrations + admin config; C: compose-into-prompt + session inspector; D: entitlement gating by plan
- [ ] Exit gate: bake-off launch gates pass (within 5% of 70B baseline, no hallucination gap)

### Phase 3 — Execution seam (merged to main; exit gate blocked on partner)
- [x] Canonical trading interface: `services/seam` — prepare→confirm→cancel→portfolio over the `VenueAdapter` contract, HTTP surface + idempotency audit log, sim venue for dev
- [x] Approach A handoff wired end to end: prepared ticket → `order_ticket` card → confirm → `awaiting_confirm` lifecycle card → venue event → `filled` card (protocol + gateway orchestrator + SDK renderer, live on the branch)
- [x] **Capability-driven order plans** (PR #28) — `OrderPlan` (spot/futures_perp/options) + `VenueAdapter.capabilities()` + `GET /v1/capabilities` + `POST /v1/prepare-order` (capability-gated, 422 for unsupported); sim enables all three, Assetworks places perps live. The trade keystone, fully wired
- [x] **Assetworks venue adapter** (`assetworks-venue.ts`, `VENUE=assetworks`) — HMAC-signed against the `host-venue` test exchange (`orders`/`cancel`/`open`/`balance`), quote-only prepare, place-on-confirm, poll reconciler as the webhook backstop with a terminal timeout frame; supports both `api` and `js_callback` confirm surfaces (read live from host admin). Replaced the removed KoinBX adapter (`e6660cb`); the CLI codegen target
- [x] Approach A handoff wired end to end: prepared ticket → `order_ticket` card → confirm → `awaiting_confirm` lifecycle card → venue event → `filled` card
- [~] Confirm-surface — `api` + `js_callback` wired against the Assetworks host; deep-link / partner-hosted-modal variants still need a real pilot partner ([[Open Decisions]] #6)
- [ ] Order lifecycle feedback from a real spot pilot venue — [[Open Decisions]] #9: a venue with no status-by-id or webhook blocks reliable terminal state; poll reconciler is the backstop
- [ ] Exit gate: full lifecycle round-trip in a real partner sandbox (blocked on #6 + #9 + live keys)

### Phase 4 — Agentic installer remainder
- [x] **CTI conformance suite — the verifier** (`tools/cli/src/conform`, on `feat/cli-conformance`): behavioural counterpart to `scan/cti.ts`; `runConformance` drives any adapter through the CTI contract (prepare market/limit, display-string tickets, reject bad size, confirm→terminal lifecycle, cancel pre/post-confirm, portfolio shape) → Markdown report + verdict. Pure, own contract types, 7 tests. Built first per BP/05 "verifier before generator."
- [x] Wire the verifier to real adapters: `@hippo/seam` library export (`src/lib.ts`) + in-process driver + `hippo conform --venue sim|assetworks` command. **Dogfood green:** the suite certifies the real `SimVenueAdapter` as Conformant (Assetworks dogfood runs against the `host-venue` test exchange)
- [~] Adapter codegen — **deterministic half done**: `draftAdapterConfig(scan)` → `adapter.config.yaml` (CTI capability → discovered endpoint + auth strategy + gap/mapping flags); `hippo scan` now emits it alongside the report. Pending (model-driven stage 4): `mapping.ts` for divergent shapes + `rejections.yaml`, the Assetworks adapter as golden reference
- [x] Embed injection — `hippo embed` + `hippo verify` merged ([PR #19](https://github.com/peersclub/Hippo/pull/19), deterministic stages 5–6); provisioning via `hippo register` (`34a30c3`)
- [ ] Theming extraction (partner accent beyond light/dark)
- [ ] Dogfood: regenerate the Assetworks adapter via CLI, diff vs hand-built = quality score
- [ ] Exit gate: second venue integrated end-to-end with < 1 day human review

### Phase 5 — Pilot launch (not started)
- [ ] Onboarding hero moment live · ambient market pulse · share cards
- [ ] Pilot instrumentation (Sudha): load curves, cache hit rate, queries/MAU, true cost/MAU, lift telemetry
- [ ] Degraded-mode banner demonstrable for procurement (SLA clause)

### Ops — Partner admin portal (planned 2026-07-18, [[12 Partner Admin Portal]])
- [ ] `@hippo/stores`: `partner_admins` (migration 008), `PartnerAdminStore`, shared scrypt helpers, audit filter by partner, per-partner MAU count
- [ ] `services/portal` :8795 — partner-scoped auth (own cookie/secret), overview / users / integration (secret rotation) / plan / audit; tenancy by construction (partnerId only ever from the session)
- [ ] `services/admin`: operator-side invite mint / list / revoke (`/v1/partners/:id/admins`), one-time claim links
- [ ] `apps/portal` :5176 — login/claim, overview, users, integration, plan, audit
- [ ] Exit gate: invite → claim → login → rotate secret → gateway mints sessions with the new secret; zero cross-tenant routes by construction

### Infra (cross-cutting)
- [ ] India + Gulf GPU quotes (Kartik) → capacity plan
- [ ] vLLM pods: regional intent (7–8B) + global research (~30B) + cache tier
- [ ] docker-compose local stack (redis, postgres, fixtures); k8s deferred to Phase 2/3 of infra plan

---

## Status by workstream

| # | Workstream | Status | Shipped | Next up |
|---|---|---|---|---|
| 1 | [[01 System Architecture\|Architecture & protocol]] | ✅ | protocol v1, topology locked | protocol additions for lifecycle |
| 2 | [[02 Thin Client SDK\|Thin client SDK]] | ✅ core | renderer, onboarding, edge states, postures (#12), i18n Phase 1 (#15) + Arabic copy (#17, dormant), fold release, stop control (#18), mobile WebView shell, partner-token mint (#27), **movable frosted-glass float panel (#30)**, **honest lifecycle + interpretation cards (#29/#31)** | ar/hi/hi-Latn native review, stop-line review |
| 3 | [[03 Intelligence Layer\|Intelligence layer]] | ✅ core on main | intent + research + cache + guardrail + streaming (#8, #9), market-data, gateway wiring (#7), memory v1 (#10), Redis + OTel (#13), capability awareness (#28), **two-stage interpret flow — Phase A (#31)** | bake-off (GPU), memory feature phases B–D |
| 4 | [[04 Execution Seam & Partner Adapter\|Execution seam]] | ✅ on main | canonical interface + sim + **Assetworks** adapter + order-plans/capabilities + conversational perps (#28) + **honest lifecycle acks + internal-token fill fix (#29)**; conformance-certified sim | confirm-surface variants (#6), real-venue lifecycle feedback (#9), sandbox round-trip |
| 5 | [[05 Agentic Installer — Hippo CLI\|Agentic installer]] | 🚧 ~75% | `hippo scan` v0, CTI conformance, config codegen, `register` (WS-1), `embed` + `verify` (#19), trade-type discovery (#20, merged) | model-driven `mapping.ts` codegen, theming extraction, Assetworks dogfood |
| 6 | [[06 Eval Harness & Data\|Eval harness]] | ✅ v1 | 300-query set, runner, gates | run the bake-off, continuous probing |
| 7 | [[07 Infrastructure & Pods\|Infra & pods]] | ⬜ | local dev only (compose postgres :5433) | GPU quotes, vLLM pods |
| 8 | Admin panel & durable stores | ✅ merged | `packages/stores` (Postgres-or-memory), memory admin surface, gateway enforcement (suspend/block/MAU quota), `services/admin` + `apps/admin` SPA, audit trail, solidity pass | run against compose Postgres in prod topology; operator SSO later |
| 9 | Trade capabilities | ✅ merged | canonical order model (#16) + trade-type discovery (#20) + full capability modules across seam/intelligence/SDK + conversational perps ([PR #28](https://github.com/peersclub/Hippo/pull/28), `6383e0f`) | options venue when a partner offers them; perp UX polish |
| 10 | [[12 Partner Admin Portal\|Partner admin portal]] | ✅ merged ([PR #21](https://github.com/peersclub/Hippo/pull/21), `8981113`) | full V1 (2026-07-18): stores/migration 008, `services/portal` :8795 (tenancy by construction), operator invite mint, `apps/portal` :5176; cross-service E2E green | run against compose Postgres; memory visibility & invite delivery are [[Open Decisions]] #10/#11; email/SSO later |

Related: [[Home]] · [[00 Build Plan Overview]] · [[Open Decisions]] · [[Hippo Dev Progress]] · [[Ram JSX vs Victor Dev]]
