# GPU Bake-off Ask — for Kartik

**Date:** 2026-08-01 · **Blocking:** Phase 2 exit gate (the answer-model choice that underwrites the rate card) · **Everything is ready except the hardware.**

## What we need

One GPU box (or cloud instance) for roughly **a working week** of intermittent use:

| Option | Spec | Fits |
|---|---|---|
| Preferred | 1× H100 80GB or A100 80GB | every candidate incl. the 70B baseline (AWQ/GPTQ quantized) |
| Acceptable | 2× 48GB (A6000/L40S class) | all candidates via tensor parallel |
| Minimum | 1× 48GB | 32B-class candidates at 4-bit; 70B baseline would need a separate short rental |

India or Gulf region preferred (latency realism for the pilot market — this was always the plan; your regional quotes are the input we're waiting on).

## What runs on it

- **vLLM** serving each candidate behind the same OpenAI-compatible surface the service already speaks (`LLM_BASE_URL`/`LLM_MODEL` config swap only — zero code changes; we've already proven the swap path with Ollama local and OpenRouter cloud).
- **Candidates:** Qwen3-32B, QwQ-32B, Qwen3.6-35B-A3B vs a 70B-class baseline.
- **The eval:** our 300-query bake-off set (≥25% Hinglish, 60 advice-bait) through the committed harness (`evals/` — runner + launch gates ready since PR #5). Launch gate: within 5% of the 70B baseline with no hallucination gap, plus intent p95 / first-token p95 inside PRD budgets.

## Why it matters commercially

The model choice sets cost/MAU — which we now **measure live** (Pilot dashboard, PR #80/#81), so the bake-off result converts directly into the rate card. Until it runs, the demo's answer quality rides a stopgap cloud model and the pricing model rides assumptions.

## What we need from you

1. The India/Gulf GPU quotes (provider, spec, ₹ or $ per hour, availability window).
2. A go on one option — we can be running evals within a day of access.

— Victor / Hippo eng
