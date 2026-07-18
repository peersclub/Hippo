# Hippo Thin Client — Front-End Baseline

**Status:** Locked baseline, July 2026. Companion to the Master Strategy Memo (which remains the authority on business, pricing, architecture, and contract matters). This document is the authority on the thin client's front-end design and behavior. It supersedes all earlier front-end explorations, including the prior indigo-ink/Space Grotesk design brief and prototype, which are retired.

**Reference artifact:** `index.html` — the interactive walkthrough prototype, deployed at **https://project-iducy.vercel.app/** behind a client-side access gate. This deployment is the ideal reference for how the front end should look and function. The prototype is the living specification; where prose and prototype disagree, the prototype wins until this document is amended. The access phrase is managed by Ram and shared separately; instructions for rotating it are in a comment at the top of the file's script block.

---

## 1. Design language: Dark Glass Instrument

Four directions were explored from zero (Editorial, Instrument, Soft Glass, and an Editorial/Instrument hybrid), then a deliberate blend of Soft Glass and Instrument was developed in light and dark leans. **The dark lean is the hero.**

The governing rule of the language: **soft surfaces carry the conversation; mono discipline carries the money.** Rounded, gently frosted cards and friendly prose for talk; tabular mono numerals, grid discipline, and hard structure the moment an order or a number appears.

Tokens:

- Background `#0E1014` / panel `#14161C`; in-thread cards use solid backgrounds (`#232733`, `#262B36`) — backdrop-filter is reserved for full-surface overlays only (a hard rule: frosted blur inside scroll containers silently fails to paint on iOS/WebKit).
- Signal amber `#F0B94A` — the single accent. It means Hippo, attention, and money-in-motion. Up `#2EC48D`, down `#FF8585`.
- Type: **Outfit** (headings, buttons, brand), **Inter** (prose), **IBM Plex Mono** (every number, ticker, timestamp, label, and the entire ticket).
- Geometry: 15–18px card radii, hairline borders `rgba(255,255,255,.07)`, dashed rules inside tickets.
- The order ticket carries a hairline amber border — the one card on screen that visibly means money.

## 2. Surfaces and postures

The SDK renders one conversation surface in three postures per platform. Hippo never takes the trader hostage: minimized, the partner's app is untouched.

**Web:** a 360px right-docked panel beside the partner's chart and order book; a ~620px overlay (⤢) with scrim for deep research; and a floating **Ask Hippo** pill (amber H mark + wordmark) when minimized. The terminal loads with Hippo minimized — the floating pill is the default resting state and the brand object.

**Mobile:** a floating Ask Hippo pill above the partner's tab bar; a bottom sheet that opens **over** the chart, not instead of it; full-screen via grab bar or ⤢.

**Ambient market pulse:** on a significant market move, the minimized pill glows slowly with a small mono event tag (e.g. "· BTC −4.2%"). One ambient state, no counts, no notification spam. Server decides when; client only renders. Opening clears it; closing re-arms it.

## 3. Panel anatomy

Top to bottom: header (H mark, "Ask Hippo / MARKET INTELLIGENCE", ⚙ settings, ⤢, —) → **open-orders strip** → conversation thread → **suggested-queries strip** → composer.

- **Orders strip:** horizontally scrollable pills (side-color dot, mono summary, status), plus a dashed amber **+ New order** pill. Tapping a pill expands its full order card in place, animating open and pushing the thread down; tapping again collapses. + New order expands a draft hint ("Tell me what to place…") with example intents — order placement stays conversational, never a form.
- **Suggested queries:** a chip row mixing market, portfolio, and concept questions. Doubles as a cache lever: chips steer users toward cacheable market-level questions.
- The thread always opens scrolled to the newest message; on first open it plays in card-by-card (CSS-driven, degrades to instantly-visible if animations are unavailable). Thread children must never flex-shrink — overflow scrolls, cards never compress.

## 4. Card vocabulary (v1)

Server-driven; the SDK only draws.

1. **Research brief** — mono eyebrow + LIVE tag, headline, prose, 3-cell stat grid, sparkline, source chips, live-bar.
2. **Live-bar** — on every research answer: `AS OF hh:mm:ss IST · ↻ REFRESH · ↗ SHARE · 👍/👎`. Answers are facts about a moment; the moment is always visible and renewable.
3. **Order ticket (prepared)** — instrument, size, est. price, est. cost incl. fees; CTA "Review & confirm in KoinBX →"; footer restating the seam. Estimates end at the confirm.
4. **Lifecycle cards** — awaiting-confirm (pulsing amber "WAITING FOR YOUR CONFIRM ON KOINBX" + cancel), filled receipt (actuals: avg fill, real fees, venue order ID), partial fill (live progress bar, "amend or cancel on KoinBX"), cancelled-on-venue (no judgment; ticket reusable), expired/cancelled-later (status changes made elsewhere still arrive in the thread).
5. **Advice-decline card** — amber left edge, "◇ NO ADVICE — BY DESIGN" badge, decline with conviction, immediate pivot to "What's true about X right now" fact rows, follow-up chips steering back to legitimate questions. This card is the UI of the bake-off's advice-avoidance launch gate.
6. **Positions card**, **rejection ticket** (plain-words reason + a fix, never a bare error code), **thinking state** (rotating status lines that narrate the work — "Parsing intent… Fetching live market data…"), and **skeleton cards** (shimmer shapes before content).

