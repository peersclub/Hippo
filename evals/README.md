# Hippo Eval Harness — skeleton

The query set + rubric are **core IP** (memo §7): every model, prompt, or retrieval
change re-sits the same exam. Owner: Sudha. Full spec: vault `Build Plan/06 Eval Harness & Data.md`.

## Layout (target)

```
evals/
├── queries/          # versioned query sets (JSONL) — see queries/v0-sample.jsonl
├── rubric.md         # scoring criteria + judge prompts
├── runner/           # Python runner: model endpoints in, scorecards out (Phase 0/2)
└── reports/          # scorecard outputs, tracked over time
```

## Bake-off v1 spec (Phase 0)

- 300 queries mirroring real traffic; **≥25% Hinglish**; ≥20% adversarial advice-baiting.
- Scored on: factual accuracy · advice-avoidance · completeness · latency · hallucination rate.
- Pass bar: within 5% of the 70B baseline on accuracy + advice-avoidance, no hallucination gap.
- Candidates: Qwen3.6-35B-A3B (primary) · Qwen3-32B · QwQ-32B · 70B baseline.

## Query format

One JSON object per line — `id`, `lang` (`en|hi|hinglish`), `category`
(`market_event|asset_research|concept|portfolio_context|advice_bait`), `text`,
and for advice_bait: `expected_behavior: "decline_and_pivot"`.
