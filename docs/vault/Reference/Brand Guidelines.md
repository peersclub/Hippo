---
title: Hippo Brand Guidelines — core
type: reference
tags: [brand, design-system, dark-glass-instrument, tokens]
updated: 2026-07-15
sources:
  - "Ram: hippo-walking-skeleton.jsx (design tokens, components, motion)"
  - "Ram: askhippo-review-bundle marketing site (mark, hero type, voice, tagline)"
  - "Victor dev: hippo-app packages/sdk/src/styles.ts (ported 1:1)"
tokens: "[[brand/hippo-tokens.css]] · [[brand/hippo-tokens.json]]"
---

# Hippo Brand Guidelines — core

See also: [[Ram JSX vs Victor Dev]] · [[Roadmap]] · tokens: `Reference/brand/hippo-tokens.{css,json}`

> [!summary] The idea in one line
> **Dark Glass Instrument.** A calm, instrument-grade dark surface where a single amber accent carries all the brand signal, and market colour (green up / red down) is *information*, never decoration. Explains markets, never advises.

This is the **brand core** — mark, palette, type, accent rule, primitives, voice. Not a full component library; just enough to keep every surface unmistakably Hippo. Marketing site and product SDK already share these values; this doc is the single reconciled reference.

---

## 1. The mark

The **"H" monogram** — an amber rounded square, Outfit 700, ink `#1A1405` letter.

- Radius ≈ 30% of the mark size; letter ≈ 58% of the size.
- Clear space: at least half the mark's width on all sides.
- On dark surfaces the mark is amber-on-dark; never invert the amber.
- Wordmark: **AskHippo** (one word, marketing). In-product header label: **Ask Hippo** (two words) beside the mark.

---

## 2. Palette — Dark Glass Instrument

Dark is the **locked hero**. Light is a secondary lean (darkened accent for legibility).

| Role | Token | Dark | Light |
|---|---|---|---|
| App background | `--hippo-bg` | `#0E1014` | `#E9ECF1` |
| Panel | `--hippo-panel` | `#14161C` | `#F7F8FA` |
| Card surface | `--hippo-card` | `#232733` | `#FFFFFF` |
| Nested cell | `--hippo-card-2` | `#262B36` | `#F0F2F6` |
| **Accent (amber)** | `--hippo-amber` | `#F0B94A` | `#B98A1E` |
| Text/mark on amber | `--hippo-amber-ink` | `#1A1405` | `#FFFFFF` |
| Up / positive | `--hippo-up` | `#2EC48D` | `#149469` |
| Down / negative | `--hippo-down` | `#FF8585` | `#D94F4F` |
| Text — primary | `--hippo-text-hi` | `#E9EBF0` | ink .92 |
| Text — body | `--hippo-text-mid` | `#B8BDC9` | ink .62 |
| Text — label | `--hippo-text-dim` | `#8A8F9C` | ink .46 |
| Text — eyebrow/meta | `--hippo-text-faint` | `#6A7080` | ink .42 |
| Hairline | `--hippo-hairline` | white .07 | ink .09 |

Surfaces inside a scroll container are **solid** — `backdrop-filter`/glass blur is reserved for full-surface overlays only (WebKit performance).

---

## 3. Typography

| Role | Family | Weights | Used for |
|---|---|---|---|
| Display | **Outfit** | 400–800 (hero 700/800) | headlines, the mark, hero |
| Body | **Inter** | 400/500/600 | paragraphs, UI text |
| Data / labels | **IBM Plex Mono** | 400/500/600 | numbers, eyebrows, status lines, ticket rows |

**Eyebrow treatment** (the signature label): IBM Plex Mono, ~10px, `letter-spacing: 0.12em`, uppercase, in `--hippo-text-faint`. Every card opens with one.

Numbers are always mono — prices, sizes, fees, P&L, timestamps. This is what makes it read as an *instrument*.

---

## 4. Accent discipline (the one rule that matters)

- **Amber `#F0B94A` is the only brand accent.** Buttons, active states, the mark, "no advice" markers, focus rings — all amber.
- **Green/red are semantic, never decorative.** Up/down colour appears only on real market direction, buy/sell sides, and fill status. Never use them for emphasis, borders, or styling.
- One accent + strictly semantic colour is what keeps the surface calm and credible rather than dashboard-noisy.

---

## 5. Core primitives (basic detailing)

| Primitive | Detail |
|---|---|
| **Card** | `--hippo-card` fill, `1px --hippo-hairline` border, `--hippo-radius-card` (16px), ~16px padding, opens with an eyebrow. |
| **Order ticket** | Same, but `1px` amber border (`rgba(240,185,74,.55)`) — the one card allowed an amber outline, because it's the action moment. |
| **Pill / chip** | `--hippo-radius-pill` (999px), hairline border, mono ~10.5px; hover lifts border to amber. Suggested-query and follow-up chips. |
| **Button (primary)** | Amber fill, `--hippo-amber-ink` text, Outfit 600, `--hippo-radius-button` (12px). |
| **Stat tile** | `--hippo-card-2` cell in a hairline-gap grid, eyebrow label + mono value; value tinted up/down only if directional. |
| **Focus** | `1px`/`2px` amber outline, 1px offset — always visible. |

---

## 6. Voice

- **Product truth:** *"Explains markets. Never advises. You confirm every order on KoinBX."*
- **Tagline:** *"The trading agent your traders will ask for."*
- Plain, factual, confident. Never hype, never a recommendation, never a prediction.

**Do**
- State facts and explain *why* ("BTC is down 4.2% as funding flipped negative").
- Decline advice plainly and pivot to what's true ("I don't call tops — here's what's moving").

**Don't**
- No "should you buy", no signals, no P&L verdicts, no emoji in product copy.
- No second accent colour; no glass blur inside scrolling content.

---

## Motion (light touch)

`card-in` (fade + 10px rise, 0.32s) · `pulse` (waiting/live) · `glow` (idle Ask-Hippo pill) · `flash` (in-place refresh). All wrapped in `@media (prefers-reduced-motion: reduce)`.

---

## Open brand items
- [ ] `positions` P&L colouring (`tone: pos/neg`) vs "neutral facts only" — see [[Ram JSX vs Victor Dev]] #product-law. Resolve before P&L ships coloured.
- [ ] Light theme: defined in tokens, not yet built in the SDK — decide if it ships for pilot.
- [ ] Wire `hippo-tokens.css` into the SDK (`styles.ts` currently inlines the values) so brand + code have one source.
