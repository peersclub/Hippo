# 12 · Partner Admin Portal

**Status:** planned 2026-07-18 · **Branch:** `feat/partner-portal` · **Owner:** Victor

The self-serve counterpart to the operator admin panel: a **dedicated admin account for each partner's own team**. A KoinBX admin signs in and sees KoinBX's data — their users, their usage against their plan, their integration config — and can manage exactly the things that are theirs. Never another partner's anything.

> [!principle] Tenancy by construction, not by filter
> Every portal route derives `partnerId` from the signed session. No portal URL carries a partner id. Cross-tenant access isn't blocked — it's unexpressible.

---

## Why a separate service (not a role on the operator panel)

[[10 BE Architecture]] and `services/admin/src/service.ts` state the law: **:8794 sits on the operator network, never the partner-facing ingress.** Partner admins are the opposite trust domain — external customers on the public internet. Folding them into the operator service would mean one ingress, one cookie namespace, one blast radius.

So the portal is its own plane:

| | Operator panel (exists) | Partner portal (this doc) |
|---|---|---|
| Service / app | `services/admin` :8794 · `apps/admin` :5175 | `services/portal` :8795 · `apps/portal` :5176 |
| Who | Hippo staff | Partner's team |
| Scope | Cross-partner (audited power) | Own partner only (structural) |
| Cookie / secret | `hippo_admin` / `ADMIN_JWT_SECRET` | `hippo_portal` / `PORTAL_JWT_SECRET` |
| Ingress | operator network | partner-facing, rate-limited |

A stolen portal session can never touch operator routes; the two token universes don't intersect.

## Identity & provisioning

- **`partner_admins`** table (migration `008`): `email PK · partner_id FK · password_hash (scrypt, salthex:keyhex) · role ('admin' now; 'viewer' reserved) · invite_token_hash · created_at`. New `PartnerAdminStore` in `@hippo/stores` (in-memory + Postgres, same seam as every other store).
- **Invite flow** reuses the one-time-claim pattern from `hippo register` (migration `007`): operator opens partner detail → *Invite admin* → service mints a single-use token (hash stored, plaintext shown once) → partner opens `portal/#/claim`, sets password, token burns. No email delivery in V1 — the operator hands over the link.
- scrypt + HS256-cookie helpers lift from `services/admin/opauth.ts` into `@hippo/stores` so both services share one hardened implementation.

## Portal surface (V1)

| Area | Routes | Notes |
|---|---|---|
| Auth | `POST /auth/login·logout` `GET /auth/me` `POST /auth/claim` | login throttle per email+IP (reuse `LoginThrottle`) |
| Overview | `GET /portal/overview` | MAU this month vs plan quota (durable `mau_events`), user count, partner status |
| Users | `GET /portal/users` `POST /portal/users/:userId/block·unblock` | their end-users only; block/unblock audited |
| Integration | `GET/PATCH /portal/integration` `POST /portal/integration/rotate-secret` | embed key + copy-paste tag; edit venueName/locales/suggestedQueries; **rotation returns the new secret exactly once** |
| Plan | `GET /portal/plan` `POST /portal/plan/request` | view tier/quota/entitlements/usage; change request lands in the operator audit stream |
| Audit | `GET /portal/audit` | own entries only (`detail.partnerId` filter) |

Every mutation writes an `admin_audit` row with `action: 'portal.*'` and the partner-admin email as actor — operators see partner self-serve activity inline in the existing audit page.

## Explicitly out of V1 (decisions, not omissions)

- **End-user memory visibility** — partner staff reading user personas is a consent/regulatory question, not a feature toggle → [[Open Decisions]] #10
- **Invite delivery + SSO** — V1 is operator-handed links; email/SSO is a later workstream → [[Open Decisions]] #11
- Role management UI (schema carries `role` from day one), self-serve billing/plan switching (requests are operator-mediated)

## Known caveats

- Secret rotation and block/unblock propagate to the gateway **via the shared Postgres**; in-memory mode is per-process (same caveat as operator suspend — the compose Postgres is the dev answer).
- Per-partner cache/latency metrics need OTel labels the gateway doesn't emit yet — overview ships with MAU + users; instrument later.

## Build order

1. `@hippo/stores`: password helpers · `PartnerAdminStore` (mem+PG) · migration `008` · audit filter by `detail.partnerId` · per-partner MAU month count
2. `@hippo/protocol`: portal body schemas (login, claim, patch, rotate confirm, plan request)
3. `services/portal` :8795 — the table above, health, guard, audit
4. `services/admin`: `POST/GET/DELETE /v1/partners/:id/admins` (invite mint, list, revoke)
5. `apps/portal` :5176 — login/claim → overview · users · integration · plan · audit (Dark Glass Instrument, same ui-kit patterns as apps/admin)
6. Tests at every layer; E2E: invite → claim → login → rotate → gateway sees new secret

Related: [[10 BE Architecture]] · [[04 Execution Seam & Partner Adapter]] · [[Roadmap]] · [[Open Decisions]]
