# 07 · Infrastructure & Pods

**Memo positions (§8, §9, §12):** trusted GPU cloud only (decentralized marketplaces rejected — can't survive a partner security review); rent, don't buy pre-fundraise; regional pods for sovereignty, one global research/cache tier; pooling is the margin engine.

---

## Topology

```
GLOBAL (no user data by design)
├── Research engine cluster (~30B, vLLM)
├── Answer cache + market-data service
└── Eval/CI runners, volatility monitor

REGIONAL POD × N  (India first · Gulf second)
├── Gateway (sessions, streaming)
├── Intent engine nodes (7–8B)
├── Memory service + L1 data stores (in-region, deleted on exit)
└── Execution seam + partner adapters
```

## Capacity model

- **Minimum viable footprint** (pre-first-user): one research node, one small-model node, market data feeds, monitoring — **₹2.5–3L/month** on current 30B configs. (Ram's feeds conversation swings this ₹0.4–0.8L.)
- Raw: one research node ≈ 5–8k MAU (provisioned for the worst 15 minutes of the month). **Caching-adjusted: ~30k MAU/node**, cost floor ₹10–18/MAU, likely lower on MoE.
- **Reserved floor + pre-warmed burst:** the volatility monitor watches the *market* — price moves minutes before the query wave, so capacity warms before users flood in. Correlated spikes are also the most cacheable traffic (identical questions, one generation, fleet-wide serve) — the fleet is hedged from both directions.
- Pooling at fleet scale cuts total nodes 40–60%; time-zone spread flattens further (an economic argument for the first non-Indian venue). Partners never see this — they see a flat fee and a responsive product.
- **Fleet utilization 60–75% sustained is the core internal KPI**; utilization telemetry is the *sole* trigger for capacity expansion. Owned hardware is a post-fundraise decision gated on real utilization data incl. a bear case.

## SLA engineering (contract §11 → product behavior)

- 99.5% monthly uptime, service credits as remedy.
- **Graceful degradation is contractual:** under extreme market events, research may slow but intent recognition, order flow, and cached market explanations stay responsive. In-product this is the degraded-mode banner + labeled CACHED BRIEF badges — show it in procurement, don't let them discover it in an outage.
- Numeric latency SLAs deferred to first renewal, underwritten by pilot production data.

## Near-term actions

1. Kartik: India GPU quotes, 3–4 providers (Gulf quotes before MENA contract #1). Certified regions only.
2. Stand up staging: one small research node + one intent node (can be fractional/spot for dev) + mock market data.
3. Volatility monitor v0: threshold rules on price feeds → pre-warm webhook. Learnable later; simple first.
4. Security-review pack: architecture diagram, data-flow map, L1/L2/L3 boundaries, pen-test plan — written once, reused per partner (arriving with structural answers documented is what keeps VARA-style diligence short).

Related: [[03 Intelligence Layer]] · [[01 System Architecture]]
