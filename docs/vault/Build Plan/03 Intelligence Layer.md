# 03 · Intelligence Layer

**Constraints from the memo (§7–9):** open-source models only, no frontier APIs in production; tiered by workload; model selection by bake-off, not reputation; the guardrail (facts, never advice) is simultaneously the trust position, the caching economics, and the regulatory line.

---

## Pipeline per user turn

```
user text ──► Intent Engine (7–8B, regional pod)
              ├─ research question ──► cache lookup ──► HIT: personalize thinly, serve
              │                                   └──► MISS: Research Engine (~30B, global)
              │                                          └─ market-data retrieval → grounded brief → cache
              ├─ order intent ──► param extraction → Execution Seam → order ticket card
              ├─ advice bait ──► advice-decline card (decline + factual pivot + chips)
              ├─ concept question ──► explanation calibrated to user's experience level (memory)
              └─ portfolio query ──► positions/P&L via adapter (regional, never cached)
```

## Components

**Intent Engine** — 7–8B class, high-volume, latency-critical: intent classification, order construction (instrument/side/size/type normalization), memory updates. Latency budget: classification < 300ms p95.

**Research Engine** — the bake-off winner. Shortlist (all Apache 2.0): Qwen3.6-35B-A3B MoE (primary — small-model speed, near-32B quality), Qwen3-32B dense (production reference, single H100), QwQ-32B (quality ceiling), 70B-class as baseline only. Architecture: strong general model over **live market-data retrieval** — no finance fine-tunes (rejected deliberately). Launch gate: within 5% of the 70B baseline on accuracy + advice-avoidance, no hallucination gap.

**Market Data Service** — price action, funding, on-chain, liquidations, news. Every research answer is a fact about a moment: as-of timestamps are first-class, refresh re-grounds. Note Ram's workstream: what data the pilot partner pipes free swings the footprint ₹0.4–0.8L/month.

**Answer Cache — the unit-economics engine.** Market-level explanations are identical across users *because answers are factual, not personalized opinions* — generated once, served fleet-wide; only a thin personalization layer (name, their position context, experience-calibrated depth) runs per user. Correlated demand spikes become the cheapest traffic. Design points:
- Cache key: (question canonical form, asset, market-state window). Intent engine canonicalizes phrasings to maximize hits — suggested-query chips are a deliberate cache lever.
- TTL tied to market volatility; stale answers are *served labeled* (CACHED BRIEF badge) during degraded mode, never disguised.
- **Cache hit rate is the pilot's most important single metric** — it underwrites the flat rate card.

**Memory Service** — persona, not surveillance: assets followed, experience level, open threads. Opt-in toggle, clearable in settings, personalizes explanation depth only. Regional pod, per-partner scoped.

**Guardrail — advice-avoidance as product law.** No recommendations, signals, predictions, or portfolio advice. Implemented in layers: intent-level detection of advice-baiting → forced routing to the decline card (decline with conviction, pivot to "what's true about X right now", follow-up chips back to legitimate ground) → output-side checker on research answers. Consistency under baiting is a launch gate with a score, continuously re-tested by the eval harness. This is demonstrable enforcement for partner compliance reviews, not a policy document.

**Localization** — answer language EN/हिन्दी/Hinglish (Hinglish is first-class: ≥25% of the bake-off set), عربي/RTL for Gulf venues. Language is a generation parameter, not a translation pass.

## Serving

vLLM (or equivalent) on rented certified GPU cloud; regional pods for intent/memory/seam, one global research+cache tier. Reserved floor + volatility-triggered pre-warmed burst — the monitor watches the *market*, not just the load, and warms capacity before the query wave lands. Fleet utilization target 60–75% sustained; utilization telemetry is the sole trigger for capacity expansion.

Related: [[06 Eval Harness & Data]] · [[07 Infrastructure & Pods]] · [[01 System Architecture]]
