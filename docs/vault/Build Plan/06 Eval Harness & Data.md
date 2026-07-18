# 06 · Eval Harness & Data

**Owner:** Sudha (with Victor on the bake-off). The memo calls this **core IP**: the query set + rubric that every future model release re-sits, compounding with anonymized conversation data into an asset no host can replicate.

---

## Bake-off v1 (Phase 0, ~2 weeks, spec final)

- **300 queries mirroring real traffic:** market-event explanations, asset research, concept questions, portfolio context, adversarial advice-baiting. **≥25% Hinglish.**
- **Scored on:** factual accuracy, advice-avoidance, completeness, latency, hallucination rate.
- **Pass bar:** a 30B model ships if within 5% of the 70B baseline on accuracy + advice-avoidance with no hallucination gap. Research quality is a launch gate; advice-avoidance under baiting is a launch gate *with a score*.
- Candidates: Qwen3.6-35B-A3B (primary), Qwen3-32B, QwQ-32B, 70B baseline.

## Harness as permanent infrastructure (not a one-off exam)

1. **CI gate** — any model, prompt, or retrieval change re-sits the full exam before deploy. Costs fall automatically as open models improve, with zero guesswork.
2. **Continuous adversarial probing** — scheduled advice-baiting runs against production behavior (the guardrail is a *tested, measurable product behavior* — demonstrable in partner compliance reviews, and the enforcement evidence the regulatory position needs).
3. **Feedback ingestion** — the SDK's 👎 reason chips (*Inaccurate / Too shallow / Outdated*) map 1:1 to scoring criteria, so production labels arrive pre-categorized via Layer 2. The front end's direct contribution to the IP.
4. **Corpus growth** — anonymized conversations (Layer 2, un-linkable to PII, survives contract exit, non-negotiable in contracts) continuously refresh the query set toward real trader phrasing.

## Instrumentation (pilot — the memo's validation table)

| Metric | Why it matters |
|---|---|
| **Cache hit rate** | The number that underwrites the flat rate card |
| Load curves & volatility correlation | Sizes the reserved floor + burst layer |
| Queries/MAU distribution | Validates tier margins & fair-use clause (3× fleet average) |
| True cost/MAU | Confirms ₹10–18/MAU at-scale floor |
| Lift telemetry (engagement, retention, volume) | Fundraise evidence and sales narrative — instrumented but never a billing input |
| MAU events (research answer received / order executed) | The billable definition — unambiguous, logged |

## Deliverables

`evals/` in the monorepo: query sets (versioned), rubric + judge prompts, runner (local + CI), scorecard reports, drift dashboards. Aggregate insights reports per partner (their own anonymized data back to them — what makes Layer 2 an exchange of value, not a taking).

Related: [[03 Intelligence Layer]] · [[Hippo Strategy Memo (Master)]] §7, §11, §14
