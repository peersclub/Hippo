---
title: Ram JSX vs Victor Dev — sync check
type: reference
tags: [protocol, sync, sdk, walking-skeleton, knowledge]
updated: 2026-07-15
sources:
  - "Ram: /Downloads/Hippo - Web + JSX/hippo-walking-skeleton.jsx (Card Protocol v0.1)"
  - "Ram: /Downloads/Hippo - Web + JSX/askhippo-review-bundle/ (marketing site + proto.html)"
  - "Victor dev: peersclub/Hippo hippo-app — packages/protocol/src/frames.ts (v1), packages/sdk"
---

# Ram JSX vs Victor Dev — sync check

See also: [[Roadmap]] · [[Open Decisions]] · [[Development Documentation]]

> [!summary] Verdict
> **Conceptually in sync, field-level diverged.** Ram's walking skeleton and Victor's dev codebase share the same card vocabulary, the same product law (explains-never-advises · Approach-A handoff · simulated-vs-live honesty), and the same Dark Glass Instrument design tokens. But the wire format has intentionally moved on: Victor's `packages/protocol` is **Card Protocol v1**, a deliberate evolution of Ram's **v0.1**. A client written to Ram's v0.1 JSON would NOT deserialize against v1 without a field-mapping layer.
>
> Nothing here is a regression — it's protocol maturation. This doc is the map between the two so future work reconciles them deliberately.

---

## What was compared

| Source | Artifact | Role |
|---|---|---|
| Ram | `hippo-walking-skeleton.jsx` (897 lines) | **Canonical Phase-1 client spec** — Card Protocol v0.1 envelope + renderers + model-router config drawer |
| Ram | `askhippo-review-bundle/proto.html` | Visual agent prototype ("Ask Hippo") — the living UX spec |
| Ram | `askhippo-review-bundle/{home,about,exchanges,product,trust,insights,index}.html` | **Marketing website** — out of scope for the dev SDK (see below) |
| Victor | `packages/protocol/src/frames.ts` | Card Protocol **v1** — Zod schemas, source of truth in code |
| Victor | `packages/sdk/src/cards.tsx`, `styles.ts` | SDK renderers + Dark Glass Instrument tokens |

**Out of scope:** the seven marketing HTML pages are Ram's public website (`AskHippo — The trading agent your traders will ask for`). `hippo-app` implements the *embedded agent* (SDK + gateway + intelligence), not the marketing site — they are separate tracks and were not compared.

---

## The two systematic differences

1. **Naming convention:** Ram is `snake_case` (`card_type`, `body_md`, `est_price`); Victor is `camelCase` (`type`, `paragraphs`, `rows`). Every field name below reflects this.
2. **Envelope model:** Ram batches cards in one envelope with a `surface` sidecar; Victor streams **discrete frames** over SSE, each self-describing.

### Envelope / surface

| Ram v0.1 | Victor v1 | Status |
|---|---|---|
| `{protocol_version:"0.1", cards:[…], surface:{…}}` | Individual `Frame` objects (discriminated union on `type`), each `{v:1, id, ts, fallback?}` | ⚠ decomposed |
| `protocol_version: "0.1"` (string) | `v: 1` (int), per frame | ⚠ changed |
| `surface.suggested_queries: [q1,q2,q3]` | per-frame `followups: string[]` (on research_brief / advice_decline) | ⚠ moved onto frames |
| `surface.mode: "normal" \| "degraded"` | `BannerFrame { kind: "degraded" \| "offline" \| "info" }` | ⚠ promoted to a frame |
| — | `fallback: { text, href? }` on every frame | ➕ v1 addition (forward-compat) |

---

## Card-type mapping (Ram → Victor)

