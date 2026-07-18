# 04 · Execution Seam & Partner Adapter

**The risk firewall (memo §2.4, §6):** orders execute on the partner's rails, under their licenses, KYC, and custody. Hippo prepares the ticket; the partner's own APIs execute it. User funds never route through Hippo; PII never leaves the partner's regional pod.

---

## Approach A (current baseline; A/B pending Suresh)

1. Trader states intent → intent engine extracts params → **prepared ticket card** (instrument, side, size, est. price, est. cost incl. fees).
2. CTA: "Review & confirm in [Venue] →" — handoff to the partner's own confirm surface (deep link / partner JS callback / partner-hosted confirm modal; per-venue choice, discovered at integration time).
3. **Awaiting-confirm card** (pulsing amber) with cancel.
4. Venue events flow back (webhook preferred, polling fallback) → lifecycle cards: filled receipt (actuals + venue order ID), partial fill (live progress, amend/cancel on venue), cancelled, expired. Status changes made *elsewhere* still arrive in the thread.
5. Rejections are translated: plain-words reason + a concrete fix ("Resize to max"), never a bare error code.

Governing sentence: **if a trader ever has to leave the conversation to find out what happened to their order, the seam has failed.**

## Canonical Trading Interface (CTI)

The venue-neutral contract every adapter implements — and the codegen target for [[05 Agentic Installer — Hippo CLI]]:

```
quote(instrument)                     → live price/fees estimate for ticket prep
prepare(order) → prepared_ref         → est. price, est. cost incl. fees
confirm_handoff(prepared_ref)         → venue confirm surface (link/callback)
status(order_id) / stream_events()    → NEW|OPEN|PARTIAL|FILLED|CANCELLED|EXPIRED|REJECTED(+reason)
cancel(order_id)
open_orders(user) / positions(user) / balances(user)
instruments()                         → tradable catalog + size/precision/limits
map_rejection(venue_code)             → plain-words reason + suggested fix
```

Rules: all balance math and order validation happen venue-side or seam-side — **never in the SDK**. Estimates end at the confirm; receipts carry venue actuals. Idempotency keys on everything mutating. User auth = partner-signed JWT asserting the venue user ID; Hippo never holds venue credentials for order placement beyond the delegated session the partner grants.

## Adapter anatomy (per venue)

- `adapter.config.yaml` — endpoints, auth mode, rate limits, precision rules, webhook setup, confirm-surface mode. Declarative wherever possible: the more that lives in config, the more the CLI can generate and a human can review at a glance.
- `mapping.ts` — CTI ↔ venue API translation (the only code that knows venue shapes).
- `rejections.yaml` — venue error code → plain words + fix.
- `conformance/` — generated test suite: sandbox round-trip of the full lifecycle, precision edge cases, rejection mapping coverage.

The **pilot (KoinBX) adapter is hand-built first** — it defines what "good" looks like and becomes the CLI's golden reference.

## Failure honesty

Venue API down → orders strip shows last-known state labeled with its age; composer explains what still works (research unaffected). Webhook gap → reconcile by polling; the thread backfills missed transitions rather than pretending continuity. Every edge state answers: what happened, what still works, what do I do next.

Related: [[01 System Architecture]] · [[05 Agentic Installer — Hippo CLI]] · [[Open Decisions]] (A/B decision)
