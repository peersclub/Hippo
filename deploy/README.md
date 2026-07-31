# Deploy — Railway (services) + Vercel (frontends)

The eight backend services run on **Railway** (project `Hippo`,
`3d1bfe4a-2dbe-47d2-8ca6-8dde97c9f2dd`, environment `production`); the four
frontends deploy to **Vercel** with git integration (push to `main` →
auto-deploy). **Railway services do NOT auto-deploy on push** — see the
recipe below.

## Config as code

Each service's build/deploy spec is committed at `deploy/railway/<service>.json`
(Dockerfile path, `/health` healthcheck, on-failure restart policy). Railway
reads it once the service's **Settings → Config-as-code file path** points at
that file — a one-time dashboard step per service; after that, changes to the
spec ride the repo. The Dockerfiles live in `deploy/docker/`.

> Historical gotcha: builds were previously selected via the
> `RAILWAY_DOCKERFILE_PATH` service variable. The committed config files
> replace that — remove the variable once the config path is set, so there is
> one source of truth.

## Services (Railway)

| Service | Port | Public URL | Purpose |
|---|---|---|---|
| gateway | 8788 | https://gateway-production-2a3c.up.railway.app | partner-facing sessions/SSE/turns |
| admin | 8794 | (via admin app `/api/*` rewrite) | operator API |
| portal | 8795 | (via portal app `/api/*` rewrite) | partner-admin API |
| seam | 8793 | internal only | canonical trading interface |
| memory | 8792 | internal only | persona + layered memory |
| intelligence | 8791 | internal only | intent/research (Python) |
| market-data | 8790 | internal only | CCXT snapshots (`MARKET_EXCHANGE=binanceus`) |
| host-venue | 8796 | https://host-venue-production.up.railway.app | Assetworks demo venue |

Inter-service URLs use `*.railway.internal` (IPv6-only private net — services
bind `::`). Postgres + Redis are Railway plugins; the public DB URL comes from
`railway variables --service Postgres --kv | grep DATABASE_PUBLIC_URL`.

### Key environment variables

Not exhaustive — the boot-time source of truth is each service's env handling.

- **all TS services**: `INTERNAL_API_TOKEN` (shared internal-surface guard,
  fail-closed), `DATABASE_URL` where durable stores apply
- **gateway**: `REDIS_URL` (sessions/journals/ticket routing),
  `INTELLIGENCE_URL`, `MEMORY_URL`, `SEAM_URL`, `HIPPO_DEV` (opt-in `=1`,
  never in prod), `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW`
- **admin / portal**: `ADMIN_JWT_SECRET` / `PORTAL_JWT_SECRET` (fail-loud in
  prod), `*_ALLOWED_ORIGIN` (CORS for the Vercel apps), `GATEWAY_URL`,
  `INTELLIGENCE_URL` (admin), `RATE_LIMIT_*`
- **seam**: `VENUE` (`sim` | `assetworks`), `ASSETWORKS_API_KEY/_SECRET/_BASE_URL`,
  `GATEWAY_URL` (callback SSRF allowlist seed)
- **intelligence**: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` (OpenRouter —
  if briefs read `model:"mock"` with `cached:false`, check for 401s here),
  `MARKET_DATA_URL`, `LLM_STREAM_USAGE` (`0` only if the LLM server rejects
  `stream_options.include_usage`)
- **host-venue**: `DATABASE_URL` (durable book of record), `INTELLIGENCE_URL`
  (AI-model proxy)

## Deploy recipe (manual, per service)

From a clean checkout of `origin/main`:

```sh
railway link -p 3d1bfe4a-2dbe-47d2-8ca6-8dde97c9f2dd -e production -s <service>
railway up --service <service> --ci --detach
railway logs -d <deployment-id> --lines 3   # until the boot line appears
```

- `--detach` matters: the CLI's status stream can time out in some
  environments while the upload actually succeeded — every "failed" retry
  triggers another build.
- `railway up` from an **unlinked** directory silently creates a stray
  project. Always link first.

## Migrations

Migrations are **never** run on service boot. Apply before deploying the
service that needs them:

```sh
DATABASE_URL=<public-postgres-url> pnpm --filter @hippo/stores migrate
```

Staleness check: compare `select name from schema_migrations` against
`packages/stores/migrations/`.

## Local stack (docker compose)

`deploy/docker-compose.yml` (run from the repo root):

```sh
docker compose -f deploy/docker-compose.yml up -d                      # postgres + redis + migrations
docker compose -f deploy/docker-compose.yml --profile services up -d  # + all 8 services (container parity)
```

Default profile is infra-only — `pnpm dev` runs the services faster
un-containerized; the `services` profile builds every Dockerfile for parity
runs. Local-only credentials; intelligence boots in mock mode without an
LLM key. Authored on a machine without Docker — first `--profile services`
run may need port/env touch-ups.

## Cross-process rotate/suspend enforcement

`scripts/rotate-suspend-e2e.sh` proves the trust boundary across processes:
a portal-side secret rotation and an admin-side suspend are both enforced by
the gateway on its very next session mint (shared Postgres is the fabric).
Creates a throwaway `e2e-rotate-<epoch>` partner and leaves it suspended as
an audit-visible record. **Verified against the live stack 2026-07-31**
(mint 200 → rotate → old 401 / new 200 → suspend → 401). Point the env vars
at the compose stack for local runs.

## Frontends (Vercel)

| App | URL | Root |
|---|---|---|
| host-demo (the demo) | https://hippo-host-demo.vercel.app | `apps/host-demo` |
| admin panel | https://hippo-admin-six.vercel.app | `apps/admin` |
| partner portal | https://hippo-partner-portal.vercel.app | `apps/portal` |
| marketing site | https://hippo-site.vercel.app | `apps/site` |

All four auto-deploy from `main` (each app dir has its own `vercel.json`;
admin/portal proxy `/api/*` to Railway). The repo-root Vercel project
(`hippo-app`) is deliberately git-disconnected — don't reconnect it.
