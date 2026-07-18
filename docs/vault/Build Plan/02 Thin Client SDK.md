# 02 · Thin Client SDK

**Authority:** [[Thin Client Frontend Baseline]] is the spec; the deployed prototype wins where prose and prototype disagree. This doc covers *how to productionize it*, not what it looks like.

---

## Packaging

- `@hippo/sdk` — core web SDK. Distribution: **script tag first** (`<script src="https://cdn.hippo.app/sdk.js" data-hippo-key="pk_...">`) because the agentic installer needs a one-line injection target; npm package as a wrapper for partners with build pipelines.
- `@hippo/protocol` — generated types + validators from the card protocol schema (shared with gateway and CLI).
- Mobile v1 = the same web SDK in the partner's WebView with the mobile postures (pill/sheet/full). Native wrappers (RN/Swift/Kotlin bridge around the same protocol) are post-pilot — the protocol makes this a rendering port, not a product port.

## Build order (maps to prototype chapters)

1. **Shell & postures** — mount/unmount, dock 360px / overlay 620px + scrim / floating pill; mobile pill/sheet/full. Terminal loads with Hippo minimized; the pill is the brand object.
2. **Card renderer** — protocol frame → DOM. All cards from the prototype's vocabulary, including thinking states (rotating status lines) and skeletons. Staged card-by-card play-in on first open (CSS-driven, degrades gracefully; `prefers-reduced-motion` respected).
3. **Panel anatomy** — header / orders strip (expandable pills, + New order draft hint) / thread / suggested-query chips / composer. Thread children never flex-shrink; thread opens scrolled to newest.
4. **Onboarding** — the one hero moment: blur + confetti welcome ("built for ___" from config) → hero typewriter bar → data consent (three-layer schema in user language; consent row switchable per jurisdiction) → ground rules → play-in. "Not now" genuinely closes; consent re-asked at the door every time until given.
5. **Behaviors** — refresh (as-of flash), share (live co-branded card with printed no-advice disclaimer), feedback (👍/👎 + three reason chips mapped to eval scoring), settings (memory toggle + clear, data explainer, language EN/हिन्दी/Hinglish + RTL preview, replay intro), ambient market pulse (server-sent, one state, no counts).
6. **Edge states** — all six ship in v1: empty thread, no open orders, degraded mode (amber banner + labeled CACHED BRIEF badges), order rejected (plain words + a fix), stale data (amber as-of), offline (composer locks with reason, failed questions retry-in-place, nothing typed is ever lost).

## Hard rules carried from the baseline

- Solid card backgrounds in scroll containers; backdrop-filter only on full-surface overlays (iOS/WebKit paint bug).
- IBM Plex Mono on every number, ticker, timestamp, label, and the entire ticket; tabular numerals.
- Amber = Hippo, attention, money-in-motion — the only accent. The order ticket is the one card with an amber border.
- Estimates end at the confirm: prepared tickets show est. price/cost; receipts show actuals (avg fill, real fees, venue order ID).

## Host-safety checklist (per release)

Shadow DOM isolation verified against a hostile-CSS test page · loader ≤ 5KB · zero global leaks · no layout shift on host · CSP report clean · SDK errors sandboxed (a Hippo crash can never take down the host page) · uninstall = remove one line.

## Testing

- **Golden conversation** replayed over the mock gateway = visual regression suite (Playwright screenshots per card/state/posture/locale, including RTL).
- Protocol fuzzing: unknown card types must render the graceful fallback, never throw.
- Real-device WebView matrix for the mobile postures (the iOS blur rule exists because of exactly this class of bug).

Related: [[01 System Architecture]] · [[05 Agentic Installer — Hippo CLI]]
