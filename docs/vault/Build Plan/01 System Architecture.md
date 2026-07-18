# 01 · System Architecture

**Governing seam:** thin edge, heavy core. The SDK draws; the server decides. Four jobs the seam does (memo §2): integration speed, fleet upgrades, moat placement, risk firewall.

---

## Component map

```
Partner website / app
└── hippo-sdk (thin client, Shadow DOM)          ← the "parasite" — one script tag
        │  cards in, intents out (SSE/WS + REST)
        ▼
Hippo Gateway (regional pod)
├── Session & partner auth (signed JWT handshake)
├── Conversation orchestrator (server-driven UI)
│       ▼
├── Intent Engine        7–8B class · classify + extract   (regional pod)
├── Memory Service       opt-in persona, per user          (regional pod, Layer 1/opt-in)
├── Execution Seam       canonical trading interface        (regional pod)
│    └── Partner Adapter (per venue, CLI-generated)  →  Partner APIs (their rails, their KYC)
│
└── Research Tier (GLOBAL, shared — carries no user data by design)
     ├── Research Engine   ~30B class (bake-off winner)
     ├── Market Data Service  price, funding, news, on-chain, liquidations
     └── Answer Cache      market-level briefs, generated once, served fleet-wide
```

Side systems: **Eval Harness** (offline + CI gate + feedback ingestion), **Telemetry** (Sudha's instrumentation), **Volatility monitor** (pre-warms GPU burst capacity when the market moves, before the query wave).

## The wire protocol (card protocol v1)

The single most leveraged artifact in the system. Everything — SDK, gateway, mock server, CLI verification — programs against it.

- **Down:** a stream of typed card frames. `research_brief`, `live_bar`, `order_ticket`, `lifecycle:{awaiting|filled|partial|cancelled|expired}`, `advice_decline`, `positions`, `rejection`, `thinking`, `skeleton`, `banner:{degraded|offline}`, `pulse` (ambient event for the minimized pill), `onboarding_config`.
- **Up:** user text, chip taps, ticket confirms/cancels, feedback events (👍/👎 + reason chip), consent state, settings changes.
- Versioned, additive-only. Unknown card types render a graceful fallback (prose + link) — old SDKs never break when new cards ship. This is what makes "new card types ship to every partner simultaneously with zero partner-side work" true.
- Server decides *what* and *when*; client only knows *how to draw*. The ambient market pulse is the pattern in miniature: server sends `pulse {tag: "BTC −4.2%"}`, client glows.

## Data boundaries (contract Layer model, memo §11)

| Layer | What | Where it lives |
|---|---|---|
| L1 Partner user data (PII, accounts, orders) | Partner property | Regional pod only, in-region, deleted on exit |
| L2 Anonymized conversation logs | Hippo retains, cross-partner, survives exit | Un-linkable to PII; feeds evals + cache tuning |
| L3 Derived intelligence (models, eval sets, caches) | Hippo IP outright | Global tier |

Architecture answers data law: India data in India, Gulf data in the Gulf; the research/cache tier carries no user data so it can be one global layer.

## Host-agnosticism (the "any website" requirement)

The embed treats the host as an untrusted, unknowable environment:

- **Shadow DOM (closed)** + own font loading + `all: initial` reset — no CSS bleed either direction.
- **Zero dependencies on host globals**; no jQuery/React assumptions; works in any framework or none.
- **Performance budget:** loader < 5KB inline, full bundle lazy-loaded on first pill render, idle-priority; host LCP/CLS unaffected (the pill mounts after `load`).
- **CSP-friendly:** single origin (`cdn.hippo.app` + regional gateway), nonce support, no eval, no inline styles outside the shadow root.
- **Fail-safe:** if Hippo's backend is down, the pill either hides or shows the offline edge state — the host page never errors. "If Hippo pauses, trading continues."
- **Config, not code:** partner identity (`built for ___`), venue name on tickets, locale set, feature flags — all a signed config blob fetched by key, so the same bundle serves every partner.

This is what makes the parasite metaphor safe to say to a partner: it attaches anywhere, feeds on nothing, and the host can shed it with one line removed.

## Generalization path (beyond exchanges)

V1 semantics are trading-specific, but the canonical interfaces are deliberately two abstractions that exist on *any* transactional website: a **catalog** (things with live state — instruments today; products, bookings later) and an **order** (prepare → confirm on host rails → lifecycle). Keep vertical-specific logic in adapters and card content, never in the SDK or protocol. This costs nothing now and keeps the "thin parasite on any website" door open.

Related: [[02 Thin Client SDK]] · [[03 Intelligence Layer]] · [[04 Execution Seam & Partner Adapter]] · [[07 Infrastructure & Pods]]
