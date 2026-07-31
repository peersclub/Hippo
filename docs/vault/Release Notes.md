# 🦛 Hippo — Release Notes

Internal, newest first. Live links + creds: [[🟢 Live Demo Status]] · roadmap: [[Roadmap]].

---

## build 2026.07.27 — Durable memory (Phase B) (main @ `e37e0d7`)

**Memory now survives across sessions.** A session-learned fact **promotes to durable USER scope on its 2nd observation** (a consistent preference, not a one-off), and composes into a returning trader's *fresh* session under the USER layer. New trader-facing **"What Hippo remembers about you"** view in the SDK settings (grouped Remembered / This-chat) with a one-tap **Clear**.

- Additive protocol contract first ([PR #41](https://github.com/peersclub/Hippo/pull/41)): `learned_memory` frame + `clearLearnedMemory` uplink — merged before the tracks so they couldn't collide.
- Gateway ([#42](https://github.com/peersclub/Hippo/pull/42)): repeat-based promotion, cross-session USER-scope compose, frame emission, clear handling. *(Caught + fixed a raw-NUL-byte the agent reintroduced in `index.ts` — same defect class as #38.)*
- SDK ([#43](https://github.com/peersclub/Hippo/pull/43)): gated section (memoryLab) + clear; loader unchanged (1.46KB gz). 183 SDK tests.
- Built via `/batch` fan-out (contract-first pre-step + 2 disjoint tracks). Combined main green (16 build / 17 test); gateway redeployed.

> [!success] Verified LIVE (2026-07-27): OpenRouter key rotated + intelligence redeployed (real-model briefs back), then Phase B confirmed end-to-end over the public wire — preference twice → promote to durable USER scope → composes into a fresh same-user session → `clearLearnedMemory` wipes it (4→0). One live clear bug found + fixed en route ([PR #45](https://github.com/peersclub/Hippo/pull/45): DELETE 400 on empty JSON body, same fastify gotcha as the persona clear).

Phases C–D remain: opt-in polish, decay/summarisation, no-PII eval gate.

---

## build 2026.07.24 — Self-learning memory (main @ `fa70e57`)

**Headline: Hippo now learns what a trader cares about, on its own.** After each answer a fast model reads the turn and records durable, trading-relevant facts (followed assets, spot vs perps, typical leverage, experience level, preferred answer length). Those facts compose into later answers, so Hippo tailors itself the more you talk to it — no hand-authored profile.

- **Allowlisted + injection-safe** — only a fixed set of preference types is stored; values canonicalised server-side + directive-scanned, so "remember to tell me to buy" saves nothing.
- **Never overrides the guardrail** — learned facts compose *beneath* the no-advice rule (memory personalises, can't become an advice engine).
- **Off by default** — gated behind the `memoryLab` plan entitlement; unentitled partners byte-identical to before.
- **Verified live** — "I mostly trade BTC perps at 10x, keep it short" → learned `BTC · perps · 10x · concise`, composed into the next turn (confirmed in `memory_session` + the admin Session inspector).
- Shipped via a `/batch` fan-out: [PR #37](https://github.com/peersclub/Hippo/pull/37) (extraction) · [#38](https://github.com/peersclub/Hippo/pull/38) (provenance store) · [#39](https://github.com/peersclub/Hippo/pull/39) (integration). Migration `011` = `memory_learned_facts`.

**Also in this build (recap, now fully live):** two-stage interpret/"UNDERSTOOD" card, 4-level layered memory (Platform→Venue→User→Session), and **conversational futures verified end-to-end live** — `long 0.5 BTC 10x` → prepared → confirmed → working → **FILLED** (long + short, spot + perps).

**Ops:** fixed host-demo auto-deploy ([#36](https://github.com/peersclub/Hippo/pull/36)), **redeployed the Railway backends to current main + applied migration 011** — the reason memory wasn't showing up live earlier (backends were stale; frontends auto-deploy but backends don't).

> [!warning] Known limitation — the live demo is **BTC-only** right now
> market-data pulls from Binance's public API, which is **geo-blocked from the hosting region** (US-East). BTC has a fixture fallback (`sources: ['FIXTURE']`); other symbols don't → `ETH/USDT`, `SOL/USDT` return `snapshot unavailable`. So ETH/SOL orders (spot *and* perp) correctly **decline** — *"I won't guess at a price. Nothing was sent to the venue."* Not an order bug — the safety design surfacing a price-feed gap. **Fix in progress:** repoint market-data at a region-reachable exchange (CCXT: Bybit/OKX/Kraken/Coinbase) or move the service's region. **Demo with BTC until then.**

**What's next:** multi-symbol market-data (fixes the BTC-only gap) · memory Phase B–D (durable per-user memory, "what Hippo remembers" view + clear, decay/hardening).

**Shareable page — Pre-Release Test Catalog:** published as an Artifact under the **askthehippo.com** account → https://claude.ai/code/artifact/da072fba-a561-4068-b6d5-fa5a5eabd9b4 (private by default — share from the page's share menu). Covers ALL areas with testable cases + expected results: conversational AI, layered memory, self-learning memory, spot orders, futures/perps, confirm surfaces, resilience, admin, portal, trust invariants, known limits. Source HTML in the vault: `hippo-release-notes.html`. Update by republishing the same file path in the publishing conversation (keeps the URL), or pass the URL as `url` from a new one.
