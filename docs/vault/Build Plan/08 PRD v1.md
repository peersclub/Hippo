# 08 · PRD v1 — Hippo Thin Client & Core

**Status:** Draft for dev kickoff · July 14, 2026
**Authorities:** [[Hippo Strategy Memo (Master)]] (business/product law) · [[Thin Client Frontend Baseline]] (design/behavior — prototype wins on disagreement) · [[09 FE Architecture]] / [[10 BE Architecture]] (how)

---

## 1. Goals & non-goals

**Goal:** Ship Hippo v1 — a conversational trading agent embedded in a partner exchange that does three things inside one conversation: **Research** (factual, sourced, live-data-grounded answers), **Action** (intent → prepared order ticket → confirm on partner rails), **Memory** (opt-in persona that makes session ten smarter than session one). The journey is one loop: *ask → understand → (confirm →) act.*

**Product law (non-negotiable, enforced in code and evals):**
- No buy/sell recommendations, signals, price predictions, or portfolio advice. Decline-and-redirect posture: decline with conviction, pivot immediately to facts. This is simultaneously the trust position, the caching economics, and the regulatory line.
- Nothing executes without an explicit confirm on the venue (Approach A).
- Answers explain, never recommend; every answer is a fact about a moment with a visible, renewable timestamp.

**Non-goals for v1:** support first-responder surface (v2, post-pilot) · alerts/watchlists · multi-venue context · native mobile SDKs (WebView carries pilot) · white-label · performance-linked pricing instrumentation as billing (lift telemetry is evidence only).

## 2. Personas

1. **Trader (end user)** — active crypto trader on a mid-market exchange, likely mobile-first, Hindi/Hinglish comfortable. Wants to know *what's happening and why*, and to act without switching contexts. Skeptical of shills; trusts tools that refuse to advise.
2. **Partner exchange (buyer)** — 40k–500k active traders, production trading API, growth budget, no AI team. Wants Bybit-grade conversational features, weeks-not-quarters integration, zero regulatory exposure creep, and their user session kept inside their app.
3. **Hippo ops (internal)** — needs fleet observability: cache hit rate, utilization, advice-avoidance scores, per-partner MAU events (the billable unit).

## 3. User stories → card vocabulary

| # | Story | Cards involved |
|---|-------|----------------|
| U1 | "Why is BTC down today?" → sourced brief with stats, sparkline, sources, as-of time | `thinking` → `skeleton` → `research_brief` + `live_bar` |
| U2 | "Buy 0.05 BTC at market" → ticket with instrument/side/size/est. price/est. cost incl. fees → confirm on venue | `order_ticket` → `lifecycle.awaiting_confirm` |
| U3 | Order fills (fully/partially) while I chat → receipt with actuals arrives in-thread | `lifecycle.filled` / `lifecycle.partial` |
| U4 | Order rejected by venue → plain-words reason + a concrete fix | `rejection_ticket` |
| U5 | "Should I buy the dip?" → convinced decline + "what's true right now" facts + legit follow-up chips | `advice_decline` |
| U6 | "My positions & P&L" → positions card (regional, never cached) | `positions` |
| U7 | Concept question ("what does funding rate mean") → explanation calibrated to my experience level | `research_brief` (concept variant) |
| U8 | Market moves hard while Hippo minimized → pill glows with mono event tag; opening clears it | `pulse` |
| U9 | I refresh a brief → as-of flash + updated data; I share → live co-branded card with no-advice disclaimer printed | `live_bar` behaviors, share overlay |
| U10 | I downvote an answer → one follow-up, three reason chips; label lands pre-categorized in eval corpus | feedback events |
| U11 | First tap on Ask Hippo → confetti welcome ("built for [Venue]") → hero → data consent → ground rules → thread plays in | onboarding flow |
| U12 | I open settings → memory toggle + clear, data explainer, language EN/हिन्दी/Hinglish + RTL preview, replay intro | settings sheet |

## 4. Functional requirements

### 4.1 Surfaces & postures (per [[Thin Client Frontend Baseline]] §2)
- **Web:** 360px right-docked panel · ~620px overlay (⤢) with scrim · floating "Ask Hippo" pill when minimized (default resting state — the terminal loads with Hippo minimized).
- **Mobile (WebView):** floating pill above partner tab bar · bottom sheet **over** the chart · full-screen via grab bar/⤢.
- Minimized, the partner's app is untouched. Uninstall = remove one line.

### 4.2 Panel anatomy (§3)
Header (H mark, "Ask Hippo / MARKET INTELLIGENCE", ⚙/⤢/—) → open-orders strip (scrollable pills + dashed "+ New order"; pill tap expands full card in place) → thread (opens scrolled to newest; card-by-card play-in on first open; children never flex-shrink) → suggested-query chips (cache lever) → composer.

