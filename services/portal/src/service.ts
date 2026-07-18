/**
 * Partner portal HTTP surface (:8795 — partner-facing ingress, rate-limited):
 *
 *   POST /auth/claim | /auth/login | /auth/logout    GET /auth/me
 *   GET  /portal/overview
 *   GET  /portal/users        POST /portal/users/:userId/block|unblock
 *   GET  /portal/integration  PATCH /portal/integration
 *   POST /portal/integration/rotate-secret
 *   GET  /portal/plan         POST /portal/plan/request
 *   GET  /portal/audit        GET /health
 *
 * TENANCY BY CONSTRUCTION: partnerId comes from the signed session claim and
 * from nowhere else — no portal route accepts a partner id. Cross-tenant
 * reads are unexpressible rather than filtered.
 *
 * Every mutation writes an admin_audit row (action `portal.*`, actor = the
 * partner-admin email, detail.partnerId set) so operators see partner
 * self-serve activity inline in their existing audit view, and the portal's
 * own audit page filters on detail.partnerId.
 */

import { randomBytes } from 'node:crypto'
import {
  LoginBody,
  PortalClaimBody,
  PortalIntegrationPatch,
  PortalPlanRequestBody,
} from '@hippo/protocol'
import type {
  AuditStore,
  MauStore,
  PartnerAdminStore,
  PartnerStore,
  PlanStore,
  UserStore,
} from '@hippo/stores'
import { hashPassword, tokenHash, verifyPassword } from '@hippo/stores'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  clearedSessionCookie,
  mintSessionToken,
  type PortalSession,
  readSession,
  sessionCookie,
} from './auth.js'
import { LoginThrottle, originAllowed } from './guard.js'

export type PortalServiceOptions = {
  partners: PartnerStore
  plans: PlanStore
  users: UserStore
  partnerAdmins: PartnerAdminStore
  audit: AuditStore
  /** Secret for portal session JWTs — must differ from ADMIN_JWT_SECRET. */
  jwtSecret: string
  /** Durable MAU counts; overview/plan usage read through this when present. */
  mauStore?: MauStore
  /** Loader URL shown in the embed snippet. */
  sdkUrl?: string
}

