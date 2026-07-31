# 🟢 Live Demo Status — shareable links

**As of:** July 31, 2026 (evening) · **✅ Host interaction wave LIVE (2026-07-31 evening, PRs [#75](https://github.com/peersclub/Hippo/pull/75)–[#79](https://github.com/peersclub/Hippo/pull/79)):** Hippo can now **drive the host page's chart** — "switch the chart to 5m" / "apply RSI" → `host_action` frame → origin-gated postMessage the host applies and acks, with an in-thread pending → applied / failed / no-response chip. Strictly opt-in at every layer (`data-hippo-page-control` on the embed → `pageControl` on the context uplink → only then does the gateway emit; a host that never asked can never be driven). Plus a **consolidated orders view** ("show all my orders" → one `orders_summary` card: Working/Filled/Cancelled totals, newest-first rows, fill bars) and a **durable upload library** ([#77](https://github.com/peersclub/Hippo/pull/77), migration 016): uploads persist keyed by effective identity (sign in elsewhere → files follow) with in-thread file chips + a Files view. **Verified live over the public wire 2026-07-31:** pageControl context → "switch the chart to 5m" → `host_action {action:"set_timeframe", timeframe:"5m"}`; "show all my orders" → `orders_summary {scope:"all"}` with real order rows. Migration 016 applied before deploy; gateway + seam + intelligence + host-venue redeployed (`--detach`); SDK/host-demo/site auto-deployed on the merge push. · **✅ Dynamic wave LIVE (2026-07-31, PRs [#70](https://github.com/peersclub/Hippo/pull/70)–[#74](https://github.com/peersclub/Hippo/pull/74)):** the panel now supports **claimed identity** (username + 4-digit PIN inside the panel — memory follows the person across browsers; create/sign-in/sign-out in settings; scrypt PINs, rate-limited, migration 015 applied), **file upload** (paperclip → CSV portfolio analysis or image vision Q&A, answered as a guardrailed research brief with honest received→analyzing status), **per-use-case loaders** (stepped order-confirm loader, analyzing shimmer), and an **operator Tech page** in admin (p50/p95 first-token + turn latency, classified call log, live sessions/SSE connections, uplinks/min, LLM mode — in-memory, resets on restart). **All verified live over the public wire 2026-07-31**: identity create→ok / wrong-PIN→rejected / fresh-session sign-in→same identity; CSV upload 202 → received → analyzing → real streamed brief; operator login → live telemetry. Gateway + intelligence + admin redeployed (Railway `--detach` workaround for the CLI status-stream timeout); host-demo + admin app auto-deployed on merge. · **✅ Live AI restored** — fresh OpenRouter `LLM_API_KEY` set on intelligence + redeployed; briefs are back to the real model (`anthropic/claude-haiku-4.5`), verified over the wire. · **Verified:** full loop over the wire against the public link — token endpoint → Bearer session mint → **"UNDERSTOOD" interpretation card** → streaming research brief (`anthropic/claude-haiku-4.5`) → **editable order-draft card** (leverage slider / price input / symbol·type·margin dropdowns) → prepared ticket → honest lifecycle (PLACED · WORKING → FILLED). **Positions sustained — venue persistence LIVE (2026-07-29, [PR #68](https://github.com/peersclub/Hippo/pull/68)):** Victor reported positions vanishing; root cause was the host-venue's book of record being pure in-memory (a container restart at 07:51 wiped everything — Railway restarts happen on deploys/maintenance/crashes). The venue's full state (positions, resting orders, wallets, drawer config, order-id counter) now persists to Postgres (`host_venue_state`, migration 014, debounced JSONB snapshot, restore-on-boot; `DATABASE_URL` on host-venue). **Verified live: opened `BTC-USDT long 0.05 @10x` → restarted the venue container → position still there.** Deploy-order rule: migration BEFORE deploy (boot-time load failure is deliberately fatal). Wallet reset remains the deliberate clean slate. **Tier-2 durability LIVE (2026-07-29, #64/#65):** gateway now runs `sessions="redis"` (`REDIS_URL` set) — sessions + frame journals survive restarts (cold resume verified live), ticket routing is a TTL'd Redis key (**venue event routed +14.9s after a fresh gateway boot, on a ticket prepared before the restart — the exact case that used to silently drop fills**), and seam audit persists to Postgres (`seam_audit`, migration 013, `DATABASE_URL` now on seam). CLI stage-4 model codegen also shipped (#66, build-time tool, hermetic in CI). Known quirk noticed en route: the host venue's **perp limit orders fill immediately** at their rate instead of resting (spot limits rest correctly) — sim fill-engine behaviour, worth a future look. **Sync audit fixes live (2026-07-28, #60–#63):** close/reduce orders now bypass the draft card (verified live: open 0.05 BTC long → FILLED → "close long 0.05 BTC" → `CLOSE LONG 10× · MKT` ticket, **no draft** — the pre-fix flow would have OPENED a second position); host settings gained the Hippo price-source control; admin gained learned-facts visibility + audited purge (routes verified live, 401 on unauth). Railway services running from main `b0e03ab` (interpret flow #31 + **4-level layered memory A–D #31–#34** + **auto-learning memory A–D COMPLETE #37–#50** + **interactive order card + live price #55–#58** + honest lifecycle #29 + real-venue demo). Gateway redeployed for the order card; SDK/host-demo via auto-deploy. **NEW verified live (2026-07-28):** mint with `symbol:"ETH/USDT"` → transient ETH `price_tick`s every ~4s (proven outside the resume journal); "long 0.5 BTC 10x" → prefilled draft (venue max 50×) → edited submit (0.3 BTC · 20× · cross · LMT 60,000) → matching ticket; tampered leverage 999 → server rejection; host `postMessage` bridge forwards the exact header ticker (`?pair=ETH/USDT` keys the panel). **Verified live (2026-07-27):** mixed PII+preference turn stored only trading facts (0 PII); the "Remember my preferences" opt-out clears+stops learning and resumes when re-enabled. Also: **Open-orders blotter empty-state** reworded (#46) so a filled market order no longer reads as "broken". **Layered memory now live (pre-prod):** 4 scopes (PLATFORM/VENUE/USER/SESSION) compose into the answer prompt beneath the no-advice guardrail, gated behind plan entitlement `memoryLab` (demo's `pilot` plan has it on); super-admin edits them in admin **Memory Config**, and the **Session** tab inspects the exact composed block sent. **Deploy note:** host-demo git-integration was fixed (#36, `0f94559`) — the `vercel.json` buildCommand now builds `@hippo/protocol` before `@hippo/sdk`, so pushing to main auto-deploys host-demo (~28s), how the `/how` memory docs went live. Demo partner identity is `assetworks-demo` (`418f7e1`) — the whole demo is Assetworks end to end.

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

- **✅ RESOLVED (2026-07-27) — OpenRouter key rotated:** the earlier 401-on-chat-completions (→ mock) is fixed; a fresh `LLM_API_KEY` was set on the intelligence service and it redeployed. Live briefs verified `model: anthropic/claude-haiku-4.5`. *(Key was shared in chat — worth rotating again if that transcript is retained.)*
- **✅ Phase B VERIFIED LIVE (2026-07-27):** full end-to-end over the public wire — a preference stated twice in a session promotes to durable USER scope; a fresh session for the same user composes it in (`memoryScopes:["platform","user"]`, `[USER PROFILE]` block, `learned_memory` frame with labeled facts); `clearLearnedMemory` wipes user+session facts (4→0) and emits an empty frame. A live clear bug was found + fixed en route ([PR #45](https://github.com/peersclub/Hippo/pull/45): the DELETE 400'd on an empty JSON body — same fastify gotcha as the persona clear).

- **✅ RESOLVED (2026-07-28) — all symbols live (was BTC-only):** market-data now uses **Binance.US** (`MARKET_EXCHANGE`-configurable, default `binanceus`) instead of Binance.com, whose public API geo-blocked Railway's US region (had left only a fixture BTC; ETH/SOL were `snapshot unavailable`). Verified live: BTC/ETH/SOL all return real prices (`sources:['BINANCEUS PUBLIC']`, BTC now live ~63.6k not the old fixture), ETH research returns a real brief, and `buy 0.5 ETH` prepares an order_ticket (was a rejection). Funding is `null` (Binance.US is spot-only — degrades gracefully). [PR #52](https://github.com/peersclub/Hippo/pull/52). Flip `MARKET_EXCHANGE` to kraken/coinbase/etc. (no code change) if a region ever needs a different reachable source.
- **Memory now verified LIVE (2026-07-24):** after redeploying the backends to `fa70e57` + applying migration 011, auto-learning + 4-level compose confirmed on the public demo (learned `BTC·perps·10x·concise`, composed into the next turn). Earlier "memory not showing up" was stale backends — see [[project-hippo-deployment]]: **Railway backends do NOT auto-deploy on push and migrations do NOT run on boot; redeploy + migrate manually after backend merges.**
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
