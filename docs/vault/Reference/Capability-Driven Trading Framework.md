---
title: Capability-Driven Trading Framework — design
type: reference
tags: [intent, capabilities, futures, adapter, product-law, finance-safety]
updated: 2026-07-16
grounding:
  - "tools/cli/src/scan/cti.ts (host capability detection — spot seed)"
  - "services/intelligence/intent.py (spot-only parse_order + LLM extraction)"
  - "services/seam/src/types.ts (VenueAdapter, spot PrepareRequest)"
  - "KoinBX: private-api-trade (spot) + futures_backend/frontend_futures (futures)"
---

# Capability-Driven Trading Framework

See also: [[User Memory & Personalization]] · [[Ram JSX vs Victor Dev]] · [[Open Decisions]] · [[04 Execution Seam & Partner Adapter]]

> [!summary] The goal
> Hippo should take a natural-language command and place **any order type the host supports** — spot, futures, margin, whatever — driven by the host's *discovered* feature set, with **per-feature domain knowledge** so extraction and validation are accurate enough for real money. Adding a new trade type must be adding a *module*, never rewriting the engine.

---

## 1. The reframe

The wrong framing is "add futures." The right framing is: **every trade type is an instance of one abstraction — a `TradeCapability` — and the system is the framework that discovers, routes, extracts, validates, prepares, and renders across all of them.** Spot (built today) is the first instance; futures is the second; margin/options are future instances that plug in.

Three properties fall out of the goal statement:

- **Capability-gated** ("based on the host's available features"): a spot-only host never offers futures. Capabilities are *discovered per venue*, and only enabled modules are offered.
- **Scalable** ("scalable for all features"): a new trade type is a new module implementing the capability contract — no engine surgery.
- **Accurate** ("necessary knowledge per feature… finance is involved"): each module carries the domain knowledge (grammar + host parameters + validation) that makes parsing and pre-flight checks precise. In finance an imprecise parse loses money — so accuracy is a first-class design constraint, not a nicety.

---

## 2. The core abstraction — `TradeCapability`

A self-contained module per trade type. It declares six things:

| Facet | What it is | Example (futures-perpetual) |
|---|---|---|
| **Descriptor** | which host endpoints/features it requires (gates enablement) | needs a futures order + positions + leverage endpoint |
| **Order schema** | the structured fields this type needs | `{ direction: long\|short, leverage, marginMode: isolated\|cross, size\|margin, reduceOnly }` |
| **Grammar / knowledge** | vocabulary + phrasings + rules to parse NL → schema | "long/short", "Nx / N% leverage", "isolated/cross", "reduce only", "close" |
| **Validation** | per-feature pre-flight using host params | leverage ≤ host max; margin sufficient; notional ≥ min; tick/precision |
| **Render hints** | what the ticket must show | liquidation price, margin, funding, direction |
| **Adapter binding** | how it maps to the host's API for this feature | KoinBX `futures_backend` place/positions |

Spot's module is the same shape with `{ side: buy\|sell, size, orderType, limitPrice }`, a simpler grammar, and the existing `private-api-trade` binding — i.e. **the current spot code refactored into the framework proves the abstraction.**

---

## 3. The pipeline (capability-driven)

```
NL command
  │
  ├─ 1. CAPABILITY DISCOVERY (scan/init, per venue)
  │      extend cti.ts: detect not just endpoints but FEATURE SETS
  │      → venue.capabilities = { spot: ✓, futuresPerp: ✓, margin: ✗, options: ✗ }
  │
  ├─ 2. INTENT ROUTING (intelligence)
  │      classify which capability the command targets
  │      "take long BTC 13% leverage" → futuresPerp   (or → decline if venue lacks it)
  │
  ├─ 3. EXTRACT + VALIDATE (the capability module's knowledge)
  │      module.parse(command) → structured order, using its grammar
  │      module.validate(order, hostParams) → ok | rejection(plain reason)
  │      NEVER GUESS: ambiguity → clarify or reject, never fill in size/leverage
  │
  ├─ 4. PREPARE (seam + adapter binding)   [Approach A: Hippo prepares, venue confirms]
  │      seam.prepare(canonical order for this capability) → ticket
  │
  └─ 5. RENDER (SDK)  feature-aware order_ticket (direction, leverage, liq. price…)
```

Two invariants carry over from spot: (a) the host stays dumb — all understanding is Hippo's; (b) Approach A — Hippo prepares, the trader confirms on the venue, lifecycle flows back.

