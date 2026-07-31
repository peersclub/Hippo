# SDK Stop-Line Review — Phase 1 exit gate

**Date:** 2026-07-31 · **Scope:** every `.ts`/`.tsx` in `packages/sdk/src` (30 files, full read) · **Law under audit:** *the SDK only draws what the server sends* — it never invents, computes, or alters financial content client-side. Server frames carry display-ready strings; client chrome (buttons, i18n UI copy) is allowed; financial content is not.

## Verdict

**The card layer passes; the live-price path does not.** `rows[]`, money strings, `statusLine`, `sizeDisplay`, `fillPct` are drawn verbatim throughout — no qty×price, fee, PnL, or margin math exists anywhere in the tree. The violations cluster in one architectural spot (the client/host price feed, a *deliberate* design) plus a handful of small honesty bugs. **Gate status: CONDITIONAL — the four product decisions below need an owner's call; the six small fixes are uncontroversial.**

## Product decisions needed (Victor/Ram — these are design choices, not bugs)

1. **Non-server price can become a submitted order's limit price** (`cards.tsx:501` — switching to limit with an empty field autofills from `livePrice`, which in `client`/`host` mode is a Binance tick or a host postMessage, never server data). Server-side re-validation is the only backstop. *Options: (a) accept + document (server revalidates), (b) only autofill from server `price_tick`s, (c) send the draft without price and let the gateway quote it.*
2. **The SDK sources market data from Binance directly** (`price.ts:38`, `client` mode) and formats it with its own rounding rules (`price.ts:45-48`). This IS the priceSource=client feature working as designed — but it means displayed prices bypass the gateway entirely. *Decide: is priceSource=client compatible with the stop line, or should production partners be limited to server/host modes?*
3. **Invented leverage defaults** (`draft.ts:15` — a frame without `maxLeverage` gets a client-invented 50× cap and 10× start, and the invented value submits). *Options: require the fields in the frame schema (protocol bump), or grey the slider out when absent.*
4. **The host bridge always overrides the price display** (`bridge.ts` installs unconditionally; a host postMessage price overwrites server ticks even under priceSource=server, and nothing records provenance). *Decide: should priceSource=server lock the display to server ticks?*

## Uncontroversial fixes (queue as one cleanup PR)

- `cards.tsx:674` — filled orders **discard the server's `statusLine`** for a client-localized "Order filled". Use the server's when present.
- `overlays.tsx:477` — share card's **LIVE badge is unconditional**; a stale brief exports as LIVE. Gate on `frame.live` like `cards.tsx:237` does.
- `overlays.tsx:480` — share card **truncates the brief to paragraph 1**; a server caveat in paragraph 2 is dropped from the shared artifact. Include all paragraphs (or the server marks a shareable summary).
- `lifecycle-view.ts:137` — fill value located by **English-only regex** `/^filled$/i` on row labels; non-English frames render bare `FILLED`. Needs a structural field, not label matching.
- `cards.tsx:738` — "No open positions yet" asserted from `rows.length === 0`; any empty-for-other-reasons frame reads as a flat account. Server should send an explicit empty-state flag/text (it already authors empty states elsewhere).
- `share.ts:19` — the share card fabricates a plausible-looking `hippo.app/s/…` URL that doesn't resolve. Hide the link until the share service exists.

## Noted, acceptable as-is (documented rationale)

- Client `⚠ N MIN OLD` staleness math over server `asOfIso` (`freshness.ts`) — client-authored but conservative, and the honest direction.
- Static PLACED✓/WORKING journey before the first lifecycle frame — careful (never advances client-side; PLACED = the HTTP 200).
- 20s stream watchdog declaring "BRIEF INTERRUPTED" — a false positive is possible on a slow-but-alive stream, but the alternative (spinner forever) is worse. Consider raising to 30s.
- `MARKET INFORMATION · NOT INVESTMENT ADVICE` — client-side by design, protective.
- Hardcoded English chrome outside i18n (`CANCEL`, `MARKET BRIEF`, onboarding copy, `overlays.tsx` guarantees) — a **localization** gap, not a stop-line breach; fold into the i18n backlog. Exception: `overlays.tsx:321/328` make execution-behavior and editorial claims that belong to counsel-owned copy (Open Decisions #2).

## Method

Independent full-tree read (subagent sweep) verified against the source; findings cite `file:line`. The i18n catalogs were checked key-by-key across all four locales — clean of financial claims.