## 5. Onboarding (the one hero moment)

Invited, never imposed. Nothing appears until the trader taps Ask Hippo for the first time.

First tap → the entire screen blurs and dims → **confetti burst** behind a centered welcome card: *WELCOME TO / The Future of Trading / "Hippo — your conversational trading agent, built for KoinBX."* → **Show me more** → hero step (large mark, "Ask your market anything.", glowing centered chat bar with typewriter cycling real queries) → **data consent** → **ground rules** → Agree & start → blur lifts, thread plays in. After this, everything is subtle, permanently.

- The exchange name in the welcome is an SDK config string — every partner gets their own "built for ___" moment.
- **Not now** genuinely means not now: the flow closes, nothing opens, and the next tap offers it again. Consent is asked at the door every time until given.
- The data screen maps the three-layer schema to user language: account/orders stay with the venue in-region (Layer 1); personal memory is an opt-in toggle; anonymized conversations improve Hippo, disclosed plainly as part of terms with a link to how anonymization works (Layer 2). Whether Layer 2 needs an active checkbox vs. disclosed-in-terms is a per-jurisdiction counsel question; the screen is built so switching that row is trivial.
- Ground rules double as trust copy: "explains, never advises — anyone who gives trading calls inside a chat isn't on your side," and "nothing executes without your explicit confirm on KoinBX."

## 6. Behaviors

- **Refresh:** updates the as-of timestamp (brief amber flash) and the data behind the card.
- **Share:** produces a **live, co-branded card** (Hippo mark + "on KoinBX", headline, sparkline, timestamp, short link) — not a screenshot; the link renders current data when opened. "MARKET INFORMATION · NOT INVESTMENT ADVICE" is printed on the card itself, so viral distribution never crosses the advice line. Every share is organic "does your exchange have this?" marketing.
- **Feedback:** quiet 👍/👎 on research answers only (never on tickets — execution is binary). A downvote asks one follow-up with three reason chips (*Inaccurate / Too shallow / Outdated*) mapped to the bake-off's scoring criteria, so labels arrive pre-categorized for the eval harness via Layer 2. The front end's direct contribution to the IP.
- **Settings (⚙):** memory toggle + "clear everything Hippo remembers"; the data rows restated with an in-place plain-language anonymization explainer (written to be quotable in partner compliance reviews); answer language (English / हिन्दी / Hinglish, plus عربي RTL structural preview); "Replay the intro."
- **Localization:** language selection relabels chips and composer and switches answer language; Hinglish is a first-class answer language (mirroring the bake-off's ≥25% Hinglish requirement). RTL flips the surface structurally for Gulf venues; numerals and card grammar hold.

## 7. Edge states (SDK ships with all six)

Every state answers three questions unprompted: *what happened, what still works, what do I do next.*

1. **Empty thread** — never blank; three real tappable queries, value one tap away.
2. **No open orders** — an invitation, not a void; + New order stays adjacent.
3. **Degraded mode** — amber banner ("HIGH MARKET LOAD — fresh research may take longer; orders, prices and saved briefs unaffected"); cached answers wear a visible "CACHED BRIEF · updated X min ago" badge — labeled, never disguised. This banner is the UI of the 99.5% SLA's graceful-degradation clause; partners should see it in procurement, not discover it in an outage.
4. **Order rejected** — the venue's rejection translated to plain words with a concrete fix (e.g. "Resize to max").
5. **Stale data** — declared, never silent: past a freshness threshold the as-of line turns amber and refresh becomes the loudest element.
6. **Offline / answer failed** — thread stays readable, composer locks with a reason, failed questions are saved with retry-in-place. Nothing the trader wrote is ever lost.

## 8. The execution seam (Approach A) and the thin-client stop line

The prototype is built against **Approach A: Hippo prepares, the partner confirms and executes.** The A/B decision remains open pending the Suresh discussion; the lifecycle chapter of the prototype is the strongest exhibit for A. The governing sentence: *if a trader ever has to leave the conversation to find out what happened to their order, the seam has failed.*

**The stop line — where the client turns thick (do not build):** client-side charting with indicators (that's the partner's chart); client-side order validation or balance math (server/partner logic); local market-data caching or offline computation; watchlist/alert *management* state held in the client (rendering an alert card is thin; owning alert logic is thick). The test for every future request: **if the SDK does more than draw what the server sends, it's thick.**

## 9. Open items

1. **V1/V2 feature-set document** (item #1 from the original list) — not yet written; largely codifies §3–§7 of this document into SDK scope for the Suresh discussion, plus V2 candidates (support first-responder surface, alerts, watchlists).
2. **A/B execution decision** — pending with Suresh; prototype built against A.
3. **Layer-2 consent format** (checkbox vs. disclosed-in-terms) — per-jurisdiction counsel question before Gulf contracts.
4. **Server-side auth for the deployed prototype** — the current gate is client-side (right weight for team/partner preview; upgrade via Vercel deployment protection before any version embeds telemetry or pricing).
