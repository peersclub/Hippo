# 🟢 Live Demo Status — shareable links

**As of:** July 22, 2026 · **Verified:** full loop over the wire against the public link — token endpoint → Bearer session mint → **"UNDERSTOOD" interpretation card** → streaming research brief (`anthropic/claude-haiku-4.5`) → prepared order ticket (`BUY · MKT`) → honest lifecycle (PLACED · WORKING → FILLED). Railway services running from main `8ffb707` (interpret flow #31 + honest lifecycle #29 + real-venue demo). **Critical prod fix now live:** the seam was never sending its internal token, so every cloud FILL had been silently 401ing since the #24 auth hardening — fixed in `61bb79b`, fills complete over the public link now. Demo partner identity is `assetworks-demo` (`418f7e1`) — the whole demo is Assetworks end to end.

> [!success] The whole app is live and shareable
> [PR #27](https://github.com/peersclub/Hippo/pull/27) (SDK partner-token session mint) merged; host-demo deployed with the AssetWorks host page; backend complete on Railway (intelligence + memory + Redis joined gateway/admin/portal/market-data/seam after the plan upgrade). Research briefs come from the real LLM — the degraded price-feed fallback is no longer the default path.

## Links for the team

| Surface | Link | Access |
|---|---|---|
| **Demo** (the main event) | https://hippo-host-demo.vercel.app | Open, click the **Ask Hippo** pill — no login |
| Test guide | https://hippo-host-demo.vercel.app/how | Open — walks every flow with expected results |
| Operator admin | https://hippo-admin-six.vercel.app | Login below |
| Partner portal | https://hippo-partner-portal.vercel.app | Login below |
| Marketing site | https://hippo-site.vercel.app | Open — no login |
| ↳ Design language | https://hippo-site.vercel.app/design | Open — the Dark Glass Instrument system, live token swatches |
| ↳ Product roadmap | https://hippo-site.vercel.app/roadmap | Open — shipped / in-progress / planned board |
| ↳ SDK integration | https://hippo-site.vercel.app/sdk | Open — one-tag embed + per-platform guides |

## Demo credentials

> [!note] Demo-environment credentials only
> These unlock demo data on the demo deployment — nothing real sits behind them. Both logins reset + verified live July 21. Each block below is copy-ready — hover a code block and click the copy icon in its corner. Rotate via the runbook below if this note's audience ever widens.

**Operator admin** — https://hippo-admin-six.vercel.app — Hippo's own ops view: partners, plans, users, audit

```
suresh.victor@askthehippo.com
```
```
HippoOps!2026
```

**Partner portal** — https://hippo-partner-portal.vercel.app — Assetworks' own view: MAU, integration, plan

```
admin@assetworks-demo.com
```
```
HippoPartner!2026
```

**Demo, test guide, marketing site** — no login.

**Prototype** (living spec) — https://project-iducy.vercel.app — access phrase managed by Ram, ask him directly.

**Rotate a password** (scrypt `salthex:keyhex`, shared scheme from `packages/stores/src/password.ts`):

```bash
HASH=$(node -e "const{scryptSync,randomBytes}=require('node:crypto');const s=randomBytes(16);console.log(s.toString('hex')+':'+scryptSync(process.argv[1],s,32).toString('hex'))" 'NewPassword')
psql "$DATABASE_PUBLIC_URL" -c "update admin_operators set password_hash='$HASH' where email='suresh.victor@askthehippo.com';"
# portal seat: same, against partner_admins where email='admin@assetworks-demo.com'
```

## Why the link is safe to share

- **Gateway stays locked** (`HIPPO_DEV=0`) — no anonymous session minting is exposed.
- Sessions mint through the demo token endpoint (`/api/token` on the host page): a Vercel function signs a short-lived HS256 JWT with the `assetworks-demo` partner secret, which never reaches the browser. This is the exact production trust topology — a real partner copies `apps/host-demo/api/token.ts` almost verbatim.
- Each visitor gets a cookie-stable identity (`sub`), so memory/persona and MAU counting behave like distinct real users. The pilot plan's 1000-MAU quota bounds usage.

## Backend topology (Railway, project `Hippo`)

| Service | State | Notes |
|---|---|---|
| gateway | 🟢 | https://gateway-production-2a3c.up.railway.app, `HIPPO_DEV=0` |
| intelligence | 🟢 | `mode=llm model=anthropic/claude-haiku-4.5` (OpenRouter) |
| memory | 🟢 | persona on Postgres |
| market-data · seam · admin · portal | 🟢 | unchanged from July 18 topology |
| Postgres + Redis | 🟢 | Redis backs the answer cache |

## Known issues

- **Railway builder bug (found + worked around Jul 20–21):** any workspace `package.json` with a `next` dependency silently crashes Railway's Metal builder — even Dockerfile builds of unrelated services die at "scheduling" with no logs. Proven by bisection builds (evidence IDs in commit `efcaf99`). Workaround: `apps/assetworks-exchange` (Next 15 test host) lives on branch **`assetworks-exchange-app`**, not main. Restore after Railway fixes their scanner — worth a support ticket at station.railway.com.
- **Main CI green** again as of [PR #29](https://github.com/peersclub/Hippo/pull/29) (fixed the vercel.json format drift + the CLI typecheck flake — first fully-green run since July 19). Note the `Lint (biome)` job is intentionally non-blocking (`continue-on-error`); only `Build & test` gates merges.
- OpenRouter key rotation still pending (same key as `.env`).

## Redeploy runbook (any of the four frontends)

```bash
cd apps/<host-demo|admin|portal|site>
vercel pull --yes --environment=production
vercel build --prod && vercel deploy --prebuilt --prod
```

Gotcha: project env vars are *sensitive* — `vercel pull` writes `"[SENSITIVE]"`, which breaks build-time `VITE_*` bakes. Patch `.vercel/.env.production.local` with the real value before `vercel build` (runtime-only secrets like `HIPPO_DEMO_JWT_SECRET` are unaffected).

Related: [[Home]] · [[Roadmap]] · [[12 Partner Admin Portal]]