export function buildPortalService(opts: PortalServiceOptions): FastifyInstance {
  const {
    partners,
    plans,
    users,
    partnerAdmins,
    audit,
    jwtSecret,
    mauStore,
    sdkUrl = process.env.HIPPO_SDK_URL ?? 'https://cdn.hippo.example/hippo-loader.js',
  } = opts

  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && { level: 'info' } })

  // CSRF belt-and-braces on top of SameSite=Strict (same posture as admin).
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      reply.code(403).send({ error: 'origin not allowed' })
    }
  })

  const throttle = new LoginThrottle()

  // ── session guard ─────────────────────────────────────────────────────────
  function session(req: FastifyRequest, reply: FastifyReply): PortalSession | null {
    const s = readSession(req.headers.cookie, jwtSecret)
    if (!s) reply.code(401).send({ error: 'not signed in' })
    return s
  }

  /** Mutations require the 'admin' seat; 'viewer' is read-only. */
  function adminSession(req: FastifyRequest, reply: FastifyReply): PortalSession | null {
    const s = session(req, reply)
    if (s && s.role !== 'admin') {
      reply.code(403).send({ error: 'read-only seat' })
      return null
    }
    return s
  }

  const record = (
    s: PortalSession,
    action: string,
    target: string,
    detail: Record<string, unknown> = {},
  ) =>
    audit
      .append({
        operatorEmail: s.email,
        action,
        target,
        // partnerId in detail is what scopes the portal's own audit view.
        detail: { ...detail, partnerId: s.partnerId },
      })
      .catch(() => {})

  // ── auth ──────────────────────────────────────────────────────────────────

  app.post('/auth/claim', async (req, reply) => {
    const parsed = PortalClaimBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid claim body' })
    const retryAfter = throttle.retryAfterS([`claim:${req.ip}`])
    if (retryAfter > 0) {
      reply.header('retry-after', String(retryAfter))
      return reply.code(429).send({ error: 'too many attempts' })
    }

    const admin = await partnerAdmins.getByInviteTokenHash(tokenHash(parsed.data.token))
    if (!admin || admin.passwordHash !== null) {
      throttle.recordFailure([`claim:${req.ip}`])
      return reply.code(404).send({ error: 'unknown or already-claimed invite' })
    }
    if (admin.inviteExpiresAt !== null && admin.inviteExpiresAt < Date.now()) {
      return reply.code(410).send({ error: 'invite expired — ask your operator for a new one' })
    }

    await partnerAdmins.setPassword(admin.email, hashPassword(parsed.data.password))
    void audit
      .append({
        operatorEmail: admin.email,
        action: 'portal.claimed',
        target: admin.email,
        detail: { partnerId: admin.partnerId },
      })
      .catch(() => {})
    return { ok: true, email: admin.email }
  })

  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid login body' })
    const { email, password } = parsed.data
    const keys = [`email:${email}`, `ip:${req.ip}`]
    const retryAfter = throttle.retryAfterS(keys)
    if (retryAfter > 0) {
      reply.header('retry-after', String(retryAfter))
      return reply.code(429).send({ error: 'too many attempts' })
    }

    const admin = await partnerAdmins.get(email)
    if (!admin?.passwordHash || !verifyPassword(password, admin.passwordHash)) {
      throttle.recordFailure(keys)
      return reply.code(401).send({ error: 'invalid credentials' })
    }
    // Suspended partners lose portal access along with everything else.
    const partner = await partners.get(admin.partnerId)
    if (!partner || partner.status === 'suspended') {
      return reply.code(403).send({ error: 'partner access suspended — contact Hippo' })
    }

    const s: PortalSession = { email: admin.email, partnerId: admin.partnerId, role: admin.role }
    reply.header('set-cookie', sessionCookie(mintSessionToken(s, jwtSecret)))
    return { email: s.email, partnerId: s.partnerId, role: s.role, venueName: partner.venueName }
  })

  app.post('/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', clearedSessionCookie())
    return { ok: true }
  })

  app.get('/auth/me', async (req, reply) => {
    const s = session(req, reply)
    if (!s) return
    const partner = await partners.get(s.partnerId)
    if (!partner) return reply.code(401).send({ error: 'partner gone' })
    return { email: s.email, partnerId: s.partnerId, role: s.role, venueName: partner.venueName }
  })

  // ── own data ──────────────────────────────────────────────────────────────

  app.get('/portal/overview', async (req, reply) => {
    const s = session(req, reply)
    if (!s) return
    const partner = await partners.get(s.partnerId)
    if (!partner) return reply.code(404).send({ error: 'partner gone' })
    const plan = partner.planId ? await plans.get(partner.planId) : undefined
    const mau = mauStore ? await mauStore.count(s.partnerId) : null
    const { total: userCount } = await users.list({ partnerId: s.partnerId, limit: 1 })
    return {
      partnerId: partner.partnerId,
      venueName: partner.venueName,
      status: partner.status,
      mau,
      mauQuota: plan?.mauQuota ?? null,
      userCount,
      plan: plan ? { planId: plan.planId, name: plan.name, tier: plan.tier } : null,
    }
  })

  app.get<{ Querystring: { offset?: string; limit?: string; q?: string } }>(
    '/portal/users',
    async (req, reply) => {
      const s = session(req, reply)
      if (!s) return
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0)
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50))
      return users.list({
        partnerId: s.partnerId,
        offset,
        limit,
        ...(req.query.q ? { q: req.query.q } : {}),
      })
    },
  )

  for (const [verb, status] of [
    ['block', 'blocked'],
    ['unblock', 'active'],
  ] as const) {
    app.post<{ Params: { userId: string } }>(
      `/portal/users/:userId/${verb}`,
      async (req, reply) => {
        const s = adminSession(req, reply)
        if (!s) return
        const updated = await users.setStatus(s.partnerId, req.params.userId, status)
        if (!updated) return reply.code(404).send({ error: 'unknown user' })
        record(s, `portal.user.${verb}`, `user:${s.partnerId}/${req.params.userId}`)
        return updated
      },
    )
  }

  // ── integration ───────────────────────────────────────────────────────────

  const embedSnippet = (partnerKey: string) =>
    `<script src="${sdkUrl}" data-hippo-key="${partnerKey}" defer></script>`

  app.get('/portal/integration', async (req, reply) => {
    const s = session(req, reply)
    if (!s) return
    const partner = await partners.get(s.partnerId)
    if (!partner) return reply.code(404).send({ error: 'partner gone' })
    // jwtSecret is NEVER in this payload — rotation is the only read, once.
    return {
      partnerKey: partner.partnerKey,
      venueName: partner.venueName,
      locales: partner.locales,
      suggestedQueries: partner.suggestedQueries,
      embedSnippet: embedSnippet(partner.partnerKey),
    }
  })

  app.patch('/portal/integration', async (req, reply) => {
    const s = adminSession(req, reply)
    if (!s) return
    const parsed = PortalIntegrationPatch.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid integration patch' })
    const updated = await partners.update(s.partnerId, parsed.data)
    if (!updated) return reply.code(404).send({ error: 'partner gone' })
    record(s, 'portal.integration.update', `partner:${s.partnerId}`, {
      fields: Object.keys(parsed.data),
    })
    return {
      partnerKey: updated.partnerKey,
      venueName: updated.venueName,
      locales: updated.locales,
      suggestedQueries: updated.suggestedQueries,
      embedSnippet: embedSnippet(updated.partnerKey),
    }
  })

  app.post('/portal/integration/rotate-secret', async (req, reply) => {
    const s = adminSession(req, reply)
    if (!s) return
    const jwtSecretValue = randomBytes(32).toString('hex')
    const updated = await partners.update(s.partnerId, { jwtSecret: jwtSecretValue })
    if (!updated) return reply.code(404).send({ error: 'partner gone' })
    // Audited WITHOUT the secret — the response below is its only appearance.
    record(s, 'portal.secret.rotate', `partner:${s.partnerId}`)
    return {
      jwtSecret: jwtSecretValue,
      note: 'Shown exactly once. Update your token signer before your old sessions expire.',
    }
  })

  // ── plan ──────────────────────────────────────────────────────────────────

  app.get('/portal/plan', async (req, reply) => {
    const s = session(req, reply)
    if (!s) return
    const partner = await partners.get(s.partnerId)
    if (!partner) return reply.code(404).send({ error: 'partner gone' })
    const plan = partner.planId ? await plans.get(partner.planId) : undefined
    const mau = mauStore ? await mauStore.count(s.partnerId) : null
    return {
      plan: plan ?? null,
      usage: { mau, mauQuota: plan?.mauQuota ?? null },
    }
  })

  app.post('/portal/plan/request', async (req, reply) => {
    const s = adminSession(req, reply)
    if (!s) return
    const parsed = PortalPlanRequestBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid plan request' })
    const partner = await partners.get(s.partnerId)
    // The request IS the audit row — operators triage it from their audit view.
    record(s, 'portal.plan.change_requested', `partner:${s.partnerId}`, {
      message: parsed.data.message,
      currentPlanId: partner?.planId ?? null,
    })
    return { ok: true, note: 'Request logged — the Hippo team will follow up.' }
  })

  // ── audit (own activity only) ─────────────────────────────────────────────

  app.get<{ Querystring: { offset?: string; limit?: string } }>(
    '/portal/audit',
    async (req, reply) => {
      const s = session(req, reply)
      if (!s) return
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0)
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50))
      return audit.list({ offset, limit, partnerId: s.partnerId })
    },
  )

  app.get('/health', async () => ({ ok: true, service: 'portal' }))

  return app
}
