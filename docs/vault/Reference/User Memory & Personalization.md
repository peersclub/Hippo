---
title: User Memory & Personalization — design
type: reference
tags: [memory, personalization, cache, privacy, product-law]
updated: 2026-07-16
grounding:
  - "services/memory (Persona store: optIn/experienceLevel/followedAssets/openThreads, per-partner+user)"
  - "services/intelligence/main.py (persona → concept depth only; briefs fleet-wide cacheable)"
  - "services/gateway/src/orchestrator/memory.ts (graceful-degrade read)"
---

# User Memory & Personalization

See also: [[Roadmap]] · [[Open Decisions]] · [[Ram JSX vs Victor Dev]]

> [!summary] The one law everything follows
> **Personalization must never fragment the answer cache, and must never become advice.** The answer cache is the unit-economics engine — briefs are cached fleet-wide by (question, symbol, market-window). Memory buys personalization *around* that cacheable core, not inside it. And because Hippo's product law is "explain, never advise," memory personalizes **depth, continuity, and relevance — never selection**. Those two constraints determine the entire design.

---

## 1. The central tension (why naïve personalization would break Hippo)

Two forces pull against each other:

- **Unit economics** depend on a high cache hit rate. A brief for "why is BTC down?" is generated once and served to thousands. If the cache key included a user id, every user would miss → generation cost explodes → the flat-fee-per-MAU model dies.
- **Personalization** wants each answer shaped to the person.

The resolution memory v1 already encodes, generalized into a rule:

> **Split every response into a fleet-cacheable FACTUAL CORE and a per-user PRESENTATION LAYER. Personalize only the presentation layer — and only along axes cheap enough to either bucket the cache or skip the model entirely.**

The corollary that makes it work:

> **Personalize on LOW-CARDINALITY axes so the cache buckets instead of fragments.** Experience level has 3 values; language has 3. A concept answer keyed by (concept, level, language) is 9 cache buckets, not N-per-user — hit rate stays high. **High-cardinality signals (per-user history, followed assets) never enter model generation** — they only reorder or annotate already-generated output, client/gateway-side, with no LLM call.

---

## 2. Memory model — what we store, and what we refuse to

`Persona`, tiered by how it's obtained and how fast it decays:

| Tier | Fields (v1) | Source | Decay | Cache role |
|---|---|---|---|---|
| **Declared** | `experienceLevel`, (v2) `language`, (v2) `conceptsSeen` | explicit / admin-set | stable | low-cardinality → **cache bucket key** |
| **Followed** | `followedAssets[≤8]` | explicit "follow" | slow | high-cardinality → **reorder only, never generation** |
| **Continuity** | `openThreads[≤3]` | recent turns | fast (recency-capped) | per-user → cheap templating, no cache |
| **Refused** | trade history, balances, P&L, behavioral profile | — | — | **never stored** |

The "Refused" row is load-bearing. Hippo holds **no positions, no P&L, no trade behavior** in memory. That's not just privacy hygiene — it's what structurally prevents personalization from sliding into advice (§5). Balances/positions live only at the venue and pass through per-request; they are never persisted into the persona.

**Scoping (data-boundary L1):** every key is `(partnerId, userId)`. The same human on two partner exchanges has two disjoint personas. Non-negotiable — it's a B2B trust promise.

---

## 3. Consent & privacy (the accrual contract)

