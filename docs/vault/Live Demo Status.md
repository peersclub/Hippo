# 🟢 Live Demo Status — shareable links

**As of:** July 20, 2026 · **Verified:** full loop over the wire against the public link — token endpoint → Bearer session mint → streaming research brief (`anthropic/claude-haiku-4.5`) → prepared order ticket (`BUY · MKT 0.05 BTC / USDT`)

> [!success] The whole app is live and shareable
> [PR #27](https://github.com/peersclub/Hippo/pull/27) (SDK partner-token session mint) merged; host-demo deployed with the AssetWorks host page; backend complete on Railway (intelligence + memory + Redis joined gateway/admin/portal/market-data/seam after the plan upgrade). Research briefs come from the real LLM — the degraded price-feed fallback is no longer the default path.

## Links for the team

| Surface | Link | Access |
|---|---|---|
| **Demo** (the main event) | https://hippo-host-demo.vercel.app | Open, click the **Ask Hippo** pill |
| Test guide | https://hippo-host-demo.vercel.app/how | Walks every flow with expected results |
| Operator admin | https://hippo-admin-six.vercel.app | `suresh.victor@askthehippo.com` (password was in the ephemeral July 18 scratchpad — needs a reset if lost) |
| Partner portal | https://hippo-partner-portal.vercel.app | Demo seat `admin@koinbx-demo.com` |
| Marketing site | https://hippo-site.vercel.app | Open |

## Why the link is safe to share

- **Gateway stays locked** (`HIPPO_DEV=0`) — no anonymous session minting is exposed.
- Sessions mint through the demo token endpoint (`/api/token` on the host page): a Vercel function signs a short-lived HS256 JWT with the `koinbx-demo` partner secret, which never reaches the browser. This is the exact production trust topology — a real partner copies `apps/host-demo/api/token.ts` almost verbatim.
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

- **Main CI red** (as of the July 20 merge, inherited from the AssetWorks push whose own run was cancelled): 7 biome formatting errors + 1 failing CLI codegen test (`init-mapping.test.ts` typecheck). Deployed product unaffected.
- Operator admin password lost with the ephemeral scratchpad — reset needed before handing admin to anyone.
- OpenRouter key rotation still pending (same key as `.env`).

## Redeploy runbook (any of the four frontends)

```bash
cd apps/<host-demo|admin|portal|site>
vercel pull --yes --environment=production
vercel build --prod && vercel deploy --prebuilt --prod
```

Gotcha: project env vars are *sensitive* — `vercel pull` writes `"[SENSITIVE]"`, which breaks build-time `VITE_*` bakes. Patch `.vercel/.env.production.local` with the real value before `vercel build` (runtime-only secrets like `HIPPO_DEMO_JWT_SECRET` are unaffected).

Related: [[Home]] · [[Roadmap]] · [[Jul 20 Dev]] · [[12 Partner Admin Portal]]
