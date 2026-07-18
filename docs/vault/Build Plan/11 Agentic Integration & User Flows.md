# 11 · Agentic Integration & User Flows

**The thesis:** [[05 Agentic Installer — Hippo CLI|Build Plan 05]] designs *our* agent — `hippo init` understands the partner and generates the integration. This doc designs the **other three quarters of the loop**: (1) the provisioning handshake between that CLI and Hippo cloud, (2) the assumption that the partner's "engineer" is increasingly *their* AI agent — so the whole integration must be **agent-legible**, and (3) the end-user flows that must exist on the other side, including every failure state the admin panel can now trigger (suspend, block, quota, session revoke).

**Planned:** 2026-07-16 · grounded in what is live on `main` (scan v0, conformance verifier, codegen stages 1–4, KoinBX golden adapter, gateway enforcement, admin panel + provisioning stores, Redis sessions).

---

## Actors & trust boundaries

| Actor | Runs where | Trusts |
|---|---|---|
| **Integrator** — partner engineer *or their coding agent* (Claude Code/Cursor) | Partner's repo + env | Hippo CLI artifacts; reviews every PR |
| **Hippo CLI** (`hippo scan/register/init/conform`) | Partner's environment — secrets never leave it | Hippo cloud provisioning API (token-scoped) |
| **Hippo cloud** — gateway(s), intelligence, seam, memory, **provisioning API** | Our pods | Partner JWTs (per-partner secret), internal tokens |
| **Hippo operator** | Admin panel (:5175 → services/admin) | The audit trail; approval gates |
| **End user** (trader) | Partner's page, SDK shadow DOM | The venue's brand; Hippo's product law (explain, never advise) |

Design law carried through everywhere: **the agent proposes, people approve** — every mutation is a PR (partner side) or an audited operator action (our side).

---

## A. The agentic integration journey — seven steps

### Step 0 — Agent-legibility substrate ⬜ *(new; cheap; highest leverage)*
The partner's integrator is assumed to be an agent. Make every surface machine-consumable:
- `--json` output mode on every CLI command (scan/conform/init emit structured artifacts already — expose them as the primary interface, human report as the rendering).
- `docs.hippo.dev/llms.txt` + an **integration SKILL.md** shipped in the CLI package: the exact step order, artifact schemas, and recovery actions — so a partner-side Claude/Cursor can drive the whole flow unattended.
- **`hippo-mcp`**: thin MCP server wrapping scan/register/init/conform as tools. A partner's agent adds one MCP server and can integrate an exchange without ever shelling out.
- Every command idempotent + checkpointed (BP05 already promises this per stage) and every output ends with `next_action` — agents resume; they don't re-plan.

