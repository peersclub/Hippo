# 09 · FE Architecture — Thin Client SDK

**Stack (locked July 2026):** Preact 10 + TypeScript + @preact/signals · Vite 7 lib build · closed Shadow DOM · Zod-derived protocol types from `@hippo/protocol` · Vitest + Playwright.
**Repo:** `hippo-app/packages/sdk`

---

## 1. Bundle strategy — two-stage loader

```
<script src="https://cdn.hippo.app/v1/loader.js" data-hippo-key="pk_..." async></script>
```

- **`loader.js`** — < 5KB gz, IIFE, zero dependencies (no Preact). Jobs: read `data-hippo-key` → fetch signed config blob → mount the floating pill (closed Shadow DOM) after host `load` (idle priority, zero CLS) → listen for `pulse` via a lightweight EventSource → on first interaction, dynamic-`import()` the panel chunk.
- **`panel.js`** — ESM chunk with Preact + signals + card renderer + transport. Loaded once, cached; preloaded on pill hover.
- **CDN versioning:** `/v1/loader.js` is an immutable major channel; the loader resolves the exact panel build from the config blob (`panelUrl` with content hash). New card types ship fleet-wide by bumping the panel hash — partners change nothing. Major protocol breaks = `/v2/` (avoid; protocol is additive-only).

## 2. Isolation (the host-safety contract)

- `attachShadow({mode:'closed'})` on a `<hippo-root>` custom element positioned fixed; one shadow root for pill + panel + overlays.
- Styles via **constructable stylesheets** adopted into the shadow root — design tokens ported 1:1 from the prototype's `:root` block (`--bg #0E1014`, `--amber #F0B94A`, Outfit/Inter/IBM Plex Mono via `FontFace` API scoped loading, `font-display: swap`).
- `:host { all: initial; contain: layout style; }` — nothing leaks in; nothing leaks out.
- No listeners on host elements except the pill's own; no host globals; all storage namespaced `hippo:<partnerKey>:`.
- Global error boundary: any SDK exception → panel swaps to the offline edge state; the error never reaches the host's `window.onerror`.
- **Hard rule from baseline:** solid card backgrounds inside scroll containers; `backdrop-filter` only on full-surface overlays (iOS/WebKit).

## 3. Rendering — server-driven card registry

```
frames (SSE) → protocol parse (Zod safeParse) → thread store → <Thread> → CardRegistry[frame.type] → component
```

- `CardRegistry: Record<CardType, FunctionComponent<CardProps>>` — one Preact component per card type: `ResearchBrief`, `LiveBar`, `OrderTicket`, `Lifecycle*`, `AdviceDecline`, `Positions`, `RejectionTicket`, `Thinking`, `Skeleton`, `Banner`.
- **Unknown type or failed parse → `FallbackCard`** (renders `frame.fallback` prose + optional link). This is what makes the protocol additive-only in practice — old SDKs degrade, never crash.
- Cards are pure: props in, DOM out. All timing/content decisions are server-side (`thinking` rotation lines, skeleton shapes, pulse events arrive as data).
- Streaming text: `research_brief` supports `delta` frames appending to the active card (token streaming without re-render storms — signals update text nodes surgically).

## 4. State — @preact/signals stores

| Store | Holds |
|---|---|
| `session` | JWT session, config blob (venue name, locale set, feature flags), consent state |
| `thread` | ordered frames, active streaming card, play-in staging |
| `orders` | open-orders strip pills, expanded pill, lifecycle updates (keyed by venue order ID) |
| `connection` | `live / degraded / stale / offline` — drives banners, cache badges, composer lock |
| `prefs` | posture, language, memory toggle, onboarding completion (localStorage, namespaced) |

No global state library needed; signals give fine-grained updates for live numbers (fills, prices) without VDOM churn.

## 5. Transport client

- **SSE primary** (`fetch` + ReadableStream parser — works through proxies, resumable via `Last-Event-ID`), WS upgrade path later for bidirectional volume; uplinks (user text, chip taps, confirms, feedback, consent) go over `POST /v1/turns`.
- Reconnect: exponential backoff + jitter; on resume, gateway replays missed frames from the session journal (gap-free lifecycle guarantees live server-side).
- **Offline queue:** failed uplinks persist locally; retry-in-place per edge state №6 — nothing the trader wrote is ever lost.
- Connection state machine feeds the `connection` store; degraded/stale/offline UI is pure derivation.

## 6. Postures & mount

`PostureManager` — `min` (pill) / `dock` (360px, pushes host content? **no** — fixed overlay beside content, host untouched) / `max` (620px + scrim) on web; `pill / sheet / full` on mobile (pointer-media detection + config override). Transitions are CSS-driven, respect `prefers-reduced-motion`. First-open play-in uses the prototype's staged CSS animation, degrading to instantly-visible.

## 7. i18n & RTL

- Strings via a tiny message catalog (no i18n framework — ~80 UI strings); answer language is a **generation parameter** sent with the session, not client translation.
- EN / हिन्दी / Hinglish + عربي; `dir="rtl"` on the shadow root flips structure; numerals and card grammar hold (mono numerals stay LTR inside RTL via `unicode-bidi`).

## 8. Onboarding & overlays

Onboarding steps (welcome/confetti → hero → consent → ground rules), settings sheet, and share overlay are lazy sub-chunks of panel.js — first-paint of the panel stays lean. Confetti is a ~40-line canvas, not a library. Consent screen rows are config-driven (jurisdiction switch per [[Open Decisions]] #2).

## 9. Testing

1. **Vitest** — protocol parsing, stores, transport state machine, card prop mapping.
2. **Playwright golden-conversation suite** — SDK against `mock-gateway`; screenshots per card × state × posture × locale (incl. RTL); this is the visual regression net.
3. **Hostile-host page** — deliberately awful CSS (`* { all: unset !important }`, weird z-index, filters) + assertions that host metrics (CLS, style bleed) are untouched.
4. **Protocol fuzzing** — malformed/unknown frames must yield `FallbackCard`, never a throw.
5. **Size gate in CI** — loader ≤ 5KB gz fails the build if exceeded.

Related: [[08 PRD v1]] · [[02 Thin Client SDK]] (productionization scope) · [[10 BE Architecture]] (the other side of the wire)