| Ram `card_type` | Victor `type` | Name | Field-level notes |
|---|---|---|---|
| `research_brief` | `research_brief` | ✓ | `body_md` (string) → `paragraphs` (string[]); `stats[{label,value,direction}]` → `stats[{k,v,tone}]` (Ram exactly 3, Victor max 6); `sparkline{points,window}` → `spark{points,captionLeft,captionRight}`; `sources[{label}]` → `sources[string]`; `cache{served_from_cache,cached_age_min}` folded into `liveBar{cached,cacheAge}` |
| `order_ticket` | `order_ticket` | ✓ | **Major:** explicit `est_price`/`est_fees`/`est_total`/`instrument`/`size` → generic `rows[{label,value}]` + `sideLabel`. Deliberate — server formats all money, SDK never computes it. `cta{label,action}` → `cta` (string); `seam_footer` → `footnote` |
| `order_lifecycle` | `lifecycle` | ⚠ **renamed** | `status` → `phase` (Victor adds `partial`/`cancelled`/`expired`); explicit `avg_fill`/`real_fees`/`venue_order_id` → `rows[]` + `venueOrderId` + `statusLine` + `fillPct` + `cancellable` |
| `advice_decline` | `advice_decline` | ✓ | `decline_text` → `message`; `fact_rows[{label,value}]` → `facts[{icon,text}]` (+ `pivotTitle`, `badge`); `follow_up_chips` → `followups` |
| `positions` | `positions` | ✓ | Ram `rows{asset,qty,value}` + `note` → Victor `rows{instrument,size,entry,mark,pnl,tone}`. **See product-law watch below.** |
| `rejection_ticket` | `rejection_ticket` | ✓ | `plain_reason` → `reason`; `fix` (string) → `fix{label,action}`; Victor adds `ticketId?`, `title` |
| `skeleton` | `skeleton` | ✓ | Victor adds `shape: "brief"\|"ticket"\|"positions"` |
| `thinking` (client-only) | `thinking` (server frame) | ✓ | Ram rotates lines client-side; Victor server-authors `lines[]` |
| — | `brief_delta` | ➕ | Streaming research prose — accumulates into a live-filling brief, replaced by the authoritative `research_brief` |
| — | `pulse` | ➕ | Ambient market pulse tag |
| — | `orders_snapshot` | ➕ | The orders strip as a server frame (Ram builds it client-side from handoffs) |
| — | `user_echo` | ➕ | Server echo of the user's message |

Legend: ✓ same card, present both sides · ⚠ present but diverged · ➕ Victor-only (v1 additions)

**SDK ↔ protocol are internally consistent:** `cards.tsx` renders exactly the v1 frame set (research_brief, order_ticket, lifecycle, advice_decline, positions, rejection_ticket, thinking, skeleton, brief_delta, banner, user_echo) + a fallback card. No drift between Victor's protocol and Victor's SDK.

---

## Design tokens — in sync ✓

`styles.ts` says "ported 1:1 from the prototype," and it holds:

| Token | Ram JSX | Victor SDK |
|---|---|---|
| Accent (amber) | `#F0B94A` | `#F0B94A` ✓ |
| Up / Down | `#2EC48D` / `#FF8585` | `#2EC48D` / `#FF8585` ✓ |
| Card surface | `#232733` | `#232733` ✓ |
| Panel/bg | `#0E1014` / `#14161C` | gradient `#15171D → #101217` (within a hair) |
| Fonts | Outfit / Inter / IBM Plex Mono | Outfit / Inter / IBM Plex Mono ✓ |

Both commit to Dark Glass Instrument as the locked hero; Ram's JSX also carries a secondary light lean (Victor's SDK is dark-only so far — a minor gap, not a conflict).

---

## Product-law watch item ⚠

Ram's system prompt is explicit for `positions`: *"Values are neutral facts only. NEVER add P&L verdicts or judgments."* Victor's `PositionsFrame` carries `pnl` (string) **and** `tone: pos|neg|neutral`.

- `pnl` as a formatted number is arguably a neutral fact.
- `tone` (green/red coloring) is a mild judgment and may cross Ram's line.

**Action:** confirm with Ram whether coloring P&L is acceptable, or whether `tone` on positions should be forced `neutral`. This is the one place the two could disagree on *product law*, not just field shape.

---

## Knowledge for Claude to proceed

- **Source of truth for the wire format is code:** `packages/protocol/src/frames.ts` (v1). Treat it as current; Ram's v0.1 JSON in the JSX is the *historical* shape.
- **Source of truth for UX/behaviour is the prototype** (memory rule: "where prose and prototype disagree, prototype wins"). That rule governs *look and interaction*, not the v1 field names — those have intentionally advanced past v0.1.
- **When reconciling Ram → dev:** map by card type (table above), not by field name. Expect snake→camel, `body_md`→`paragraphs`, explicit money fields→`rows[]`, `status`→`phase`, `order_lifecycle`→`lifecycle`.
- **If a Ram-authored envelope must be consumed** (e.g. reusing the JSX's Claude system prompt), add a v0.1→v1 adapter rather than reverting the protocol.
- **Do not delete v1 fields** — the protocol is additive-only within v1.

### Open items
- [ ] Product law: `positions.tone` / `pnl` coloring vs "neutral facts only" — confirm with Ram (#product-law).
- [ ] Light theme: Ram has a light lean; Victor SDK is dark-only — decide if light ships for pilot.
- [ ] `surface.suggested_queries` vs per-frame `followups` — confirm the decomposed model is the accepted direction (it reads as a clean improvement; just needs Ram's sign-off).
- [ ] Marketing site (`askhippo-review-bundle/*.html`) — track separately; not part of `hippo-app`.
