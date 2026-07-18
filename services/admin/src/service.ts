/**
 * Admin service HTTP surface (:8794 — operator network only, NEVER the
 * partner-facing ingress):
 *
 *   POST /auth/login | /auth/logout          GET /auth/me
 *   GET/POST         /v1/partners            PATCH /v1/partners/:id
 *   POST /v1/partners/:id/suspend|activate|plan
 *   GET/POST         /v1/plans               PATCH/DELETE /v1/plans/:id
 *   GET /v1/users    POST /v1/users/:partnerId/:userId/block|unblock
 *   GET /v1/memory   GET/PUT /v1/memory/:partnerId/:userId
 *   POST /v1/memory/:partnerId/:userId/clear DELETE .../purge
 *   GET /v1/metrics  GET /v1/audit           GET /health
 *
 * Memory data stays owned by services/memory — this service proxies its
 * /admin surface with the internal token. Every mutating route writes one
 * admin_audit row. Cross-partner reads are the operator's legitimate view;
 * the audit trail is what keeps that power accountable.
 */

import { randomBytes } from 'node:crypto'
import {
  AssignPlanBody,
  LoginBody,
  OperatorBody,
  PartnerBody,
  PartnerPatch,
  PersonaAdminUpdate,
  PlanBody,
  PlanPatch,
  ProvisionBody,
} from '@hippo/protocol'
import type {
  AuditStore,
  MauStore,
  OperatorStore,
  PartnerStore,
  PlanStore,
  UserStore,
} from '@hippo/stores'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { LoginThrottle, originAllowed } from './guard.js'
import {
  clearedSessionCookie,
  hashPassword,
  mintSessionToken,
  type OperatorSession,
  readSession,
  sessionCookie,
  verifyPassword,
} from './opauth.js'

export type AdminServiceOptions = {
  partners: PartnerStore
  plans: PlanStore
  users: UserStore
  operators: OperatorStore
  audit: AuditStore
  /** Secret for operator session JWTs. */
  jwtSecret: string
  /** services/memory base URL + its INTERNAL_API_TOKEN. */
  memoryUrl?: string
  internalToken?: string
  /** gateway base URL for /internal/metrics. */
  gatewayUrl?: string
  /** Durable MAU counts (mau_events) — preferred over the gateway's
   * in-process snapshot when provided; survives gateway restarts. */
  mauStore?: MauStore
  /** fetch override for tests. */
  fetchImpl?: typeof fetch
}