---

## 4. How it extends what exists (it's an extension, not a rewrite)

- **Capability discovery** ← `tools/cli/src/scan/cti.ts` already maps 8 CTI capabilities from a spec. Extend it from *endpoint* detection to *feature-set* detection (a futures order endpoint + a leverage/positions endpoint ⇒ `futuresPerp` capability).
- **Intent** ← `services/intelligence/intent.py` `parse_order` is today a single spot regex. It becomes a **router over capability grammars** + per-capability extractors (regex fast-path + LLM strict-JSON, per module).
- **Canonical order** ← `services/seam/src/types.ts` `PrepareRequest` is spot-shaped. It becomes a **tagged union by capability** (`{ kind:'spot', … } | { kind:'futuresPerp', … }`), and `VenueAdapter` grows per-capability prepare paths.
- **Renderer** ← the SDK `order_ticket` card renders `rows[]` already; feature modules supply the rows + a couple of typed fields (direction, leverage) so the card stays server-driven.

Nothing is thrown away; the spot path becomes module #1.

---

## 5. Per-feature knowledge = accuracy (the finance-safety core)

This is the part the goal statement insists on, and it's where the design earns its keep. Each capability module makes extraction accurate by knowing:

- **Grammar** — the real phrasings ("go long", "3x", "13% leverage", "reduce only", "close half"). Precise parsing, not a generic LLM guess.
- **Host parameters** (discovered + cached): max leverage, allowed margin modes, tick size, quantity precision, min notional, contract multiplier. These make validation *venue-true*.
- **Validation before prepare** — "leverage 13% exceeds this venue's 10x cap", "size below min notional", "isolated margin not offered here" → a plain-words `rejection_ticket`, never a bad order.
- **Never-guess rule** — ambiguity ("go big on BTC") never gets a fabricated size or leverage; the module asks or declines. Guessing is a money bug.

> The knowledge lives *in the module*, per feature — so accuracy scales with coverage, and a mis-parse in futures can't come from spot's grammar.

---

## 6. Product-law boundary (sharper with leverage)

- Hippo **prepares what the user explicitly commands** — including direction and leverage — because that's the user's instruction, not Hippo's opinion.
- Hippo **never suggests** direction, leverage, or whether to trade. "You could go 10x" is advice → forbidden. The output-side guardrail still fires on every turn.
- Leverage adds a **factual disclosure duty**, not an advisory one: the ticket shows liquidation price / margin as *facts*, never "this is safe/risky."
- Ambiguity resolves to **clarify or decline**, never guess (§5) — the finance-safety and never-advise rules point the same way here.

---

## 7. Build plan (keystone first, then a parallel batch)

Because the capability contract + canonical schema are the shared dependency, this is **keystone → fan-out → integrate**, not a naive parallel batch:

- **Keystone (solo, must be right):** the `TradeCapability` contract, the tagged-union canonical order (protocol + seam), the capability registry, and the intent-router skeleton. Small, foundational, everything hangs off it.
- **Then a parallel batch (disjoint once the keystone is frozen):**
  - **Spot module** — refactor today's spot path into the framework (proves the abstraction; zero behavior change, guarded by existing tests).
  - **Futures-perp module** — grammar + schema + validation + KoinBX `futures_backend` adapter binding.
  - **Capability discovery** — extend `cti.ts` to detect feature sets.
  - **SDK** — feature-aware order-ticket render (direction, leverage, liq. price).
- **Integrate + verify:** E2E for both "buy 0.5 BTC at market" (spot, unchanged) and "take long BTC 13% leverage" (futures) → intent → validated ticket → adapter → lifecycle; plus a spot-only-venue test proving futures is *not* offered.

---

## 8. Open decisions this surfaces
- [ ] **Is futures in pilot scope, or post-pilot?** The whole prototype is spot; futures is a real product + risk expansion. (Product: Victor/Ram.)
- [ ] **KoinBX futures API access** — `futures_backend` shape + sandbox keys (parallels Open Decisions #9 for spot).
- [ ] **Leverage disclosure copy** — liquidation/margin facts wording (borders on Open Decisions #2 territory; counsel-adjacent).
- [ ] **How much LLM vs grammar per module** — regex fast-paths stay cheap/accurate for common phrasings; LLM extraction backstops the long tail (mirrors the existing intent design).
