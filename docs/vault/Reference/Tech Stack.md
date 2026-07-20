# Hippo — Tech Stack (summary)

**Snapshot:** July 20, 2026 · `hippo-app@main` (`19e79f5`). One-page reference for every language, runtime, framework, datastore, and version in the system. Numbers are read from the repo's `package.json` / `requirements.txt`, not from memory. For the design intent behind these choices see [[09 FE Architecture]] and [[10 BE Architecture]]; for per-service as-built detail see [[Development Documentation]].

## TL;DR

- **Monorepo:** pnpm + Turborepo, mostly **TypeScript on Node 24**; one **Python/FastAPI** service (intelligence) and the evals harness sit outside the JS graph.
- **Backend services:** Fastify 5 (Node).
- **Frontends:** the embedded **SDK is Preact**; the Assetworks host app is **Next.js 15 / React 19**; the admin/portal/site SPAs are **Vite + Preact**.
- **Database:** **PostgreSQL** (via `pg`, plain numbered-SQL migrations — no ORM). **Redis** for the session journal + answer cache in production.
- **AI serving:** Ollama (dev) → vLLM (planned prod) → **OpenRouter / `claude-haiku-4.5`** (live cloud today).

## Runtimes & languages

| Thing | Version | Notes |
|---|---|---|
| **Node.js** | **`>=24`** (running `24.10.0`) | `engines.node` in root `package.json`; CI pins `node-version: 24` |
| **TypeScript** | `^5.8` | strict; the whole JS workspace |
| **Python** | **3.12+** (dev venv on `3.14.3`) | only `services/intelligence` + `evals/` |
| **pnpm** | **`10.18.0`** | `packageManager` field — the pinned package manager |

## Build & tooling

| Tool | Version | Role |
|---|---|---|
| **Turborepo** | `^2.5` | task orchestration (`turbo run build/test/dev`) |
| **Biome** | `^2.0` | lint + format (replaces ESLint/Prettier); `docs/vault` + `apps/assetworks-exchange` excluded |
| **Vite** | `^7.0` | dev server + build for the SPAs and the SDK bundle |
| **Zod** | `^4.0` | the card protocol contract (`packages/protocol`) — runtime-validated schemas |

## Backend services (all TypeScript / Node unless noted)

| Service | Port | Framework / key deps |
|---|---|---|
| `gateway` | 8788 | **Fastify `^5.4`**, `ioredis ^5.11`, `pg ^8.13`, OpenTelemetry (`api ^1.9`, `sdk-metrics/trace ^2.0`) |
| `mock-gateway` | 8787 | Fastify 5 (SSE golden-conversation player) |
| `market-data` | 8790 | Fastify 5 + **CCXT `^4.4`** |
| `intelligence` | 8791 | **Python 3.12+ / FastAPI `>=0.115`**, `uvicorn >=0.30`, `httpx >=0.27`, `redis >=5.0` |
| `memory` | 8792 | Fastify 5 + `pg` (opt-in persona store) |
| `seam` | 8793 | Fastify 5 (canonical trading interface + venue adapters) |
| `admin` | 8794 | Fastify 5 + `pg` (operator console API) |
| `portal` | 8795 | Fastify 5 + `pg` (partner self-serve API) |
| `host-venue` | 8796 | Fastify 5 (Assetworks test venue; HMAC-signed wire + fill engine) |

## Frontend apps & the SDK

| App | Port | Stack |
|---|---|---|
| **SDK** (`packages/sdk`) | — (embed) | **Preact `^10.26`** + `@preact/signals ^2.0`, closed Shadow DOM, two-stage loader (~1.1KB gz), built with Vite/esbuild |
| `assetworks-exchange` | 4001 | **Next.js `15.5.4`** (App Router) · **React `19.1`** · **Tailwind v4** · **Zustand `^5.0`** · **ECharts `^5.6`**. Clean-boundary: imports zero Hippo packages |
| `admin` | 5175 | Vite `^7` + Preact (operator console UI) |
| `portal` | 5176 | Vite `^7` + Preact (partner portal UI) |
| `site` | 5174 | Vite `^7` (marketing site + `/design`, `/sdk`) |
| `host-demo` | 4000 | Vite `^7` (vanilla host page; serves the SDK `/loader.js`) |

## Data stores

| Store | Technology | What lives there |
|---|---|---|
| **Primary DB** | **PostgreSQL** (`pg ^8.13`, no ORM) | Durable business entities in `packages/stores`: partners, plans, users, MAU events, operators, partner-admin logins, persona/memory — via numbered SQL migrations `001`–`008` (`packages/stores/migrations/*.sql`, applied by a minimal `migrate.ts` runner) |
| **Cache / streams** | **Redis** (`ioredis ^5.11` in Node; `redis >=5.0` in Python) | Answer cache (`cache:{q}:{asset}:{window}`, volatility-scaled TTL) and the SSE frame journal (`session:{id}:frames`). Dev uses in-memory doubles; `fakeredis` for cache tests |
| **Market data** | CCXT (no persistence) | Read-through live price/funding/snapshot; never cached with user data |

Migrations are just numbered `.sql` files applied in filename order and recorded in `schema_migrations` — "no ORM, no migration framework: numbered SQL files are the whole story." Next up is `009` (Tier-2 durable seam audit + ticket routing).

## AI / LLM serving

| Stage | Serving | Model |
|---|---|---|
| **Dev (local)** | **Ollama** | `qwen3:4b` (first byte ~4ms, full brief ~5s measured) |
| **Prod (planned)** | **vLLM** | intent on a regional 7–8B pod; research on the global ~30B bake-off winner |
| **Cloud (live today)** | **OpenRouter** | `anthropic/claude-haiku-4.5` (`mode=llm`; the model tag is forwarded end-to-end onto `brief_delta` frames) |

Swapping serving is config-only (`LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`); a deterministic **mock** provider means the service never 500s when a model is down.

## Deployment

- **Railway** — the backend services (per-service Dockerfiles in `deploy/docker/`) + managed **Postgres** + **Redis**. Private networking is IPv6-only, so services listen dual-stack `::`.
- **Vercel** — the frontends (admin, portal, site, host-demo), deployed as prebuilt static dirs.
- Not yet wired to cloud: `host-venue` + `assetworks-exchange`. Full URLs/env/secrets: the deployment note.

## Intent vs. reality

This doc is the **as-built** stack. Where it diverges from the locked plan in [[09 FE Architecture]] / [[10 BE Architecture]], reality wins here — the clearest example is LLM serving: the plan says vLLM/Qwen3, but the live cloud runs `claude-haiku-4.5` via OpenRouter.

Related: [[Development Documentation]] · [[09 FE Architecture]] · [[10 BE Architecture]] · [[Data Model — ER Diagram]] · [[Home]]
