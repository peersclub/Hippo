# SDK Stop-Line Review — Phase 1 exit gate

**Date:** 2026-07-31 · **Scope:** every `.ts`/`.tsx` in `packages/sdk/src` (30 files, full read) · **Law under audit:** *the SDK only draws what the server sends* — it never invents, computes, or alters financial content client-side. Server frames carry display-ready strings; client chrome (buttons, i18n UI copy) is allowed; financial content is not.

## Verdict

**The card layer passes; the live-price path does not.** `rows[]`, money strings, `statusLine`, `sizeDisplay`, `fillPct` are drawn verbatim throughout — no qty×price, fee, PnL, or margin math exists anywhere in the tree. The violations cluster in one architectural spot (the client/host price feed, a *deliberate* design) plus a handful of small honesty bugs. **Gate status: CONDITIONAL — the six small fixes have shipped (see below); the four product decisions still need an owner's call.**

## Product decisions still open (Victor/Ram — these are design choices, not bugs)

All four remain open. Nothing in the August cleanup touched `price.ts`, `bridge.ts` or the `draft.ts` leverage defaults, so the live-price path is exactly as audited.


1. **Non-server price can become a submitted order's limit price** (`cards.tsx:501` — switching to limit with an empty field autofills from `livePrice`, which in `client`/`host` mode is a Binance tick or a host postMessage, never server data). Server-side re-validation is the only backstop. *Options: (a) accept + document (server revalidates), (b) only autofill from server `price_tick`s, (c) send the draft without price and let the gateway quote it.*
2. **The SDK sources market data from Binance directly** (`price.ts:38`, `client` mode) and formats it with its own rounding rules (`price.ts:45-48`). This IS the priceSource=client feature working as designed — but it means displayed prices bypass the gateway entirely. *Decide: is priceSource=client compatible with the stop line, or should production partners be limited to server/host modes?*
3. **Invented leverage defaults** (`draft.ts:15` — a frame without `maxLeverage` gets a client-invented 50× cap and 10× start, and the invented value submits). *Options: require the fields in the frame schema (protocol bump), or grey the slider out when absent.*
4. **The host bridge always overrides the price display** (`bridge.ts` installs unconditionally; a host postMessage price overwrites server ticks even under priceSource=server, and nothing records provenance). *Decide: should priceSource=server lock the display to server ticks?*

## Fixed — the six uncontroversial findings (August 2026)

All six shipped together as one commit, `02313a0` — *fix(sdk): six stop-line honesty fixes — draw only what the server sends* — on branch `fix/stop-line-six`, [PR #101](https://github.com/peersclub/Hippo/pull/101). Each one was a place where the SDK put words on the screen that the server had not written.

**The filled receipt now keeps the server's own sentence.** A terminal `lifecycle` frame's `statusLine` is the server's description of a completed trade, and the card was throwing it away in favour of a localized "Order filled". The new `terminalTitle()` in `lifecycle-view.ts` draws the server's line whenever there is one and reaches for the localized string only when a filled frame arrives without a `statusLine` at all; a non-filled terminal without one gets no invented headline.

**The share card's LIVE badge is now gated on `frame.live`,** exactly as the in-thread brief card has always been. A stale brief no longer exports wearing a live badge.

**The share card carries the whole brief.** It used to render `paragraphs[0]` and nothing else, so a caveat or qualifier the server had placed in paragraph two silently disappeared from the most distributable surface we have. Every paragraph is drawn now; a long brief scrolls inside a bounded prose block rather than being cut.

**The fill value is no longer located by an English-only regex.** The old `fillCaption()` searched the row labels for `/^filled$/i` and recomposed the caption as `FILLED <value>`, which meant a frame whose rows came back in any other language rendered a bare `FILLED` with the money missing. There is no structural field on `LifecycleFrame` that carries the fill value, so rather than adding more locale regexes the in-flight card now renders the server's `rows[]` verbatim — the fill quantity appears in the server's own words, with the server's own label — and the meter beside the bar has been reduced to `fillMeter()`, which returns nothing but the server's percentage. If the protocol ever grows a structural fill field, that helper is where it belongs; the comment in `lifecycle-view.ts` says so.

**The positions card no longer asserts a flat account.** An empty `rows[]` can mean the trader holds nothing, but it can equally mean a venue fetch failed or a multi-venue answer came back partial, and the SDK cannot tell those apart — so "No open positions yet — trades you place appear here live" was a financial claim the client invented. `PositionsFrame` gained an optional, additive `emptyText` so the server can author the empty state itself; when it does the card draws that verbatim, and when it doesn't the card falls back to a neutral "Nothing to show" that asserts nothing about the account. That fallback is a real catalog key (`positions_empty`) in all four locales, closing the un-localized gap at the same time.

**The fabricated share URL is gone.** `shareSlug()` and `shareLink()` built a plausible-looking `hippo.app/s/<slug>` from an FNV hash of the frame id; the card printed it and the button copied it, and it resolved nowhere. Both functions are deleted rather than merely unused, the card shows no address, and the button now copies the brief's own prose (the same text as the ⧉ COPY affordance, disclaimer included). The link comes back when a share service issues a real slug on the frame.

Tests cover each fix as pure view-model cases in the existing node suite — a non-live brief exporting without the badge, a two-paragraph brief sharing both, an empty positions frame making no claim, a server `statusLine` surviving on a filled order, and the share module exporting no link builder at all. Constraints held: tokens-only CSS, all new chrome through the i18n catalog in four locales, loader still 1.54 KB gz against the 5 KB gate.

## Noted, acceptable as-is (documented rationale)

- Client `⚠ N MIN OLD` staleness math over server `asOfIso` (`freshness.ts`) — client-authored but conservative, and the honest direction.
- Static PLACED✓/WORKING journey before the first lifecycle frame — careful (never advances client-side; PLACED = the HTTP 200).
- 20s stream watchdog declaring "BRIEF INTERRUPTED" — a false positive is possible on a slow-but-alive stream, but the alternative (spinner forever) is worse. Consider raising to 30s.
- `MARKET INFORMATION · NOT INVESTMENT ADVICE` — client-side by design, protective.
- Hardcoded English chrome outside i18n (`CANCEL`, `MARKET BRIEF`, onboarding copy, `overlays.tsx` guarantees) — a **localization** gap, not a stop-line breach; fold into the i18n backlog. Exception: `overlays.tsx:321/328` make execution-behavior and editorial claims that belong to counsel-owned copy (Open Decisions #2).

## Method

Independent full-tree read (subagent sweep) verified against the source; findings cite `file:line` as of 2026-07-31 — the six fixes above have since moved those lines. The i18n catalogs were checked key-by-key across all four locales — clean of financial claims.
