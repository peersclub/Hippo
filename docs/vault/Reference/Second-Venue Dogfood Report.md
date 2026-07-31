# Second-Venue Dogfood — CLI vs hand-built adapter

**Date:** 2026-07-31 · **Target:** the LIVE Assetworks demo venue (`host-venue-production.up.railway.app`) · **Pipeline:** `hippo scan` (discovery → CTI map → adapter config → model-driven mapping synthesis, `anthropic/claude-haiku-4.5`) + `hippo conform --venue assetworks` (the verifier) · **Reference:** the hand-built `services/seam/src/assetworks-venue.ts` · Phase 4 exit-gate evidence ([[Roadmap]]).

## What ran

1. **PR #88** gave the venue a discovery surface (`GET /` homepage + `GET /openapi.json`) — a real integration target documents itself; deployed to Railway first.
2. `hippo scan host-venue-production.up.railway.app --json` against the live venue.
3. `hippo conform --venue assetworks` against the live venue (local market-data for quotes).

## Scorecard

| Dimension | Score | Evidence |
|---|---|---|
| Endpoint discovery | **7/7** | Every endpoint the hand-built adapter uses was found and assigned to the right CTI capability (orders → orderPlacement, cancel, open → orderStatus, positions, balance, capabilities → instruments). |
| Honest gap detection | **2/2** | The two capabilities the venue genuinely lacks (quote/ticker, webhooks) were reported as gaps with the correct consequences ("bring market data", "poll reconciliation") — exactly the hand-built adapter's real design. |
| Auth strategy | **match** | "hmac-signed request (per-key secret)" — the hand-built adapter's exact pattern. |
| Brand extraction | **hit, 1st heuristic** | `#3b82f6` via theme-color meta → `hippo embed --accent` (the new theming feature's first live firing). |
| Trade features | **spot + futures_perp** | Matches the venue's capabilities (params flagged incomplete — leverage bounds live behind `/v1/capabilities` at runtime, which the config correctly points at). |
| Mapping synthesis | **5/5 typechecked, field-fidelity high, enum-fidelity LOW** | All five mapping functions synthesized first-attempt and passed the strict standalone typecheck. Field names match the wire exactly (`clientOrderId`, `filledQty`, `remainingQty`, `rate`…). **But `mapLifecycle` invented status semantics (0/1/2/3) instead of the venue's real codes (10/15/20/30/35)** — see the finding below. |
| Verifier vs live venue | **8/8 Conformant** | The conform battery (prepare market/limit, display-string tickets, reject bad size, confirm→terminal, cancel pre/post, portfolio shape) passed against the deployed venue. First run scored 3/8 — every failure was `MARKET_DATA_URL` unset (market prepares need a quote; limits passed). With market data: clean. |

**Overall: the generated scaffolding matches the hand-built adapter's architecture 1:1** (endpoints, auth, gaps, poll-reconciliation posture). The synthesized mapping bodies are review-grade, not ship-grade — which is what stage 4's own comments promise ("Review before shipping").

## The actionable finding — enum descriptions never reach the model

The venue's OpenAPI **documents** its status codes (`status: 10 ACTIVE · 15 PARTIAL · 20 SETTLED · 30 CANCELED · 35 PARTIAL_CANCELED` in the Order schema description), but `extractResponseShapes` in `tools/cli/src/scan/cti.ts` keeps only property **names and types**, dropping descriptions. Starved of the legend, the model guessed generic codes. One-line-class fix with outsized quality impact: **thread property descriptions (esp. enum legends) into the response shape the stage-4 prompt carries.** Queued as the next CLI improvement.

Secondary observations:
- `hippo conform` should say "is market-data reachable?" when every network check fails the same way — a `MARKET_DATA_URL` preflight would have made the 3/8 first run self-explanatory.
- The dead OpenRouter key in the repo-root `.env` (stale since the 2026-07-27 rotation) made stage 4 silently stub ("model returned no usable body") — the LLM client swallows HTTP errors. Now synced from Railway; a "401 from model endpoint" distinction in `init/llm.ts` would stop the next person burning time on it.

## Exit-gate read

The Phase 4 gate is "second venue integrated end-to-end with < 1 day human review." This dogfood shows the pipeline delivers: discovery, config, auth strategy, and gap analysis are review-free; human effort concentrates exactly where stage 4 flags it (mapping-body review, enum semantics). With the description-threading fix, the enum class of error likely disappears. **Gate: on track — needs one real (non-self-authored) venue to claim it.**

Artifacts from the run (scan report/config/mapping/rejections/conform reports) are in the session scratchpad; regenerate any time with the two commands above.