### 4.3 Card vocabulary v1 (§4) — server-driven; SDK only draws
`research_brief` · `live_bar` (AS OF · ↻ REFRESH · ↗ SHARE · 👍/👎) · `order_ticket` (prepared; estimates end at confirm) · lifecycle set (`awaiting_confirm` pulsing amber + cancel, `filled` receipt with actuals + venue order ID, `partial` live progress, `cancelled`, `expired`) · `advice_decline` (amber edge, "◇ NO ADVICE — BY DESIGN") · `positions` · `rejection_ticket` (plain words + fix, never a bare code) · `thinking` (rotating status lines) · `skeleton` · `banner` (degraded/offline) · `pulse`. Unknown card types render graceful fallback (prose + link), never crash.

### 4.4 Onboarding (§5) — the one hero moment
Invited, never imposed; nothing until first pill tap. Blur+dim → confetti welcome (*"WELCOME TO / The Future of Trading"*, "built for ___" from config) → hero typewriter bar → data consent (three-layer schema in user language; L2 row switchable checkbox/terms per jurisdiction) → ground rules (trust copy) → Agree & start → play-in. "Not now" genuinely closes; consent re-asked at the door until given.

### 4.5 Behaviors (§6)
Refresh (amber as-of flash) · Share (live co-branded card, short link renders current data, "MARKET INFORMATION · NOT INVESTMENT ADVICE" printed on card) · Feedback (research answers only, never tickets; 👎 → *Inaccurate / Too shallow / Outdated*) · Settings (memory toggle + clear-all, quotable anonymization explainer, language, replay intro) · Localization (EN/हिन्दी/Hinglish first-class; RTL flips surface structurally, numerals hold).

### 4.6 Edge states (§7) — all six ship in v1
Empty thread (three tappable queries) · no open orders (invitation + New order adjacent) · degraded mode (amber banner, labeled CACHED BRIEF badges — the SLA clause made visible) · order rejected (plain words + fix) · stale data (amber as-of, refresh loudest) · offline (composer locks with reason, failed questions retry-in-place, nothing typed ever lost). Every state answers: what happened, what still works, what next.

### 4.7 Execution seam (Approach A)
Prepare → "Review & confirm in [Venue] →" handoff → venue events stream back as lifecycle cards (webhook preferred, polling reconcile fallback; thread backfills missed transitions). *If a trader has to leave the conversation to find out what happened to their order, the seam has failed.*

## 5. Non-functional requirements

| Category | Requirement |
|---|---|
| Latency | Intent classification < 300ms p95 · first streamed token < 2s p95 (cache hit < 800ms) · order ticket prepared < 1.5s p95 |
| Host safety | Loader < 5KB gz · closed Shadow DOM, zero style bleed either direction · no host globals touched · mounts after host `load`, zero CLS · SDK crash can never break host · CSP-friendly (no eval, nonce support) |
| Degradation | Contractual graceful degradation: research may slow under extreme load; intent, order flow, cached explanations stay responsive; degraded banner + labeled cache badges |
| Data | L1 in-region only, deleted on exit · L2 un-linkable to PII · memory opt-in, clearable · no PII in share links |
| Accessibility | Keyboard operable, focus-visible (already in prototype), `prefers-reduced-motion` respected, RTL structural |
| Compatibility | Evergreen browsers + Android/iOS WebView; solid card backgrounds in scroll containers (WebKit blur rule) |

## 6. Launch gates (each has a score, not an opinion)

1. **Research quality:** bake-off winner within 5% of 70B baseline on factual accuracy with no hallucination gap (300-query exam, ≥25% Hinglish).
2. **Advice-avoidance under baiting:** consistency score on adversarial set — a gate, not a nice-to-have.
3. **Host-safety pass:** hostile-CSS page + performance budget in CI.
4. **Seam integrity:** full lifecycle round-trip in venue sandbox, all lifecycle cards driven by real venue events, rejection mapping coverage.
5. **Edge-state completeness:** all six demonstrable (degraded mode shown in procurement, not discovered in outage).

## 7. Success metrics

**Billable/product:** MAU events (≥1 research answer or ≥1 executed order per calendar month — unambiguous, logged) · queries/MAU distribution · D30 retention of Hippo-touched traders.
**Economic:** cache hit rate (underwrites the rate card) · true cost/MAU (target ₹10–18 at scale) · fleet utilization 60–75%.
**Trust:** advice-avoidance score trend · 👎 rate by reason · share-card CTR (organic "does your exchange have this?").

## 8. Release plan

R0 scaffold (mock gateway + golden conversation) → R1 SDK feature-complete vs baseline §3–§7 on mock → R2 live intelligence behind gates 1–2 → R3 pilot venue sandbox (gate 4) → R4 pilot production + instrumentation ([[06 Eval Harness & Data]]).

Related: [[00 Build Plan Overview]] · [[09 FE Architecture]] · [[10 BE Architecture]] · [[Open Decisions]]
