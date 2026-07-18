# 🦛 Hippo — Vault Home

Conversational trading agent embedded in partner exchanges: **thin client, heavy core**. A one-script-tag surface that attaches to any website without harming it, deeply connected to the product underneath — it understands the user and places orders from inside the conversation. Installation is agentic and CLI-based: `hippo init` understands the partner's site and generates the integration.

**Prototype (living spec):** https://project-iducy.vercel.app/ · local copy at `Reference/prototype-index.html`
**Team:** Ram (strategy/brand) · Sudha (data/trust/evals) · Victor (product/SDK) · Kartik (commercial/MENA)

## Strategy
- [[Hippo Strategy Memo (Master)]] — authority on business, pricing, AI stack, contracts (July 2026)
- [[Thin Client Frontend Baseline]] — locked authority on front-end design & behavior

## Build Plan
- [[00 Build Plan Overview]] — **start here**: phases, workstreams, milestones
- [[01 System Architecture]] — thin edge / heavy core, card protocol, data boundaries, host-agnosticism
- [[02 Thin Client SDK]] — productionizing the prototype
- [[03 Intelligence Layer]] — intent, research, cache (the unit-economics engine), memory, guardrail
- [[04 Execution Seam & Partner Adapter]] — Approach A, canonical trading interface
- [[05 Agentic Installer — Hippo CLI]] — the agentic, CLI-based installation
- [[06 Eval Harness & Data]] — the core IP; bake-off, CI gate, feedback loop
- [[07 Infrastructure & Pods]] — regional pods, global cache tier, capacity model
- [[08 PRD v1]] — product requirements for dev kickoff: stories, requirements, gates, metrics
- [[09 FE Architecture]] — **locked stack:** Preact + signals, two-stage loader, Shadow DOM, card registry
- [[10 BE Architecture]] — **locked stack:** Fastify gateway, SSE + frame journal, cache design, service topology

## Progress (as of July 18, 2026)