### Step 1 — Discover ✅ `hippo scan <domain>`
Read-only crawl + API-doc ingestion → Integration Report + draft `adapter.config.yaml` + **gap list** (the memo's "production-grade trading API" criterion, measured not asked). This is the pre-sales artifact: *"here's your integration, 80% done, before you've signed."*

### Step 2 — Provision ⬜ **the missing handshake**
Today a partner exists only when an operator creates it in the admin panel. Agentic integration needs a self-serve sandbox lane:
- `hippo register --sandbox` → **provisioning API on services/admin** (`POST /v1/provision/sandbox`, rate-limited, email-verified) creates a partner row (status `sandbox`) via the same `PartnerStore` + audit trail the panel uses.
- Returns: `partnerId`, `pk_sandbox_…` embed key, **one-time claim URL** for the `jwtSecret` (fetched once, printed to the partner's vault/env — never written to the repo; BP05 safety rail "secrets never leave the partner's environment" becomes mechanical).
- Going live is NOT self-serve: operator flips `sandbox → active` + assigns a plan in the admin panel (dual sign-off, audited). Requires adding a third partner status `sandbox` to the store/gateway (sandbox keys only work against the sandbox gateway).

### Step 3 — Generate 🚧 `hippo init` (in partner repo, output = PR)
Exists: `adapter.config.yaml` (deterministic) → `mapping.ts` + `rejections.yaml` (stage 4). To finish:
- **Adapter emit** — generate `<venue>-venue.ts` against the CTI using the hand-built KoinBX adapter as the golden pattern; dogfood = regenerate KoinBX blind, diff vs hand-built as the quality score (already the roadmap's exit test).
- **Embed injection** — one-line snippet at the detected injection point, venue name/locales config blob (theming *bounded*: Hippo's design language is fixed; the CLI configures context only).
- **JWT-mint sample** — the ~20-line server endpoint in the partner's own stack (Node/Express, Python/FastAPI, PHP/Laravel to start) that mints the HS256 session token (`iss=partnerId, sub=venue_user_id, exp≤300s`) from the secret in their vault. **This is the single artifact standing between "panel loads" and "real users"** — without it every session is anonymous.
- **Confirm-surface wiring** per the partner's chosen mode (see user flow C4 / [[Open Decisions]] #6).

### Step 4 — Verify ✅→⬜ conformance is the trust gate
- `hippo conform --venue <x>` drives the generated adapter through the CTI behavioural suite (prepare market/limit, display-string tickets, reject bad size, confirm→terminal, cancel windows, portfolio shape) → report + verdict. **Exists and dogfooded green on sim.**
- ⬜ **Hosted sandbox**: a public sandbox gateway + mock-mode intelligence, so the CLI can boot the SDK against Hippo cloud on the partner's *actual staging page* and replay the golden conversation with screenshot evidence (BP05 stage 6). Today that replay only works against localhost.
- The conformance suite ships **into the partner's CI** — regressions are caught on their PRs too.

### Step 5 — Approve (dual gate)
Partner merges the PR (their sign-off). Hippo operator reviews the Integration Report in the admin panel and flips `sandbox → active` + assigns a plan (our sign-off; audited). Neither side alone can go live.

### Step 6 — Launch
Prod embed key swapped in, live venue keys in the partner's vault, gateway enforcement live from minute one: plan MAU quota (429 past ceiling, returning users unaffected), suspend/block levers, entitlements passed through session config for SDK feature gating. Operator watches MAU-vs-quota alerts, live sessions, degraded-SLA seconds on the dashboard.

### Step 7 — Operate & evolve
Protocol is additive-only with per-frame fallback (SDK renders unknown frames as FallbackCard) → old embeds never break. CLI `hippo conform` re-runs in partner CI. Quota alerts drive plan-upgrade conversations. Session kill switch + audit trail handle incidents.

---

## B. Integration handshake (sequence)

```
Partner agent          Hippo CLI              Hippo cloud                Operator
    │  "integrate hippo"   │                       │                        │
    ├─────────────────────►│ scan <domain>         │                        │
    │   report+config+gaps ◄───────────────────────┤ (read-only crawl)      │
    ├─────────────────────►│ register --sandbox    │                        │
    │                      ├──────────────────────►│ POST /provision        │
    │                      │  pk_sandbox + claim-URL◄─ partner row (sandbox) │
    │   secret → vault     ◄── one-time secret fetch                        │
    ├─────────────────────►│ init  (adapter+embed+jwt-mint+confirm-mode)    │
    │        PR opened     ◄───────────────────────┤                        │
    ├─ human review, merge │                       │                        │
    ├─────────────────────►│ conform --venue x     │                        │
    │  verdict+screenshots ◄──── golden replay ────┤ (sandbox gateway)      │
    │                      │      Integration Report ─────────────────────► │ review
    │                      │                       │   sandbox→active + plan◄─ (admin panel, audited)
    │        LIVE          │                       │                        │
```

---

## C. End-user flows (trader) — the state machine

`anonymous → identified → consented → researching ⇄ trading → lifecycle-tracked`, with safety states reachable from anywhere.

1. **Load** — one script tag → 1.1KB loader → panel lazy-loads on first open. Closed shadow DOM; can never harm the host. ✅
2. **Identify** — page knows the user is logged in → partner backend (the Step-3 generated endpoint) mints the JWT → SDK sends Bearer on `POST /v1/session` → session bound to `venue_user_id`; gateway lazily registers the user row (admin visibility). Anonymous mint is dev-only. ✅ gateway / ⬜ partner sample
3. **Consent & onboarding** — hero moment ✅; memory consent (`ConsentUplink.memoryOptIn`) ✅ — *review*: SDK currently defaults `memoryOptIn = true`; "persona, not surveillance" argues for explicit opt-in at the consent card. Language pick ✅. A **"what Hippo remembers" card** (view + clear from the panel) is the user-facing trust surface ⬜ (service + settings clear exist; surfacing in-panel pending).
4. **Research loop** ✅ — text/chip → intent → streamed brief (numbers retrieved, prose generated; cached fleet-wide; guardrail declines advice with a pivot). Degraded mode: banner + market-data-only brief (the SLA exhibit).
5. **Trade loop (Approach A: Hippo prepares, venue confirms)** — "buy 0.1 btc" → server-priced `order_ticket` → user taps Confirm → **confirm-surface** ([[Open Decisions]] #6, the CLI must support all three):
   - `api` — venue trusts the Hippo session; seam places on confirm ✅ (only mode wired)
   - `js-callback` — SDK raises an event; host page runs the venue's own confirm modal; returns a venue order token ⬜
   - `deep-link` — hand off to the venue's order screen prefilled (mobile / least-trust) ⬜
   → `awaiting_confirm` → venue events (or poll reconciler; poll-ceiling → terminal `expired` frame that hands the trader back to the venue — the #9 mitigation) → `filled` card. ✅ seam+sim+KoinBX pattern
6. **Memory across sessions** — opt-in accrual (followed assets, open threads, experience level calibrates concept depth); clear ≠ opt-out; admin purge exists for compliance. ✅
7. **Safety / edge states** — every admin-panel lever needs a graceful SDK face:
   - partner suspended → session mint 401 → SDK "temporarily unavailable" state ⬜ (map exists for generic errors; specific copy pending)
   - user blocked → 401, same face ⬜
   - **quota 429** → SDK edge state "Hippo is busy this month" ⬜ — *never* an error stack; returning users are unaffected by design ✅ server-side
   - session revoked (kill switch) → next turn 404 → SDK silently re-mints once; if that 401s, fall to the unavailable state ⬜
   - unknown future frame → FallbackCard ✅ · degraded intelligence → banner ✅

---

## D. Gap list → build order

| # | Workstream | Size | Unblocks | Status |
|---|---|---|---|---|
| 1 | **Provisioning API + `hippo register`** + `sandbox` partner status + one-time secret claim | S–M (reuses PartnerStore/audit) | the whole self-serve lane | ⬜ |
| 2 | **`init` stage 5**: embed injection + **JWT-mint samples** + confirm-mode config | M | real identified users | ⬜ (BP05 wk 13–14) |
| 3 | **Hosted sandbox** gateway (+mock intelligence) + golden-replay w/ screenshots in `conform` | M | agent-verifiable integration | ⬜ |
| 4 | **Agent legibility**: `--json`, llms.txt, SKILL.md, `hippo-mcp` | S | partner-side agents | ⬜ |
| 5 | **Adapter emit** (codegen remainder) + KoinBX blind-regen diff score | M–L | "days, mostly automated" | 🚧 |
| 6 | **SDK edge states** for 429/suspended/blocked/revoked + in-panel memory card + consent-default review | S–M | honest failure UX | ⬜ |
| — | Decisions to force: **#6 confirm-surface** (pilot eng), **#9 lifecycle feedback** (pilot eng), **CLI model choice** (frontier-with-consent vs OSS) | — | Phase 3/4 exit gates | open |

Suggested order: **1 → 2 → 4 → 3 → 6 → 5** (5 is largest and can overlap; 4 is a weekend-sized multiplier).

## E. Success metrics

- **Time-to-conformant-adapter** (scan → green `conform`): target < 1 day, agent-driven.
- % of pipeline stages completing with zero human intervention (checkpoint telemetry).
- Sandbox → live conversion time (provision-to-plan-assignment, from the audit trail).
- Hard gate: **zero secrets in any generated PR** (CI scanner on our own CLI output).
- Golden-conversation replay passing on the partner's real staging page (screenshot evidence archived in the Integration Report).

Related: [[05 Agentic Installer — Hippo CLI]] · [[04 Execution Seam & Partner Adapter]] · [[02 Thin Client SDK]] · [[10 BE Architecture]] · [[Open Decisions]] · [[Roadmap]]
