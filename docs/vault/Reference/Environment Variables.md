---
title: Hippo Environment Variables — shareable setup reference
type: reference
tags: [setup, env, configuration, onboarding, dev]
updated: 2026-08-10
sources:
  - "hippo-app/.env.example (canonical template — this note tracks it)"
  - "hippo-app/turbo.json globalPassThroughEnv"
safe_to_share: true
---

# Hippo — Environment Variables

Everything a new developer needs to bring the Hippo stack up locally. **No real
secrets live in this note** — every credential below is a placeholder. Real
values are handed over separately (see [Getting the real secrets](#getting-the-real-secrets)).

> [!warning] Never paste real values into this vault
> This vault syncs through iCloud and gets shared. Real keys belong in
> `hippo-app/.env` (gitignored) or in the Railway / Vercel dashboards — nowhere else.

## How it loads

Copy the template and fill it in:

```bash
cd hippo-app
cp .env.example .env
```

Three things worth knowing before you debug a "my change did nothing" moment:

- The root `pnpm dev` script **sources `.env` before turbo runs**. Every var here
  is declared in `turbo.json`'s `globalPassThroughEnv`; a var missing from that
  list never reaches the service processes.
- **Every service reads env once at boot.** Changing a value needs a full
  `pnpm dev` restart, not a hot reload.
- **Everything is optional.** With an empty `.env` the stack still comes up: the
  LLM falls back to a deterministic mock, stores fall back to in-memory (wiped on
  every restart), and token-gated admin surfaces stay disabled. That is the
  fastest path to a first look.

## LLM provider — `services/intelligence`

Any OpenAI-compatible `/v1/chat/completions` endpoint works: OpenRouter, vLLM, or
a local Ollama at `http://localhost:11434/v1` (no key needed). Without a reachable
endpoint the provider router serves mock briefs and `/health` reports `mode=mock`.

```bash
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=anthropic/claude-haiku-4.5
LLM_API_KEY=sk-or-v1-REPLACE-ME          # secret — request separately

# LLM_TIMEOUT=30          # generic LLM call deadline (seconds)
# LLM_INTENT_TIMEOUT=2    # intent-path deadline — must sit inside the
                          # gateway's 3s /v1/intent budget
```

`LLM_INTENT_TIMEOUT` has to stay strictly under the gateway's 3s intent budget,
otherwise the gateway times out first and the intelligence service's own timeout
never fires — you lose the fallback path.

## Durable stores — admin, memory, gateway MAU, portal

Postgres with the migrations applied. Unset means in-memory stores: fine for a
quick look, wiped on restart.

```bash
createdb hippo && pnpm --filter @hippo/stores migrate
```

```bash
DATABASE_URL=postgres://hippo:hippo@localhost:5432/hippo

# REDIS_URL=redis://localhost:6379    # answer cache; unset = in-process cache
```

## Service-to-service auth

Shared secret guarding gateway `/internal/sessions` and memory `/admin/*`. These
surfaces are **fail-closed**: they return `503` until it is set. Generate your own,
it does not need to match anyone else's for local dev:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

```bash
INTERNAL_API_TOKEN=                      # secret — generate your own
```

## Admin panel — `services/admin` :8794, UI :5175

```bash
ADMIN_BOOTSTRAP_EMAIL=admin@hippo.local
ADMIN_BOOTSTRAP_PASSWORD=change-me       # secret — pick your own
ADMIN_ALLOWED_ORIGIN=http://localhost:5175
# ADMIN_JWT_SECRET=
```

The bootstrap operator is created **only while the operator table is empty** — once
you have logged in once, changing these two values does nothing. Reset by clearing
the operator table.

`ADMIN_ALLOWED_ORIGIN` is not optional in practice: the UI on `:5175` calls the API
on `:8794` cross-origin, and the CSRF origin check `403`s browser logins without it.

`ADMIN_JWT_SECRET` unset means an ephemeral per-boot secret — operator sessions die
on restart, which is honest and safe for dev.

## Partner portal — `services/portal` :8795

```bash
# PORTAL_JWT_SECRET=
# PORTAL_API_URL=
# PORTAL_ALLOWED_ORIGIN=
# PORTAL_COOKIE_SECURE=
```

## Service URL overrides

Defaults are the local ports; set these only to point a service somewhere else.

```bash
# GATEWAY_URL=http://localhost:8788
# MEMORY_URL=http://localhost:8792
# MARKET_DATA_URL=http://localhost:8790
# INTELLIGENCE_URL=http://localhost:8791
# ADMIN_API_URL=http://localhost:8794
# HIPPO_SDK_URL=
```

## Misc

```bash
# LOG_LEVEL=info        # fleet-wide (debug|info|warn|error) — honored by every
                        # fastify service and by uvicorn + the intelligence
                        # service's app loggers
# FIXTURES=1            # market-data serves fixtures instead of live CCXT
# VENUE=sim             # seam venue adapter: sim | assetworks
# HIPPO_DEV=1           # anonymous sessions for the pk_demo embed
# HIPPO_OTEL=1          # OpenTelemetry export (services/intelligence)
```

> [!important] `HIPPO_DEV` is local-only
> It enables anonymous sessions for the `pk_demo` embed. **Production must not set
> it** — prod is JWT-only.

## Assetworks Exchange test host — `services/host-venue` :8796

A self-contained venue that speaks the signed trade wire and streams live Binance
**public** data, so the parasite integration exercises real HMAC-signed rails
instead of a stub. Set `VENUE=sim` to detach the host again.

```bash
# VENUE=assetworks
# ASSETWORKS_API_KEY=ak_assetworks_demo
# ASSETWORKS_SECRET=sk_assetworks_demo_secret       # host + adapter must match
# ASSETWORKS_BASE_URL=http://localhost:8796
# ASSETWORKS_CONFIRM_SURFACE=api                    # api | js_callback (admin switch is live)
# ASSETWORKS_WORKING_WINDOW_MS=2500                 # must be >= seam poll interval (2000)
# ASSETWORKS_FEE_RATE=0.001
# ASSETWORKS_PARTIAL_FILLS=1                        # two-step fills to exercise PARTIAL
# ASSETWORKS_ADMIN_TOKEN=                           # guards /admin mutations (open if unset)
```

The `ak_assetworks_demo` / `sk_assetworks_demo_secret` pair is a **local test
credential shipped in the template** — it is not a real secret, but the host and
the adapter have to carry the same value or every signed request fails HMAC
verification.

`ASSETWORKS_CONFIRM_SURFACE` here is only a fallback for when the host admin config
is unreachable; at confirm time the host's admin drawer is authoritative.

## Assetworks Exchange frontend — branch `assetworks-exchange-app` :4001

```bash
# HOST_VENUE_URL=http://localhost:8796                          # Next /venue/* proxy target
# NEXT_PUBLIC_HIPPO_LOADER_URL=http://localhost:4000/loader.js  # SDK loader (served by host-demo)
# NEXT_PUBLIC_HIPPO_GATEWAY=http://localhost:8788
# NEXT_PUBLIC_HIPPO_KEY=pk_demo
```

> [!note] This app lives on its own branch, not `main`
> Any workspace `package.json` with a `next` dependency silently crashes Railway's
> Metal builder — verified 2026-07-20 by bisection builds. Restore it to `main`
> once Railway fixes their repo scanner.

## Vercel apps — `apps/portal`, `apps/host-demo`, `apps/site`

Each has its own `.env.local` written by the Vercel CLI, containing a
`VERCEL_OIDC_TOKEN`. **Do not copy these between machines** — run `vercel link`
and `vercel env pull` and the CLI mints your own. They expire.

## Production

Production values are **not** in any file in the repo. They live in the Railway
service variables and the Vercel project environment variables. Same key names,
different values — plus these differences:

| Var | Local | Production |
|---|---|---|
| `HIPPO_DEV` | `1` | **unset** (JWT-only) |
| `DATABASE_URL` | localhost Postgres | managed Postgres |
| `ADMIN_ALLOWED_ORIGIN` | `http://localhost:5175` | the deployed admin origin |
| `PORTAL_COOKIE_SECURE` | unset | `1` |
| `INTERNAL_API_TOKEN` | your own | rotated, ops-held |

See [[🟢 Live Demo Status]] for the deployed URLs.

## Getting the real secrets

Three values in a working `.env` are genuine secrets and are **never** written down
in this vault or the repo:

1. `LLM_API_KEY` — an OpenRouter key. Make your own free key at
   [openrouter.ai/keys](https://openrouter.ai/keys), or ask Victor for a shared one.
2. `INTERNAL_API_TOKEN` — generate your own with the `secrets.token_urlsafe(32)`
   command above; it only has to be consistent across the services you run.
3. `ADMIN_BOOTSTRAP_PASSWORD` — pick your own, it seeds only your local DB.

For production credentials, ask for Railway and Vercel project access rather than
having values pasted to you. Send anything that must be handed over through a
one-time secret link, not chat or email.

## Related

- [[Development Documentation]] — service map and ports
- [[Tech Stack]]
- [[🟢 Live Demo Status]] — deployed URLs