- **Opt-in gated accrual.** Data accrues *only* while `optIn` is true (`applyUpdate` enforces this in one place, shared by both store backings so it can't drift). Consent and the first memory can ride the same uplink.
- **`clear` ≠ opt-out.** Clearing wipes data but preserves the opt-in choice; a user who cleared still has memory *on* going forward. **`delete`** (admin purge) removes everything including opt-in.
- **Invited, never imposed** (onboarding): "Not now" persists nothing and is re-offered at the door until consent is given.
- **Jurisdiction lever (Open Decisions #2):** the Layer-2 (anonymized-conversations) consent is `disclosed-in-terms` for the India pilot; flip to an active `checkbox` where counsel requires. The consent row's `control` is a one-word change.
- **Region residency:** the Postgres `users_memory` table lives in the regional pod (in-region PII, BE doc §4).
- **Admin visibility:** operators can list and hard-delete personas (token-guarded, fail-closed) — the "user-wise memory management" panel. `experienceLevel` has an admin write-path (the only way to set it today).

---

## 4. How memory serves personalized results — surface by surface

Each surface is tagged with WHERE it happens and whether it's cache-safe.

1. **Concept depth** *(built)* — `experienceLevel` calibrates how much a "what is funding rate?" answer explains. **Where:** intelligence generation. **Cache:** safe — bucket the concept cache by `level` (3 buckets). A `new` user gets the analogy; a `pro` gets the mechanism. Briefs (live facts) are untouched and stay fleet-wide.
2. **Continuity / "pick up where we left off"** *(v2)* — `openThreads` power a returning-user nudge ("Last time you were looking at SOL funding — still watching it?"). **Where:** gateway assembly (templated) or a `nudge` frame. **Cache:** N/A — no LLM, just the thread text.
3. **Relevance ordering** *(v2)* — `followedAssets` reorder suggested-query chips and the ambient `pulse` tag toward what the user tracks. **Where:** gateway/SDK reordering of server-provided options. **Cache:** safe — the *set* of options is generated fleet-wide; only the *order* is per-user, computed with zero model cost.
4. **Language** *(partly built)* — detected per-turn today; remembering the preference lets the very first turn and the chrome default to it. **Where:** low-cardinality bucket (3) → cache-safe, same as concept depth.
5. **Presentation re-frame** *(v2, careful)* — the SAME cached brief given a thin per-user preamble ("You follow BTC — here's today's move") prepended client-side. **Where:** SDK/gateway assembly over cached content. **Cache:** safe — the cached brief is byte-identical; only a cheap wrapper differs.

The pattern across all five: **generate once (fleet or low-cardinality bucket), assemble per-user cheaply.**

---

## 5. The product-law boundary — personalization is NOT advice

Hippo explains, never advises. Memory makes this *harder* to hold (a system that knows you is tempted to tell you what to do), so the boundary is drawn structurally, not by prompt-wishing:

- Memory stores **no positions, no P&L, no trade outcomes** → the model literally cannot say "given your losing SOL position, you should…" because that data isn't in the persona.
- Personalization may touch **depth, continuity, ordering, language** — the *how* and *what-order* of explanation. It may **never** touch **selection** — *which* asset, *whether* to trade, *when*. "You follow BTC, here's BTC news" is relevance. "You follow BTC, you should buy more" is advice — and the output-side guardrail (ported 1:1 from the eval harness) still fires on every generated answer, personalized or not.
- Followed assets bias **what we proactively surface**, never **what we recommend**. Surfacing ≠ endorsing.

This is the line that lets "personalized" and "never advises" coexist. Any v2 feature that can't stay on the depth/continuity/ordering side of it doesn't ship.

---

## 6. Pipeline (where each layer runs)

```
uplink → gateway
  ├─ read persona (services/memory)         [graceful-degrade: null → no personalization, turn proceeds]
  ├─ intent + FACTUAL CORE (intelligence)   [fleet cache | low-cardinality bucket by level/lang]
  │     └─ output-side advice guardrail      [fires regardless of personalization]
  └─ PER-USER ASSEMBLY (gateway)             [cheap, no LLM: continuity nudge, followups reorder, preamble]
        └─ accrue persona (opt-in only)      [followAsset / openThread / level]
SDK renders; chrome locale + followed-asset ordering are client-side presentation
```

Two hard rules on this pipeline: (a) memory being down **never breaks a turn** (reads degrade to "no personalization"); (b) the factual-core cache key **never** contains `userId`.

---

## 7. v1 → v2 roadmap

- **v1 (built):** persona store, opt-in accrual, per-partner scoping, experience-calibrated concept depth, admin list/purge, graceful-degrade read.
- **v2 (next, all presentation-layer):**
  - [ ] Continuity nudge from `openThreads` (returning-user re-engagement).
  - [ ] Followed-asset reordering of followups + pulse.
  - [ ] Remembered language preference (first-turn default).
  - [ ] Concept cache **bucketed by level+language** (turn the current per-request calibration into a cacheable bucket — protects hit rate as personalization grows).
  - [ ] Lightweight experience *inference* signal (opt-in; suggests a level from question complexity, user confirms — never silent profiling).
- **Guardrails to add alongside:** a cache-key lint (fail the build if `userId` reaches a generation cache key), and a personalization-vs-advice test in the eval harness (personalized answers must still pass the no-advice gate).

---

## 8. Does it actually help? (metrics)

Personalization is only worth its complexity if it moves these, **without** dropping cache hit rate:

- **Continuity re-engagement:** % of returning opted-in users who act on the "left off" nudge.
- **Concept-depth fit:** 👎-rate on concept answers, split by experience level (should fall vs the fleet-wide baseline).
- **Relevance:** followup-chip tap-through for opted-in vs opted-out.
- **Guardrail (must-not-move):** cache hit rate for opted-in users stays within a point or two of opted-out. If personalization tanks the hit rate, it's being done in generation, not assembly — a design bug.
- **Opt-in rate** itself: the honest signal that users find the value worth the memory.

All of these ride the OTel instruments from #13 (cache hit rate is already emitted) plus a couple of new counters.
