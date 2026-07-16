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
import {
  AssignPlanBody,
  LoginBody,
  PartnerBody,
  PartnerPatch,
  PersonaAdminUpdate,
  PlanBody,
  PlanPatch,
} from '@hippo/protocol'
import type { AuditStore, OperatorStore, PartnerStore, PlanStore, UserStore } from '@hippo/stores'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  clearedSessionCookie,
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
    fetchImpl = fetch,
  } = opts

  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && { level: 'info' } })

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

  // ── auth ─────────────────────────────────────────────────────────────────
  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid login body' })
    const op = await operators.get(parsed.data.email)
    // Same error either way — no operator-existence oracle.
    if (!op || !verifyPassword(parsed.data.password, op.passwordHash)) {
      return reply.code(401).send({ error: 'invalid credentials' })
    }
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
  app.get<{ Querystring: { partnerId?: string; offset?: string; limit?: string } }>(
    '/v1/users',
    async (req, reply) => {
      const op = operator(req, reply)
      if (!op) return reply
      const { partnerId, offset, limit } = req.query
      return users.list({
        ...(partnerId ? { partnerId } : {}),
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
    return {
      gateway,
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
