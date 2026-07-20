# Deploying Hippo — Railway (services) + Vercel (frontends)

The stack is 7 resident services and 4 static frontends. Serverless can't hold
the gateway's SSE streams or the seam's poll reconciler, so the split is:

| Where | What |
|---|---|
| **Railway** | `gateway` `intelligence` `market-data` `memory` `seam` `admin` `portal` + Postgres + Redis |
| **Vercel** | `apps/site` `apps/host-demo` `apps/admin` `apps/portal` |
| **OpenRouter** | the LLM behind `intelligence` (config-only; no GPU to run) |

Dockerfiles live in `deploy/docker/*.Dockerfile` — every one builds from the
**repo root** context (workspace deps compile from source).

## 1 · Railway

Create one project → **7 services from this repo**. For each: Settings →
Build → *Dockerfile Path* = `deploy/docker/<name>.Dockerfile`. Add the
**Postgres** and **Redis** plugins.

Run migrations once (locally, against the Railway DB):

```bash
DATABASE_URL=<railway postgres url> pnpm --filter @hippo/stores migrate
```

### Env matrix

Vars marked ⬅ reference other Railway services (use Railway's
`${{service.RAILWAY_PRIVATE_DOMAIN}}` references or the public URLs).

| Service | Vars |
|---|---|
| **gateway** | `DATABASE_URL` `REDIS_URL` `HIPPO_DEV=0` · `INTELLIGENCE_URL` ⬅ `MARKET_DATA_URL` ⬅ `MEMORY_URL` ⬅ `SEAM_URL` ⬅ · `INTERNAL_API_TOKEN` (random 32-hex, same everywhere) |
| **intelligence** | `LLM_BASE_URL=https://openrouter.ai/api/v1` `LLM_MODEL=<exact OpenRouter slug>` `LLM_API_KEY` · `MARKET_DATA_URL` ⬅ `REDIS_URL` |
| **market-data** | *(none — live CCXT public data)* |
| **memory** | `DATABASE_URL` `INTERNAL_API_TOKEN` |
| **seam** | `VENUE=sim` `GATEWAY_CALLBACK_URL` ⬅ (gateway's `/internal/venue-events`) |
| **admin** | `DATABASE_URL` `ADMIN_JWT_SECRET` (random) `ADMIN_BOOTSTRAP_EMAIL` `ADMIN_BOOTSTRAP_PASSWORD` `ADMIN_COOKIE_SECURE=1` `ADMIN_ALLOWED_ORIGIN=https://<admin>.vercel.app` · `MEMORY_URL` ⬅ `GATEWAY_URL` ⬅ `INTERNAL_API_TOKEN` |
| **portal** | `DATABASE_URL` `PORTAL_JWT_SECRET` (random, ≠ admin's) `PORTAL_COOKIE_SECURE=1` `PORTAL_ALLOWED_ORIGIN=https://<portal>.vercel.app` · `HIPPO_SDK_URL=https://<host-demo>.vercel.app/loader.js` |

Two that bite if missed:
- `HIPPO_DEV=0` on the gateway — otherwise anonymous sessions mint against the dev partner in production.
- `*_ALLOWED_ORIGIN` on admin/portal — the Vercel rewrite proxy makes the browser `Origin` (vercel.app) differ from the request host (railway.app); without the allowlist every mutation 403s.

## 2 · Vercel

Four projects from this repo (monorepo: set *Root Directory* per project;
Vercel installs the pnpm workspace from the repo root automatically).

| Project | Root | Notes |
|---|---|---|
| site | `apps/site` | zero-config static |
| host-demo | `apps/host-demo` | env **`VITE_GATEWAY_URL`** = gateway's public Railway URL. `vercel.json` builds the SDK first; `loader.js`/`panel.js` ship same-origin |
| admin | `apps/admin` | edit `vercel.json` → rewrite destination = admin service public URL |
| portal | `apps/portal` | edit `vercel.json` → rewrite destination = portal service public URL |

The rewrites are what keep the `SameSite=Strict` auth cookies same-origin —
do not point the SPAs at Railway directly.

## 3 · Smoke checklist (in order)

Steps 1, 3, and 4 are automated by `scripts/smoke.sh` (health + session posture
+ a full research turn). Run it against local (`scripts/smoke.sh`) or a live
gateway (`GATEWAY_URL=https://<gw> EXPECT_DEV=0 CHECK_SERVICES=0 scripts/smoke.sh`).
Steps 2, 5, 6 are UI and still need a human.

1. Every Railway service `/health` returns `ok:true` (intelligence shows `mode:"llm"` + your model)
2. Admin SPA: log in with the bootstrap operator → create a real partner (id, `pk_` key, JWT secret) + plan
3. Gateway: `POST /v1/session` **without** a token → 401 (dev mode is off)
4. host-demo: open → panel loads → ask "how is bitcoin doing" → skeleton → streamed deltas → brief with live stats
5. Portal: admin panel → partner detail → invite admin → open portal `#/claim` → claim → log in → rotate secret
6. Confirm the rotation audit row shows in the admin panel

## Costs (order of magnitude)

Railway hobby ~$5–20/mo for this footprint · OpenRouter pay-per-token
(a 30B-class open model runs pennies per hundred briefs; the answer cache
exists precisely to keep this small) · Vercel hobby free.

## Not in this deployment

`mock-gateway` (dev tool), Ollama (local dev)
(needs partner keys — Open Decisions #6/#9), OTel export (collector TBD).
