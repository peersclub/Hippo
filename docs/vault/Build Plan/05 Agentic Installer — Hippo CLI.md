# 05 · Agentic Installer — Hippo CLI

**The idea:** installation to any website is agentic and CLI-based. `hippo init` is not a scaffolder — it is an agent that *understands the partner's site and API surface* and *generates the integration*: embed placement, theming config, the partner adapter, and the proof it all works. This converts the memo's "weeks, not quarters" into "days, mostly automated," and makes the integration-fee waiver nearly free to honor.

**Positioning note:** the CLI automates the *edge* (the deliberately simple, installable part). The moat stays in the core (intent engine, evals, cache). The CLI makes hosts say yes faster; it gives away nothing that matters.

---

## Two modes

**Mode 1 — `hippo init` in the partner's repo** (preferred). Runs where the partner's engineers live; output is a reviewable PR, never a silent mutation.
**Mode 2 — `hippo scan <domain>`** (pre-sales / no repo access). Read-only: crawls the public site + API docs, produces the integration report and a draft adapter config — a concrete artifact for the sales conversation ("here's your integration, 80% done, before you've signed").

## Pipeline (six stages, each checkpointed and resumable)

### 1. Site understanding
Crawl the partner's app (authorized): framework detection (Next/React/Vue/server-rendered), where the trading screens live, mobile WebView vs native, CSP posture, script-injection point. Extract the *product* shape: markets list, instrument naming conventions, locale set.

### 2. Design comprehension
Extract the host's visual language — fonts, spacing, radii, dark/light — to configure the co-branded surface. Bounded by brand law: the surface wears the partner's *context* but Hippo's design language is fixed (Dark Glass Instrument, amber signal, "Ask Hippo" entry). The CLI configures the `built for ___` string, venue name on tickets/CTAs, locale defaults — it does not restyle Hippo. (White-label is not offered; the CLI enforces that structurally.)

### 3. API discovery
- Ingest OpenAPI/Swagger if published; else parse API docs pages; else (with permission) observe the site's own network traffic in a sandboxed session to map endpoints.
- Map to the Canonical Trading Interface: auth flow (key/HMAC/OAuth), order endpoints, positions/balances, webhook availability, rate limits, precision rules, error-code table.
- **Gap report:** anything the venue's API can't do (no webhooks → polling; no prepared-order flow → deep-link confirm). This doubles as the memo's qualifying criterion check — "a production-grade trading API" — the CLI *measures* it instead of asking.

### 4. Adapter generation
Generate `adapter.config.yaml`, `mapping.ts`, `rejections.yaml` against the CTI, using the hand-built KoinBX adapter as the golden reference pattern. Declarative-first: the agent writes config where config suffices, code only where shapes genuinely diverge.

### 5. Embed integration
Insert the one-line SDK snippet at the detected injection point (or hand the partner the line + config blob), wire the partner-side JWT mint (a ~20-line server sample the CLI generates in the partner's stack/language), set the confirm-surface mode.

### 6. Verification & report
- Run the generated conformance suite against the venue sandbox: full order lifecycle round-trip, precision edges, rejection mapping, webhook/poll reconciliation.
- Boot the SDK against the staging gateway and replay the golden conversation on the partner's actual page (screenshot evidence).
- Emit the **Integration Report**: what was discovered, what was generated, gap list, test results, and every line that would change in the partner's repo. Human sign-off (partner + Hippo) is a required gate — the agent proposes, people approve.

## Agent architecture

- Deterministic pipeline with agentic *stages* — the LLM does comprehension and codegen inside each stage; orchestration, checkpoints, and gates are plain code. Every stage's output is a reviewable artifact (config, code, report), never hidden state.
- Verification loop per stage: generate → run against sandbox → read failures → repair → re-run, with a bounded retry budget; unresolved failures land in the gap report rather than looping forever.
- **Model choice is an open decision** ([[Open Decisions]]): the memo's open-source-only rule is a *production data-sovereignty* position; the CLI is build-time tooling running on partner-consented artifacts. Frontier-model codegen (e.g. Claude Agent SDK) would be markedly better at stage 3–4 comprehension; self-hosted keeps the story uniform. Default proposal: frontier for build-time codegen with partner consent in the engagement letter, open-source fallback for partners who refuse.

## Safety rails

Never touches production trading endpoints (sandbox keys only until the partner flips the switch) · read-only crawl unless in-repo mode · all writes land as a branch/PR · secrets never leave the partner's environment (the CLI reads keys from partner env/vault, embeds references not values) · every generated adapter ships with its conformance suite so regressions are the partner's CI problem to catch too.

## Build sequence

1. **Weeks 10–11:** CTI conformance-suite runner + report format (no agent yet — this is the verifier, and the verifier must exist before the generator).
2. **Weeks 11–13:** stages 3–4 (API discovery → adapter codegen) — the highest-value automation. Dogfood: regenerate the KoinBX adapter blind; diff against hand-built = quality score.
3. **Weeks 13–14:** stages 1–2, 5 (site/design comprehension, embed injection), `hippo scan` sales mode.
4. **Post-pilot:** stage-2 depth (design extraction), non-exchange verticals via new CTI profiles (catalog + order abstraction from [[01 System Architecture]]).

Related: [[04 Execution Seam & Partner Adapter]] · [[02 Thin Client SDK]]