export function buildAdminService(opts: AdminServiceOptions): FastifyInstance {
  const {
    partners,
    plans,
    users,
    operators,
    audit,
    jwtSecret,
    memoryUrl = process.env.MEMORY_URL ?? 'http://localhost:8792',
    internalToken = process.env.INTERNAL_API_TOKEN ?? '',
    gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8788',
    mauStore,
    fetchImpl = fetch,
  } = opts

  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && { level: 'info' } })

  // ── request hardening ────────────────────────────────────────────────────
  // CSRF belt-and-braces on top of SameSite=Strict: mutating requests with an
  // Origin header must match our own host.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      reply.code(403).send({ error: 'origin not allowed' })
    }
  })

  const throttle = new LoginThrottle()

  // ── operator guard ───────────────────────────────────────────────────────
  function operator(req: FastifyRequest, reply: FastifyReply): OperatorSession | null {
    const session = readSession(req.headers.cookie, jwtSecret)
    if (!session) reply.code(401).send({ error: 'not signed in' })
    return session
  }

  const record = (
    op: OperatorSession,
    action: string,
    target: string,
    detail: Record<string, unknown> = {},
  ) => audit.append({ operatorEmail: op.email, action, target, detail }).catch(() => {})

  // Memory-service proxy with the internal token; the admin panel never
  // exposes that token to the browser.
  async function memoryFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetchImpl(`${memoryUrl}${path}`, {
      ...init,
      headers: {
        // JSON content-type only with an actual body — Fastify 400s an empty
        // body that claims to be JSON (the DELETE purge proxy is bodyless).
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-hippo-internal-token': internalToken,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(5_000),
    })
  }

  /** Gateway /internal proxy (sessions list/kill) — same token discipline. */
  async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetchImpl(`${gatewayUrl}${path}`, {
      ...init,
      headers: { 'x-hippo-internal-token': internalToken, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(5_000),
    })
  }

  /** Owner-gated routes (operator management). 403 for plain operators. */
  function ownerOnly(req: FastifyRequest, reply: FastifyReply): OperatorSession | null {
    const op = operator(req, reply)
    if (!op) return null
    if (op.role !== 'owner') {
      reply.code(403).send({ error: 'owner role required' })
      return null
    }
    return op
  }

  // ── self-serve sandbox provisioning (public, rate-limited) ───────────────
  // `hippo register` lands here. Creates a `sandbox` partner + a one-time
  // claim token for the jwtSecret — the secret is fetchable exactly once and
  // never appears in the register response, audit trail, or any list view.
  // Going `active` (production) stays operator-gated in the panel.
  const provisionThrottle = new LoginThrottle(60 * 60_000, 3) // 3 per IP per hour
  const claims = new Map<string, { partnerId: string; jwtSecret: string; expiresAt: number }>()
  const CLAIM_TTL_MS = 15 * 60_000

  app.post('/v1/provision/sandbox', async (req, reply) => {
    const retryAfter = provisionThrottle.retryAfterS([`prov:${req.ip}`])
    if (retryAfter > 0) {
      reply.header('retry-after', String(retryAfter))
      return reply.code(429).send({ error: 'provisioning rate limit — try again later' })
    }
    const parsed = ProvisionBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid provision body' })
    provisionThrottle.recordFailure([`prov:${req.ip}`]) // every attempt counts

    // Unique slug: venue name + random suffix.
    const base = parsed.data.venueName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
    let partnerId = ''
    for (let i = 0; i < 5; i++) {
      const candidate = `${base}-${randomBytes(2).toString('hex')}`
      if (!(await partners.get(candidate))) {
        partnerId = candidate
        break
      }
    }
    if (!partnerId) return reply.code(503).send({ error: 'could not allocate partner id' })

    const partnerKey = `pk_sandbox_${randomBytes(9).toString('base64url')}`
    const jwtSecretValue = randomBytes(32).toString('hex')
    await partners.create({
      partnerId,
      partnerKey,
      jwtSecret: jwtSecretValue,
      venueName: parsed.data.venueName,
      locales: parsed.data.locales,
      suggestedQueries: [],
      planId: null,
      status: 'sandbox',
    })

    const token = randomBytes(24).toString('base64url')
    claims.set(token, {
      partnerId,
      jwtSecret: jwtSecretValue,
      expiresAt: Date.now() + CLAIM_TTL_MS,
    })

    void audit
      .append({
        operatorEmail: parsed.data.email,
        action: 'provision.sandbox',
        target: partnerId,
        detail: { venueName: parsed.data.venueName },
      })
      .catch(() => {})

    return {
      partnerId,
      partnerKey,
      status: 'sandbox',
      claimPath: `/v1/provision/claim/${token}`,
      claimExpiresInS: CLAIM_TTL_MS / 1000,
      note: 'Fetch the claim path ONCE to receive the JWT secret; store it in your vault. Activation to production is operator-approved.',
    }
  })

  app.get<{ Params: { token: string } }>('/v1/provision/claim/:token', async (req, reply) => {
    const claim = claims.get(req.params.token)
    claims.delete(req.params.token) // one-time, even on expiry
    if (!claim || claim.expiresAt < Date.now()) {
      return reply.code(404).send({ error: 'unknown or expired claim' })
    }
    void audit
      .append({
        operatorEmail: 'provisioning',
        action: 'provision.claimed',
        target: claim.partnerId,
        detail: {},
      })
      .catch(() => {})
    return { partnerId: claim.partnerId, jwtSecret: claim.jwtSecret }
  })

  // ── auth ─────────────────────────────────────────────────────────────────
  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid login body' })
    const email = parsed.data.email.toLowerCase()
    const throttleKeys = [`email:${email}`, `ip:${req.ip}`]

    // Locked out? 429 before any credential work (no timing oracle either).
    const retryAfter = throttle.retryAfterS(throttleKeys)
    if (retryAfter > 0) {
      void audit
        .append({
          operatorEmail: email,
          action: 'auth.login_locked',
          target: req.ip,
          detail: { retryAfterS: retryAfter },
        })
        .catch(() => {})
      reply.header('retry-after', String(retryAfter))
      return reply.code(429).send({ error: 'too many attempts — try again later' })
    }

    const op = await operators.get(email)
    // Same error either way — no operator-existence oracle.
    if (!op || !verifyPassword(parsed.data.password, op.passwordHash)) {
      throttle.recordFailure(throttleKeys)
      void audit
        .append({
          operatorEmail: email,
          action: 'auth.login_failed',
          target: req.ip,
          detail: {},
        })
        .catch(() => {})
      return reply.code(401).send({ error: 'invalid credentials' })
    }
    throttle.clear(`email:${email}`)
    const session: OperatorSession = { email: op.email, role: op.role }
    reply.header('set-cookie', sessionCookie(mintSessionToken(session, jwtSecret)))
    return { email: op.email, role: op.role }
  })

  app.post('/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', clearedSessionCookie())
    return { ok: true }
  })

  app.get('/auth/me', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    return op
  })

  // ── partners ─────────────────────────────────────────────────────────────
  app.get('/v1/partners', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    // jwtSecret is partner credential material — list views never carry it.
    return (await partners.list()).map(({ jwtSecret: _, ...rest }) => rest)
  })

  app.post('/v1/partners', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const parsed = PartnerBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid partner body' })
    if (parsed.data.planId && !(await plans.get(parsed.data.planId)))
      return reply.code(400).send({ error: 'unknown plan' })
    try {
      const created = await partners.create({ ...parsed.data, planId: parsed.data.planId ?? null })
      void record(op, 'partner.create', created.partnerId, { venueName: created.venueName })
      const { jwtSecret: _, ...safe } = created
      return safe
    } catch (err) {
      return reply.code(409).send({ error: String(err instanceof Error ? err.message : err) })
    }
  })

  app.patch<{ Params: { id: string } }>('/v1/partners/:id', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const parsed = PartnerPatch.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid partner patch' })
    const updated = await partners.update(req.params.id, parsed.data)
    if (!updated) return reply.code(404).send({ error: 'unknown partner' })
    void record(op, 'partner.update', req.params.id, { fields: Object.keys(parsed.data) })
    const { jwtSecret: _, ...safe } = updated
    return safe
  })

  for (const [action, status] of [
    ['suspend', 'suspended'],
    ['activate', 'active'],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/v1/partners/:id/${action}`, async (req, reply) => {
      const op = operator(req, reply)
      if (!op) return reply
      const updated = await partners.setStatus(req.params.id, status)
      if (!updated) return reply.code(404).send({ error: 'unknown partner' })
      void record(op, `partner.${action}`, req.params.id)
      return { partnerId: updated.partnerId, status: updated.status }
    })
  }

  app.post<{ Params: { id: string } }>('/v1/partners/:id/plan', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const parsed = AssignPlanBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })
    if (parsed.data.planId && !(await plans.get(parsed.data.planId)))
      return reply.code(400).send({ error: 'unknown plan' })
    const updated = await partners.assignPlan(req.params.id, parsed.data.planId)
    if (!updated) return reply.code(404).send({ error: 'unknown partner' })
    void record(op, 'partner.assign_plan', req.params.id, { planId: parsed.data.planId })
    return { partnerId: updated.partnerId, planId: updated.planId }
  })

  // ── plans ────────────────────────────────────────────────────────────────
  app.get('/v1/plans', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    return plans.list()
  })

  app.post('/v1/plans', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const parsed = PlanBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid plan body' })
    try {
      const created = await plans.create(parsed.data)
      void record(op, 'plan.create', created.planId, { tier: created.tier })
      return created
    } catch (err) {
      return reply.code(409).send({ error: String(err instanceof Error ? err.message : err) })
    }
  })

  app.patch<{ Params: { id: string } }>('/v1/plans/:id', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const parsed = PlanPatch.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid plan patch' })
    const updated = await plans.update(req.params.id, parsed.data)
    if (!updated) return reply.code(404).send({ error: 'unknown plan' })
    void record(op, 'plan.update', req.params.id, { fields: Object.keys(parsed.data) })
    return updated
  })

  app.delete<{ Params: { id: string } }>('/v1/plans/:id', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    try {
      const deleted = await plans.delete(req.params.id)
      if (!deleted) return reply.code(404).send({ error: 'unknown plan' })
      void record(op, 'plan.delete', req.params.id)
      return { deleted: true }
    } catch (err) {
      return reply.code(409).send({ error: String(err instanceof Error ? err.message : err) })
    }
  })

  // ── users ────────────────────────────────────────────────────────────────
  app.get<{ Querystring: { partnerId?: string; q?: string; offset?: string; limit?: string } }>(
    '/v1/users',
    async (req, reply) => {
      const op = operator(req, reply)
      if (!op) return reply
      const { partnerId, q, offset, limit } = req.query
      return users.list({
        ...(partnerId ? { partnerId } : {}),
        ...(q ? { q } : {}),
        offset: Number(offset ?? 0) || 0,
        limit: Math.min(Number(limit ?? 50) || 50, 200),
      })
    },
  )

  type UserParams = { partnerId: string; userId: string }

  app.get<{ Params: UserParams }>('/v1/users/:partnerId/:userId', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const { partnerId, userId } = req.params
    const user = await users.get(partnerId, userId)
    if (!user) return reply.code(404).send({ error: 'unknown user' })
    // Join the persona view; memory-service downtime degrades, never 500s.
    let persona: unknown = null
    try {
      const res = await memoryFetch(`/v1/persona/${partnerId}/${userId}`)
      if (res.ok) persona = await res.json()
    } catch {
      /* memory unreachable — user row still renders */
    }
    void record(op, 'user.view', `${partnerId}/${userId}`)
    return { ...user, persona }
  })

  for (const [action, status] of [
    ['block', 'blocked'],
    ['unblock', 'active'],
  ] as const) {
    app.post<{ Params: UserParams }>(
      `/v1/users/:partnerId/:userId/${action}`,
      async (req, reply) => {
        const op = operator(req, reply)
        if (!op) return reply
        const { partnerId, userId } = req.params
        const updated = await users.setStatus(partnerId, userId, status)
        if (!updated) return reply.code(404).send({ error: 'unknown user' })
        void record(op, `user.${action}`, `${partnerId}/${userId}`)
        return { partnerId, userId, status: updated.status }
      },
    )
  }

  // ── user-wise memory management (proxied; memory service owns the data) ──
  app.get<{ Querystring: Record<string, string> }>('/v1/memory', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const qs = new URLSearchParams(req.query).toString()
    const res = await memoryFetch(`/admin/personas${qs ? `?${qs}` : ''}`)
    return reply.code(res.status).send(await res.json())
  })

  app.put<{ Params: UserParams }>('/v1/memory/:partnerId/:userId', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const parsed = PersonaAdminUpdate.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid persona update' })
    const { partnerId, userId } = req.params
    const res = await memoryFetch(`/v1/persona/${partnerId}/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(parsed.data),
    })
    void record(op, 'memory.update', `${partnerId}/${userId}`, { fields: Object.keys(parsed.data) })
    return reply.code(res.status).send(await res.json())
  })

  app.post<{ Params: UserParams }>('/v1/memory/:partnerId/:userId/clear', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const { partnerId, userId } = req.params
    const res = await memoryFetch(`/v1/persona/${partnerId}/${userId}/clear`, {
      method: 'POST',
      body: '{}',
    })
    void record(op, 'memory.clear', `${partnerId}/${userId}`)
    return reply.code(res.status).send(await res.json())
  })

  app.delete<{ Params: UserParams }>('/v1/memory/:partnerId/:userId', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const { partnerId, userId } = req.params
    const res = await memoryFetch(`/admin/personas/${partnerId}/${userId}`, { method: 'DELETE' })
    void record(op, 'memory.purge', `${partnerId}/${userId}`)
    return reply.code(res.status).send(await res.json())
  })

  // Bulk purge (partner offboarding) — audited with the row count.
  app.delete<{ Querystring: { partnerId?: string } }>('/v1/memory', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const { partnerId } = req.query
    if (!partnerId) return reply.code(400).send({ error: 'partnerId required' })
    const res = await memoryFetch(`/admin/personas?partnerId=${encodeURIComponent(partnerId)}`, {
      method: 'DELETE',
    })
    const body = (await res.json()) as { deleted?: number }
    void record(op, 'memory.purge_partner', partnerId, { deleted: body.deleted ?? 0 })
    return reply.code(res.status).send(body)
  })

  // ── operators (owner-only) ───────────────────────────────────────────────
  app.get('/v1/operators', async (req, reply) => {
    const op = ownerOnly(req, reply)
    if (!op) return reply
    // passwordHash never leaves this service.
    return (await operators.list()).map(({ passwordHash: _, ...rest }) => rest)
  })

  app.post('/v1/operators', async (req, reply) => {
    const op = ownerOnly(req, reply)
    if (!op) return reply
    const parsed = OperatorBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid operator body' })
    try {
      const created = await operators.create({
        email: parsed.data.email,
        passwordHash: hashPassword(parsed.data.password),
        role: parsed.data.role,
      })
      void record(op, 'operator.create', created.email, { role: created.role })
      return { email: created.email, role: created.role, createdAt: created.createdAt }
    } catch (err) {
      return reply.code(409).send({ error: String(err instanceof Error ? err.message : err) })
    }
  })

  app.delete<{ Params: { email: string } }>('/v1/operators/:email', async (req, reply) => {
    const op = ownerOnly(req, reply)
    if (!op) return reply
    const email = decodeURIComponent(req.params.email)
    // Two footguns removed: no self-delete, never delete the last owner.
    if (email === op.email) return reply.code(400).send({ error: 'cannot delete yourself' })
    const target = await operators.get(email)
    if (!target) return reply.code(404).send({ error: 'unknown operator' })
    if (target.role === 'owner') {
      const owners = (await operators.list()).filter((o) => o.role === 'owner')
      if (owners.length <= 1) return reply.code(400).send({ error: 'cannot delete the last owner' })
    }
    await operators.delete(email)
    void record(op, 'operator.delete', email)
    return { deleted: true }
  })

  // ── live sessions (gateway proxy) ────────────────────────────────────────
  app.get<{ Querystring: { partnerId?: string } }>('/v1/sessions', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    try {
      const qs = req.query.partnerId ? `?partnerId=${encodeURIComponent(req.query.partnerId)}` : ''
      const res = await gatewayFetch(`/internal/sessions${qs}`)
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'gateway unreachable' })
    }
  })

  app.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    try {
      const res = await gatewayFetch(`/internal/sessions/${encodeURIComponent(req.params.id)}`, {
        method: 'DELETE',
      })
      void record(op, 'session.revoke', req.params.id)
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'gateway unreachable' })
    }
  })

  // ── partner detail (aggregated drill-down) ───────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/partners/:id/detail', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const partner = await partners.get(req.params.id)
    if (!partner) return reply.code(404).send({ error: 'unknown partner' })
    const { jwtSecret: _, ...safe } = partner

    const plan = partner.planId ? await plans.get(partner.planId) : null
    const userPage = await users.list({ partnerId: partner.partnerId, limit: 50 })

    let mau = 0
    let sessions: unknown[] = []
    try {
      const [metricsRes, sessionsRes] = await Promise.all([
        fetchImpl(`${gatewayUrl}/internal/metrics`, { signal: AbortSignal.timeout(3_000) }),
        gatewayFetch(`/internal/sessions?partnerId=${encodeURIComponent(partner.partnerId)}`),
      ])
      if (metricsRes.ok) {
        const m = (await metricsRes.json()) as { mau?: { byPartner?: Record<string, number> } }
        mau = m.mau?.byPartner?.[partner.partnerId] ?? 0
      }
      if (sessionsRes.ok) sessions = (await sessionsRes.json()) as unknown[]
    } catch {
      /* gateway down — DB-backed parts still render */
    }
    // Durable count wins when available — survives gateway restarts.
    if (mauStore) {
      try {
        mau = await mauStore.count(partner.partnerId)
      } catch {
        /* keep gateway snapshot */
      }
    }

    return {
      partner: safe,
      plan,
      users: userPage,
      mau: { current: mau, quota: plan?.mauQuota ?? null },
      sessions,
    }
  })

  // ── metrics + audit ──────────────────────────────────────────────────────
  app.get('/v1/metrics', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    let gateway: unknown = null
    try {
      const res = await fetchImpl(`${gatewayUrl}/internal/metrics`, {
        signal: AbortSignal.timeout(3_000),
      })
      if (res.ok) gateway = await res.json()
    } catch {
      /* gateway down — counts still render */
    }

    // Quota alerts: any planned partner at ≥80% of its MAU ceiling.
    // Durable counts win when available (survive gateway restarts); the
    // gateway's in-process snapshot is the fallback.
    let byPartner =
      (gateway as { mau?: { byPartner?: Record<string, number> } } | null)?.mau?.byPartner ?? {}
    if (mauStore) {
      try {
        byPartner = await mauStore.byPartner()
      } catch {
        /* keep gateway snapshot */
      }
    }
    const alerts: Array<{
      partnerId: string
      venueName: string
      mau: number
      quota: number
      pct: number
    }> = []
    for (const p of await partners.list()) {
      if (!p.planId || p.status !== 'active') continue
      const plan = await plans.get(p.planId)
      if (plan?.mauQuota == null) continue
      const mau = byPartner[p.partnerId] ?? 0
      const pct = Math.round((mau / plan.mauQuota) * 100)
      if (pct >= 80)
        alerts.push({
          partnerId: p.partnerId,
          venueName: p.venueName,
          mau,
          quota: plan.mauQuota,
          pct,
        })
    }
    alerts.sort((a, b) => b.pct - a.pct)

    return {
      gateway,
      alerts,
      counts: {
        partners: (await partners.list()).length,
        plans: (await plans.list()).length,
        users: (await users.list({ limit: 1 })).total,
      },
    }
  })

  app.get<{ Querystring: { offset?: string; limit?: string } }>('/v1/audit', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    return audit.list({
      offset: Number(req.query.offset ?? 0) || 0,
      limit: Math.min(Number(req.query.limit ?? 50) || 50, 200),
    })
  })

  app.get('/health', async () => ({ ok: true, service: 'admin' }))

  return app
}