**Merged July 18 (morning):** [PR #18](https://github.com/peersclub/Hippo/pull/18) stop-streaming (`stream_stop` uplink, gateway abort → honest server-assembled "STOPPED" brief, SDK ⏹ control) · [PR #19](https://github.com/peersclub/Hippo/pull/19) CLI `hippo embed` + `hippo verify` (deterministic init stages 5–6) · provisioning `hippo register` + sandbox partners + one-time secret claim (`34a30c3`, WS-1) · vault versioned in-repo at `docs/vault` + `scripts/sync-vault.sh` (`600c441`).
**In review:** [PR #17](https://github.com/peersclub/Hippo/pull/17) Arabic chrome copy (complete `ar` catalog, RTL pill label `اسأل Hippo` — pending native review) · [PR #16](https://github.com/peersclub/Hippo/pull/16) (draft) canonical order model — the trade-capabilities keystone · [PR #20](https://github.com/peersclub/Hippo/pull/20) (draft) trade-type discovery in `hippo scan` (spot/futures_perp/options). Uncommitted capability WIP lives in the `wt-cap-*` worktrees (seam order-plans, intelligence capabilities, SDK render tests).
Phase 0 (foundations) ✅ · **Phase 1 (SDK) ✅** · Phase 2 (intelligence) ✅ core + Redis/OTel **merged to main** (bake-off pending) · Phase 3 (execution seam) ✅ merged to main incl. KoinBX adapter (exit gate blocked on Open Decisions #6/#9) · Phase 4 (CLI) 🚧 scan + conform + config codegen + embed/verify landed · Phase 5 (pilot) ⬜. **Done-vs-pending roadmap: [[Roadmap]]**. Detail + what's shipped per phase: [[00 Build Plan Overview]]. Visual roadmap + kanban board: [[Hippo Dev Progress]].

**SDK fold release (July 16, `629251b` on `feat/admin-panel`):** WhatsApp-grade interaction density, zero protocol changes — the chip bar is now contextual (each answer's server-sent `followups` replace the session chips; tap sends, ~450ms hold or Shift+click edits in the composer), composer v2 (autosizing multiline, Enter/Shift+Enter, **drafts survive minimize**, char counter at the 2000 limit), the thread never yanks a reader (near-bottom anchoring + ↓ LATEST jump pill; streaming prose autoscrolls), offline outbox per edge state №6 (queued row, flush on reconnect; `ticket_action` deliberately fails loud, never queued), full a11y fold (Esc folds inward-out, focus management, `role=log`, dialog focus traps), settings completed per baseline §6 (answer language EN/हिन्दी/Hinglish/عربي + clear-memory confirm + data rows), and ⧉ COPY on briefs (clipboard text always carries the advice line). 108 SDK tests (45 new) · tsc/biome clean · panel 54.1KB gz. Deliberately rejected: pill unread counts (baseline: "no counts") and a persisted outbox (fresh session per load — replaying stale uplinks = client inventing context).

Highlights: card protocol v1 + 300-query eval harness + CI landed · SDK has onboarding, share/feedback/order-pill interactions, and a mock-gateway demo running end-to-end · `hippo scan v0` (read-only site/API discovery → integration report) is live, but adapter codegen isn't started · **`services/intelligence` merged** ([PR #8](https://github.com/peersclub/Hippo/pull/8): intent + research engines, answer cache, output-side guardrail, SSE streaming, volatility-scaled TTLs; Ollama/vLLM/mock providers; 83 offline tests) · **gateway core merged** ([PR #7](https://github.com/peersclub/Hippo/pull/7): sessions, SSE frame journal + resume, orchestrator wired to intelligence, degraded fallback) · **full loop verified end-to-end on main** with real qwen3:4b + live market data: research brief, advice decline, order ticket, and the degraded-mode banner all driven through the real gateway · next: point the SDK demo at the real gateway, adopt streaming in the orchestrator, memory v1.

## Code
- Monorepo: `/Users/Victor/Projects22/hippo/hippo-app/` (branch `main` @ `b2d1990`, July 18) — pnpm + Turborepo; `packages/protocol`, `packages/sdk`, `packages/stores`, `services/mock-gateway`, `services/gateway`, `services/intelligence`, `services/memory`, `services/seam`, `services/admin`, `apps/host-demo`, `apps/admin`, `apps/site`, `tools/cli`, `evals/`. Landed via PRs #1–#19 + direct merges. 23/23 workspace build+test tasks green (July 18 check).
- **As-built technical reference (verified against a live test run):** [[Development Documentation]] — architecture, per-service detail, test counts, what's actually left.
- **Data model:** [[Data Model — ER Diagram]] — every entity across the four bounded contexts (gateway · memory · intelligence · seam) + the CLI installer, with dev→prod stores and the PII/data boundaries.
- In flight: **trade-capabilities workstream** in the `wt-cap-*` worktrees — keystone order model (PR #16 draft), trade-type discovery (PR #20 draft), plus uncommitted order-plans work in `wt-cap-seam`, `services/intelligence/capabilities/` in `wt-cap-intelligence`, and SDK render-test scaffolding in `wt-cap-sdk`. (Memory v1 merged July 15 via PR #10.)
- **Marketing site:** `apps/site` — recreation of Ram's AskHippo homepage (review bundle) with the mascot logo, plus **`/design`** (design-language page: principles, live token swatches, type, card vocabulary, voice, theme system) and **`/sdk`** (platform integration: script tag + attribute reference, React/Next/Vue, iOS WKWebView, Android, React Native, Flutter, Electron; bridge contract, wire surface + CSP, WebView-first roadmap). Runs on :5174; the try-it pill is the real SDK against mock-gateway.
- **Cross-platform SDK embedding (July 16):** SDK gained an external open surface (`data-hippo-open="auto"` + `hippo:open` event on `<hippo-root>` — the closed shadow root was unreachable from WebViews/host apps) and a **mobile WebView shell** at `packages/sdk/embed/mobile.html` (ships in dist; query-string config, safe-area, auto-open into sheet/full postures, unified JS↔native bridge for WKWebView / Android `@JavascriptInterface` / react-native-webview / Flutter channels). Bridge contract: `packages/sdk/embed/README.md`.
- **Theming:** whole product is theme-aware by token swap — brand core `Reference/brand/hippo-tokens.css` (dark locked hero + light lean) ✅ · SDK tokenized, `data-hippo-theme="light"` (PR #12) ✅ · site + /design share the tokens with a persisted manual toggle that also flips the SDK pill ✅ · partner accent theming beyond light/dark = future `hippo init` design-extraction work.

## Decisions
- [[Open Decisions]] — live register (A/B execution, consent format, CLI model choice…)

## The product in one loop
ask → understand → (confirm →) act — research and action interleaving in one thread. Explains, never advises. Nothing executes without an explicit confirm on the venue.

*One product, one revenue stream, four cost levers, and an eval harness that compounds. Focus is the constraint.*
