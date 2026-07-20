---
title: Jul 20 Dev — Production-Readiness Handoff
date: 2026-07-20
tags: [dev, prod-readiness, handoff, backend]
owner: Victor
status: in-progress
---

# Jul 20 Dev — Make Hippo Prod-Ready (Dev Handoff)

> Scope: harden the backend to production + get a shareable live demo.
> Source: read-only audit of `services/*` + `packages/stores`, plus the Tier-1/#9/smoke work landed this session.
> Architecture refs: [[10 BE Architecture]], [[07 Infrastructure & Pods]], [[04 Execution Seam & Partner Adapter]].
> Repo: `/Users/Victor/Projects22/hippo/hippo-app` · main @ `a7e94e4`

## 0 · TL;DR
The product loop works end-to-end (verified live: session → SSE → research brief / advice decline / order ticket → confirm → filled lifecycle → positions). The gap to production was never the product logic — it was the **trust boundary** (internal services assumed unimplemented mTLS) and **packaging**. Of the 10 audit blockers, **7 are now closed**; **3 remain** (all deferrable past a single-instance demo), plus the SDK client-JWT feature and an ops key-rotation.

## 1 · Done (committed to main)
- [x] #1 Gateway dev-auth default opt-in + dev-partner secret fail-closed — `packages/stores/src/partner-store.ts` (`29e6e02`, PR #24)
- [x] #2 Seam trading surface auth (internal token, timing-safe, fail-closed) — `services/seam/src/service.ts` (`a9e3ef5`, PR #23)
- [x] #3 Gateway `/internal/venue-events` auth (`29e6e02`, PR #24)
- [x] #6 Seam `callbackUrl` SSRF allowlist — `SEAM_CALLBACK_ALLOWED_ORIGINS` (`a9e3ef5`, PR #23)
- [x] #7 Memory persona PII routes require internal token (`1ca95ee`, PR #22)
- [x] #8a Gateway rate-limit — `services/gateway/src/plugins/rate-limit.ts` on `/v1/session` + `/v1/turns` (PR #24)
- [x] **#9 Non-ephemeral admin/portal secrets + Secure-by-default cookies** — services now refuse to boot in prod without `ADMIN_JWT_SECRET`/`PORTAL_JWT_SECRET`; cookies `Secure` by default in prod (PR #25, `1061f79`)
- [x] **Go/no-go smoke** — `scripts/smoke.sh` automates DEPLOY.md §3 steps 1/3/4 (PR #26, `a7e94e4`), verified 13/13 green locally
- [x] Bonus (parallel session): sim venue serves REAL portfolio state (`1e1d8c4`) + SDK honest empty state (`0b8063e`); 7 per-service Dockerfiles in `deploy/docker/`

### Live now (curled 200)
- admin API: `https://admin-production-9c9f.up.railway.app/health`
- portal API: `https://portal-production-735a.up.railway.app/health`
- ⚠️ gateway public URL + host-demo front-end URL are NOT in the repo — they live only in the Railway/Vercel dashboards. Committing `VITE_GATEWAY_URL` + per-service `railway.json` would make the deploy reproducible from a clean clone.

## 2 · Remaining (all deferrable past a single-instance demo)

### [ ] #4 — Durable order-lifecycle routing (medium, highest care)
`ticketId→session` lives only in an in-process map → fills lost after restart / across pods. Breaks the "status always arrives in the thread" promise.
- New `services/gateway/src/plugins/ticket-index.ts` (`InMemoryTicketIndex` + `RedisTicketIndex` on the existing `RedisClient` surface)
- Thread `ticketIndex` + `resumeSession` into `createOrchestrator`; write index in `prepareTicket`; del on terminal/cancel
- Make `onVenueEvent` async: local map → index.get → `resumeSession(sid)` fallback; `await` it on `/internal/venue-events`
- Test: `filled` event for a ticket whose live session was evicted still emits `lifecycle` + records `order_executed` (harness: `services/gateway/test/helpers.ts`)

### [ ] #5 — Durable seam audit (medium)
Compliance-critical trail is in-memory only (`services/seam/src/service.ts`, `audit: AuditEntry[]`).
- New migration `packages/stores/migrations/009_seam_audit.sql` (008 is `partner_admins`)
- `PostgresSeamAuditStore` + `NullSeamAuditStore` in `@hippo/stores` (mirror `PostgresAuditStore`); export from index
- `service.ts` accepts `auditStore`, write-through to the in-memory mirror; `/internal/audit` reads durable when set; select by `DATABASE_URL` in `index.ts`

### [ ] #8b — Portal/admin ingress rate limit (small)
Reuse `services/gateway/src/plugins/rate-limit.ts` (preHandler + build option, default on, tests pass `rateLimit:false`) in `buildPortalService` + `buildAdminService`; keep `LoginThrottle`. Add 429-on-burst tests.

### [ ] #4-SDK — Client-side JWT path (feature; needs a product decision)
Backend JWT verification is ready, but the browser SDK never sends a token (`packages/sdk/src/transport.ts`), so real (non-dev) auth rejects it. The "a real user can log in" milestone. Pick the token-fetch approach first:
- **config callback** — partner passes `data-hippo-token-url` / a JS fn the SDK calls for a fresh short-lived JWT (most flexible)
- **partner-injected** — page mints the JWT server-side and hands it at init (simplest; host handles refresh)
- **hybrid** — static first token + refresh callback

### [ ] #10 — Secrets hygiene (ops, Victor)
Rotate the OpenRouter `LLM_API_KEY`, `ADMIN_BOOTSTRAP_PASSWORD`, and `INTERNAL_API_TOKEN` — the working-tree `.env` values are burned. Set prod secrets in Railway, not from `.env.example`.

## 3 · Conventions to match
- Internal surfaces use the timing-safe, fail-closed token guard: 503 when `INTERNAL_API_TOKEN` unset, 401 on mismatch, header `x-hippo-internal-token`
- Seam options: `internalToken`, `callbackAllowedOrigins` / env `SEAM_CALLBACK_ALLOWED_ORIGINS`
- Gateway tests: `services/gateway/test/helpers.ts` (`testApp`, `TEST_INTERNAL_TOKEN`, `createSession`, `sendTurn`, `waitForJournal`)
- Stores: Postgres-or-in-memory seam, one impl pair per store, exported from `packages/stores/src/index.ts`; next migration is **009**

## 4 · Deploy (see repo `DEPLOY.md`)
7 Docker services (`deploy/docker/*.Dockerfile`, root context) + Postgres + Redis; 4 Vercel SPAs.
- Railway: 7 services (Dockerfile Path per service) + Postgres + Redis plugins; run migrations once (`DATABASE_URL=<railway pg> pnpm --filter @hippo/stores migrate`)
- Gateway gets a public domain; intelligence/market-data/memory/seam stay private-only
- Cross-service URLs via `${{svc.RAILWAY_PRIVATE_DOMAIN}}:<port>`
- Vercel: host-demo `VITE_GATEWAY_URL` = gateway public URL; admin/portal `vercel.json` rewrites → the two Railway API URLs

### Required prod env
`HIPPO_DEV=0` (or `=1` + `KOINBX_DEV_JWT_SECRET` for a no-signup demo) · `DATABASE_URL` · `REDIS_URL` · `INTERNAL_API_TOKEN` (fleet-wide) · `ADMIN_JWT_SECRET` · `PORTAL_JWT_SECRET` (distinct) · `ADMIN_COOKIE_SECURE=1` · `PORTAL_COOKIE_SECURE=1` · `ADMIN_ALLOWED_ORIGIN` · `PORTAL_ALLOWED_ORIGIN` · `SEAM_CALLBACK_ALLOWED_ORIGINS` · `GATEWAY_CALLBACK_URL` · `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` · `VENUE=sim`

## 5 · Go / no-go smoke
Automated: `scripts/smoke.sh` (health + the mode:llm / mode:live degradation gates + session posture + a full research turn).
- Local: `scripts/smoke.sh`
- Remote: `GATEWAY_URL=https://<gw> EXPECT_DEV=0 CHECK_SERVICES=0 scripts/smoke.sh`

Still manual (UI): admin bootstrap login → create partner+plan; portal invite → claim → login → rotate secret → confirm audit row; redeploy admin once → still logged in (#9 proof).

## 6 · Deferred to post-demo (full-prod epic)
KoinBX live adapter (needs partner keys — [[Open Decisions]] #6/#9; only `confirm-surface=api` wired, no venue webhook, poll reconciler can't disambiguate filled vs cancelled) · OTel export (collector TBD) · multi-instance scale beyond #4/#9 · market-data uses Binance public (CCXT), not the KoinBX book · committed `railway.json` config-as-code.

## 7 · Suggested sequence
#8b → #5 (+migrate 009) → #4 → root `pnpm build` + `pnpm test` → deploy wiring (§4) → smoke (§5). SDK client-JWT (#4-SDK) is a separate track gated on the product decision. Realistic: single-instance demo is reachable now (deploy wiring + secrets only); +~1 day for #4/#5/#8b full-prod.

## Links
[[Home]] · [[Roadmap]] · [[10 BE Architecture]] · [[04 Execution Seam & Partner Adapter]] · [[07 Infrastructure & Pods]] · [[12 Partner Admin Portal]] · [[Open Decisions]]
