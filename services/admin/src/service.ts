/**
 * Admin service HTTP surface (:8794 — operator network only, NEVER the
 * partner-facing ingress):
 *
 *   POST /auth/login | /auth/logout          GET /auth/me
 *   GET/POST         /v1/partners            PATCH /v1/partners/:id
 *   POST /v1/partners/:id/suspend|activate|plan
 *   GET/POST         /v1/plans               PATCH/DELETE /v1/plans/:id
 *   GET /v1/users    GET /v1/users/:partnerId/:userId
 *   POST /v1/users/:partnerId/:userId/block|unblock
 *   DELETE /v1/users/:partnerId/:userId/everywhere (purge across every store)
 *   GET/DELETE /v1/memory                    (DELETE = bulk partner purge)
 *   GET/PUT/DELETE /v1/memory/:partnerId/:userId  (DELETE = hard purge)
 *   POST /v1/memory/:partnerId/:userId/clear
 *   GET/DELETE /v1/learned-facts/user/:partnerId/:userId
 *   GET /v1/learned-facts/session/:sessionId
 *   GET /v1/metrics  GET /v1/audit           GET /health
 *   GET /v1/tech/telemetry (gateway diagnostics + intelligence health)
 *   GET /v1/intent-signals[/export] (implicit misunderstanding signals; the
 *       export answers JSONL in the eval harness's row shape)
 *   GET /v1/alerts   POST /v1/alerts/:id/cancel (proactive alerts, per partner)
 *   GET /v1/shares   DELETE /v1/shares/:id (share links; DELETE = kill switch)
 *   GET /v1/identities (per-partner user identities, PIN hashes never proxied)
 *   GET/POST /v1/degraded (force/unforce a partner's degraded mode)
 *
 * That route list is not decoration: admin.test.ts parses it and asserts the
 * router actually serves every path named above. It once advertised a
 * single-persona GET that was never registered, and the panel worked around
 * the gap by scanning page one of the list — which reported "no memory held"
 * for anyone past row 50. A docblock that can lie is a bug waiting to ship.
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
  PartnerAdminInviteBody,
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
  PartnerAdminStore,
  PartnerStore,
  PlanStore,
  UserStore,
} from '@hippo/stores'
import { tokenHash } from '@hippo/stores'
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
import { createRateLimiter, type RateLimitOptions } from './rate-limit.js'

// Build provenance: stamped by the Docker build (Railway build args); an
// unstamped build reports "unknown", never a guessed value.
const GIT_SHA = process.env.GIT_SHA || 'unknown'
const BUILT_AT = process.env.BUILT_AT || 'unknown'

export type AdminServiceOptions = {
  partners: PartnerStore
  plans: PlanStore
  users: UserStore
  operators: OperatorStore
  partnerAdmins: PartnerAdminStore
  audit: AuditStore
  /** Secret for operator session JWTs. */
  jwtSecret: string
  /** services/memory base URL + its INTERNAL_API_TOKEN. */
  memoryUrl?: string
  internalToken?: string
  /** gateway base URL for /internal/metrics. */
  gatewayUrl?: string
  /** intelligence base URL for /health (LLM provider mode + model). */
  intelligenceUrl?: string
  /** Durable MAU counts (mau_events) — preferred over the gateway's
   * in-process snapshot when provided; survives gateway restarts. */
  mauStore?: MauStore
  /** fetch override for tests. */
  fetchImpl?: typeof fetch
  /** Per-IP limiter; false disables (tests). Env-tunable in prod. */
  rateLimit?: RateLimitOptions | false
  /** Honor x-forwarded-for (deploys behind a reverse proxy). Defaults to
   * TRUST_PROXY env — off when unset, since trusting the header without a
   * proxy in front lets any client forge its IP. */
  trustProxy?: boolean
}

export function buildAdminService(opts: AdminServiceOptions): FastifyInstance {
  const {
    partners,
    plans,
    users,
    operators,
    partnerAdmins,
    audit,
    jwtSecret,
    memoryUrl = process.env.MEMORY_URL ?? 'http://localhost:8792',
    internalToken = process.env.INTERNAL_API_TOKEN ?? '',
    gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8788',
    intelligenceUrl = process.env.INTELLIGENCE_URL ?? 'http://localhost:8791',
    mauStore,
    fetchImpl = fetch,
  } = opts

  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test' && { level: 'info' },
    // Behind the Railway/Vercel proxy every request arrives from the proxy's
    // address; TRUST_PROXY=1 makes req.ip the real client (x-forwarded-for).
    trustProxy: opts.trustProxy ?? Boolean(process.env.TRUST_PROXY),
  })

  // ── request hardening ────────────────────────────────────────────────────
  // Coarse per-IP abuse guard (same limiter as the gateway). /health is
  // exempt — deploy probes must never be throttled.
  const rateLimit =
    opts.rateLimit === false
      ? undefined
      : createRateLimiter(
          opts.rateLimit ?? {
            max: Number(process.env.RATE_LIMIT_MAX ?? 300),
            windowMs: Number(process.env.RATE_LIMIT_WINDOW ?? 60_000),
          },
        )
  if (rateLimit) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/health') return
      await rateLimit(req, reply)
    })
  }

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

  /** Tagged template that URL-encodes every interpolated path piece. Raw
   * interpolation lets a reserved-char id rewrite the upstream path — a
   * userId holding '/' adds a segment and '?' truncates the rest into a
   * query string, so a purge aimed at "a?b" would land on key "a". Every
   * memoryFetch/gatewayFetch path with dynamic parts is built through this. */
  function upath(strings: TemplateStringsArray, ...parts: string[]): string {
    return strings.reduce(
      (acc, s, i) => acc + s + (i < parts.length ? encodeURIComponent(parts[i] ?? '') : ''),
      '',
    )
  }

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

  /** Gateway /internal proxy (sessions list/kill, alerts, shares, identities,
   * degraded, user purge) — same token + content-type discipline as
   * memoryFetch (JSON content-type only with an actual body). */
  async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetchImpl(`${gatewayUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-hippo-internal-token': internalToken,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(5_000),
    })
  }

  /** Allowlisted query passthrough for the gateway proxies — only the params
   * the internal route understands travel, never whatever the browser sent. */
  function queryString(query: Record<string, string | undefined>): string {
    const params = new URLSearchParams()
    for (const key of ['partnerId', 'limit', 'since', 'signal']) {
      const value = query[key]
      if (value) params.set(key, value)
    }
    const qs = params.toString()
    return qs ? `?${qs}` : ''
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
        // Self-serve: nobody is signed in, and the body's email is whatever
        // the caller typed. It goes in detail under a name that says so —
        // never in operatorEmail, which asserts an authenticated identity.
        operatorEmail: 'provisioning',
        action: 'provision.sandbox',
        target: partnerId,
        detail: { venueName: parsed.data.venueName, requestedEmail: parsed.data.email },
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
    // Lockout keyed on email+IP, never bare IP: behind a proxy that
    // TRUST_PROXY doesn't cover, every operator shares one address — a bare
    // IP key would let 5 failures from one attacker lock out the whole team.
    const throttleKeys = [`login:${email}:${req.ip}`]

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
    throttle.clear(`login:${email}:${req.ip}`)
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

  // ── partner admins (portal seats) ────────────────────────────────────────
  // Operator mints a single-use invite; the plaintext token appears ONLY in
  // this response — the store keeps its sha256. The partner claims it on the
  // portal (POST /auth/claim), which sets their password and burns the token.
  const INVITE_TTL_MS = 7 * 24 * 60 * 60_000 // 7 days

  app.get<{ Params: { id: string } }>('/v1/partners/:id/admins', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const rows = await partnerAdmins.listByPartner(req.params.id)
    // Never expose hashes; claimed = password set.
    return rows.map((a) => ({
      email: a.email,
      role: a.role,
      claimed: a.passwordHash !== null,
      inviteExpiresAt: a.inviteExpiresAt,
      createdAt: a.createdAt,
    }))
  })

  app.post<{ Params: { id: string } }>('/v1/partners/:id/admins', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const parsed = PartnerAdminInviteBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid invite body' })
    if (!(await partners.get(req.params.id))) {
      return reply.code(404).send({ error: 'unknown partner' })
    }
    if (await partnerAdmins.get(parsed.data.email)) {
      return reply.code(409).send({ error: 'that email already has a portal seat' })
    }
    const token = randomBytes(24).toString('base64url')
    const created = await partnerAdmins.create({
      email: parsed.data.email,
      partnerId: req.params.id,
      role: parsed.data.role,
      inviteTokenHash: tokenHash(token),
      inviteExpiresAt: Date.now() + INVITE_TTL_MS,
    })
    void record(op, 'partner_admin.invited', `partner:${req.params.id}`, {
      email: created.email,
      role: created.role,
      partnerId: req.params.id,
    })
    return {
      email: created.email,
      role: created.role,
      // Hand this to the partner out-of-band; it is not retrievable again.
      inviteToken: token,
      claimPath: '/auth/claim',
      inviteExpiresAt: created.inviteExpiresAt,
    }
  })

  app.delete<{ Params: { id: string; email: string } }>(
    '/v1/partners/:id/admins/:email',
    async (req, reply) => {
      const op = operator(req, reply)
      if (!op) return reply
      const existing = await partnerAdmins.get(req.params.email)
      if (!existing || existing.partnerId !== req.params.id) {
        return reply.code(404).send({ error: 'unknown partner admin' })
      }
      await partnerAdmins.delete(req.params.email)
      void record(op, 'partner_admin.revoked', `partner:${req.params.id}`, {
        email: req.params.email,
        partnerId: req.params.id,
      })
      return { ok: true }
    },
  )

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
    // Join the persona view; memory-service downtime degrades, never 500s —
    // but an outage must never read as absence. personaStatus says which it
    // is: 'ok' (real persona), 'none' (memory holds nothing — the service
    // answers a default persona stamped updatedAt 0 for unknown keys), or
    // 'unavailable' (memory down or erroring; persona is simply unknown).
    let persona: unknown = null
    let personaStatus: 'ok' | 'none' | 'unavailable' = 'unavailable'
    try {
      const res = await memoryFetch(upath`/v1/persona/${partnerId}/${userId}`)
      if (res.ok) {
        const body = (await res.json()) as { updatedAt?: number } | null
        if (body?.updatedAt) {
          persona = body
          personaStatus = 'ok'
        } else {
          personaStatus = 'none'
        }
      }
    } catch {
      /* memory unreachable — user row still renders, marked unavailable */
    }
    void record(op, 'user.view', `${partnerId}/${userId}`)
    return { ...user, persona, personaStatus }
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

  // ── purge-user-everywhere (GDPR erasure across every store) ──────────────
  // Four legs, each isolated: persona hard delete, learned-facts clear and
  // user-note delete on the memory service, plus the gateway's cross-store
  // purge (intent signals, uploads, alerts, identities). One leg failing
  // must stay visible in the response — a deletion the operator believes
  // happened but didn't is the worst possible lie this panel can tell.
  type PurgeLeg = { ok: true; detail: unknown } | { ok: false; error: string; status?: number }

  app.delete<{ Params: UserParams }>(
    '/v1/users/:partnerId/:userId/everywhere',
    async (req, reply) => {
      const op = operator(req, reply)
      if (!op) return reply
      const { partnerId, userId } = req.params
      const leg = async (fn: () => Promise<Response>): Promise<PurgeLeg> => {
        try {
          const res = await fn()
          const body: unknown = await res.json().catch(() => null)
          if (!res.ok) return { ok: false, error: 'upstream error', status: res.status }
          return { ok: true, detail: body }
        } catch {
          return { ok: false, error: 'unreachable' }
        }
      }
      const [persona, learnedFacts, userNote, gateway] = await Promise.all([
        leg(() => memoryFetch(upath`/admin/personas/${partnerId}/${userId}`, { method: 'DELETE' })),
        leg(() =>
          memoryFetch(upath`/v1/scope/user/${partnerId}/${userId}/facts`, { method: 'DELETE' }),
        ),
        leg(() => memoryFetch(upath`/v1/scope/user/${partnerId}/${userId}`, { method: 'DELETE' })),
        leg(() =>
          gatewayFetch('/internal/user-purge', {
            method: 'POST',
            body: JSON.stringify({ partnerId, userKey: userId }),
          }),
        ),
      ])
      const results = { persona, learnedFacts, userNote, gateway }
      const ok = persona.ok && learnedFacts.ok && userNote.ok && gateway.ok
      // The audit row asserts what actually happened — partial when any leg
      // failed, with the per-leg outcome recorded either way.
      void record(
        op,
        ok ? 'user.purge_everywhere' : 'user.purge_everywhere_partial',
        `${partnerId}/${userId}`,
        {
          persona: persona.ok,
          learnedFacts: learnedFacts.ok,
          userNote: userNote.ok,
          gateway: gateway.ok,
        },
      )
      return { partnerId, userId, ok, results }
    },
  )

  // ── user-wise memory management (proxied; memory service owns the data) ──
  // Every route names its failed dependency: a memory-service outage is a 502
  // "memory service unreachable", never a generic 500 (same discipline as the
  // gateway sessions proxy below).
  app.get<{ Querystring: Record<string, string> }>('/v1/memory', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    try {
      const qs = new URLSearchParams(req.query).toString()
      const res = await memoryFetch(`/admin/personas${qs ? `?${qs}` : ''}`)
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'memory service unreachable' })
    }
  })

  // One persona, by id. The detail view needs a direct answer: paging the
  // list until the id turns up reports "no memory held" for anyone past the
  // first page, and "we hold nothing" is the one answer a deletion request
  // must never get wrong. Answers the same {partnerId,userId,persona} row
  // shape the list returns, so callers can treat the two identically.
  app.get<{ Params: UserParams }>('/v1/memory/:partnerId/:userId', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const { partnerId, userId } = req.params
    try {
      const res = await memoryFetch(upath`/v1/persona/${partnerId}/${userId}`)
      const body = await res.json()
      if (!res.ok) return reply.code(res.status).send(body)
      // The memory service answers a *default* persona for keys it has never
      // stored, and a default is stamped updatedAt 0. Report that absence as
      // a 404 rather than a persona-shaped 200 that reads as real emptiness.
      const persona = body as { updatedAt?: number } | null
      if (!persona?.updatedAt) {
        return reply.code(404).send({ error: 'no memory held for this user' })
      }
      void record(op, 'memory.view', `${partnerId}/${userId}`)
      return { partnerId, userId, persona }
    } catch {
      return reply.code(502).send({ error: 'memory service unreachable' })
    }
  })

  app.put<{ Params: UserParams }>('/v1/memory/:partnerId/:userId', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const parsed = PersonaAdminUpdate.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid persona update' })
    const { partnerId, userId } = req.params
    try {
      const res = await memoryFetch(upath`/v1/persona/${partnerId}/${userId}`, {
        method: 'PUT',
        body: JSON.stringify(parsed.data),
      })
      // Audit only what happened: a 404ed update recorded as memory.update is
      // an audit row asserting a write that never landed.
      if (res.ok)
        void record(op, 'memory.update', `${partnerId}/${userId}`, {
          fields: Object.keys(parsed.data),
        })
      else void record(op, 'memory.update_failed', `${partnerId}/${userId}`, { status: res.status })
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'memory service unreachable' })
    }
  })

  app.post<{ Params: UserParams }>('/v1/memory/:partnerId/:userId/clear', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const { partnerId, userId } = req.params
    try {
      const res = await memoryFetch(upath`/v1/persona/${partnerId}/${userId}/clear`, {
        method: 'POST',
        body: '{}',
      })
      if (res.ok) void record(op, 'memory.clear', `${partnerId}/${userId}`)
      else void record(op, 'memory.clear_failed', `${partnerId}/${userId}`, { status: res.status })
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'memory service unreachable' })
    }
  })

  app.delete<{ Params: UserParams }>('/v1/memory/:partnerId/:userId', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const { partnerId, userId } = req.params
    try {
      const res = await memoryFetch(upath`/admin/personas/${partnerId}/${userId}`, {
        method: 'DELETE',
      })
      // A purge that 404ed must never be audited as a purge — that row is the
      // record a deletion request gets judged against.
      if (res.ok) void record(op, 'memory.purge', `${partnerId}/${userId}`)
      else void record(op, 'memory.purge_failed', `${partnerId}/${userId}`, { status: res.status })
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'memory service unreachable' })
    }
  })

  // Bulk purge (partner offboarding) — audited with the row count.
  app.delete<{ Querystring: { partnerId?: string } }>('/v1/memory', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const { partnerId } = req.query
    if (!partnerId) return reply.code(400).send({ error: 'partnerId required' })
    try {
      // The memory-service partner purge cascades: personas plus the
      // partner's user-scope learned facts and user notes. The response and
      // the audit row both carry the full per-store counts.
      const res = await memoryFetch(upath`/admin/personas?partnerId=${partnerId}`, {
        method: 'DELETE',
      })
      const body = (await res.json()) as { deleted?: number; facts?: number; notes?: number }
      if (res.ok)
        void record(op, 'memory.purge_partner', partnerId, {
          deleted: body.deleted ?? 0,
          facts: body.facts ?? 0,
          notes: body.notes ?? 0,
        })
      else void record(op, 'memory.purge_partner_failed', partnerId, { status: res.status })
      return reply.code(res.status).send(body)
    } catch {
      return reply.code(502).send({ error: 'memory service unreachable' })
    }
  })

  // ── auto-learned facts (proxied; memory service owns the data) ──────────
  // The provenance-tracked facts Hippo auto-learns per trader (scope user) or
  // per session — the operator's window into what the model is being told.
  // Same owner-or-operator gate + 502 discipline as the /v1/memory proxies;
  // the purge is destructive and therefore audited.
  app.get<{ Params: UserParams }>(
    '/v1/learned-facts/user/:partnerId/:userId',
    async (req, reply) => {
      const op = operator(req, reply)
      if (!op) return reply
      const { partnerId, userId } = req.params
      try {
        const res = await memoryFetch(upath`/v1/scope/user/${partnerId}/${userId}/facts`)
        return reply.code(res.status).send(await res.json())
      } catch {
        return reply.code(502).send({ error: 'memory service unreachable' })
      }
    },
  )

  app.delete<{ Params: UserParams }>(
    '/v1/learned-facts/user/:partnerId/:userId',
    async (req, reply) => {
      const op = operator(req, reply)
      if (!op) return reply
      const { partnerId, userId } = req.params
      try {
        const res = await memoryFetch(upath`/v1/scope/user/${partnerId}/${userId}/facts`, {
          method: 'DELETE',
        })
        if (res.ok)
          void record(op, 'learned_facts.purge', `${partnerId}/${userId}`, { partnerId, userId })
        else
          void record(op, 'learned_facts.purge_failed', `${partnerId}/${userId}`, {
            status: res.status,
          })
        return reply.code(res.status).send(await res.json())
      } catch {
        return reply.code(502).send({ error: 'memory service unreachable' })
      }
    },
  )

  // Session facts are read-only here: sessions are ephemeral and the clear
  // path belongs to the trader's own settings surface, not the panel.
  app.get<{ Params: { sessionId: string } }>(
    '/v1/learned-facts/session/:sessionId',
    async (req, reply) => {
      const op = operator(req, reply)
      if (!op) return reply
      try {
        const res = await memoryFetch(upath`/v1/scope/session/${req.params.sessionId}/facts`)
        return reply.code(res.status).send(await res.json())
      } catch {
        return reply.code(502).send({ error: 'memory service unreachable' })
      }
    },
  )

  // ── memory-config: freeform scope documents (super-admin only) ─────────
  // The layered memory a super-admin curates (global/host/user) that the
  // gateway composes into the prompt. OWNER-gated (the platform's super-admin
  // tier), audited with the scope level, proxied to the memory service. A
  // pre-prod control plane — the composition itself gates on an entitlement.
  const scopeGet = (path: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ownerOnly(req, reply)) return reply
    try {
      const res = await memoryFetch(path)
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'memory service unreachable' })
    }
  }
  const scopePut =
    (path: string, level: string, target: (p: Record<string, string>) => string) =>
    async (req: FastifyRequest<{ Params: Record<string, string> }>, reply: FastifyReply) => {
      const op = ownerOnly(req, reply)
      if (!op) return reply
      const body = (req.body as { body?: unknown } | null)?.body
      if (typeof body !== 'string') return reply.code(400).send({ error: 'body (string) required' })
      try {
        const res = await memoryFetch(path, { method: 'PUT', body: JSON.stringify({ body }) })
        if (res.ok)
          void record(op, 'memory_config.set', target(req.params), { level, length: body.length })
        else
          void record(op, 'memory_config.set_failed', target(req.params), {
            level,
            status: res.status,
          })
        return reply.code(res.status).send(await res.json())
      } catch {
        return reply.code(502).send({ error: 'memory service unreachable' })
      }
    }

  app.get('/v1/memory-config/global', scopeGet('/v1/scope/global'))
  app.put(
    '/v1/memory-config/global',
    scopePut('/v1/scope/global', 'global', () => 'global'),
  )
  app.get<{ Params: { partnerId: string } }>('/v1/memory-config/host/:partnerId', (req, reply) =>
    scopeGet(upath`/v1/scope/host/${req.params.partnerId}`)(req, reply),
  )
  app.put<{ Params: { partnerId: string } }>('/v1/memory-config/host/:partnerId', (req, reply) =>
    scopePut(
      upath`/v1/scope/host/${req.params.partnerId}`,
      'host',
      (p) => p.partnerId ?? '',
    )(req, reply),
  )
  app.get<{ Params: UserParams }>('/v1/memory-config/user/:partnerId/:userId', (req, reply) =>
    scopeGet(upath`/v1/scope/user/${req.params.partnerId}/${req.params.userId}`)(req, reply),
  )
  app.put<{ Params: UserParams }>('/v1/memory-config/user/:partnerId/:userId', (req, reply) =>
    scopePut(
      upath`/v1/scope/user/${req.params.partnerId}/${req.params.userId}`,
      'user',
      (p) => `${p.partnerId}/${p.userId}`,
    )(req, reply),
  )
  // Session inspector (read-only): the exact composed memory block that was
  // sent for a session — real history, not a re-derivation.
  app.get<{ Params: { sessionId: string } }>('/v1/memory-config/session/:sessionId', (req, reply) =>
    scopeGet(upath`/v1/scope/session/${req.params.sessionId}`)(req, reply),
  )

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

  // ── tech diagnostics (gateway proxy) ─────────────────────────────────────
  // The gateway's live operator telemetry (latency percentiles, call log,
  // load, degraded clock) joined with the intelligence /health mode+model.
  // Any authenticated operator may view; a read, so no audit row. Either
  // upstream being down degrades to null — the page renders what it has.
  app.get('/v1/tech/telemetry', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    let gateway: unknown = null
    try {
      const res = await gatewayFetch('/internal/telemetry')
      if (res.ok) gateway = await res.json()
    } catch {
      /* gateway down — intelligence half still renders */
    }
    let intelligence: { mode: string; model: string } | null = null
    try {
      const res = await fetchImpl(`${intelligenceUrl}/health`, {
        signal: AbortSignal.timeout(3_000),
      })
      if (res.ok) {
        const body = (await res.json()) as { mode?: string; model?: string }
        intelligence = { mode: body.mode ?? 'mock', model: body.model ?? 'mock' }
      }
    } catch {
      /* intelligence down — gateway half still renders */
    }
    return { gateway, intelligence }
  })

  // ── implicit misunderstanding signals (gateway proxy) ────────────────────
  // Rapid rephrases, abandoned tickets/drafts and thumbs-downs, joined to the
  // intent we classified — the "Understanding" block on the Pilot page. Any
  // authenticated operator may view; a read, so no audit row.
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/v1/intent-signals',
    async (req, reply) => {
      const op = operator(req, reply)
      if (!op) return reply
      try {
        const res = await gatewayFetch(`/internal/intent-signals${queryString(req.query)}`)
        return reply.code(res.status).send(await res.json())
      } catch {
        return reply.code(502).send({ error: 'gateway unreachable' })
      }
    },
  )

  // JSONL passthrough (NOT json — the body is the eval harness's row shape,
  // one object per line, streamed to the operator as a file).
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/v1/intent-signals/export',
    async (req, reply) => {
      const op = operator(req, reply)
      if (!op) return reply
      try {
        const res = await gatewayFetch(`/internal/intent-signals/export${queryString(req.query)}`)
        const body = await res.text()
        return reply
          .code(res.status)
          .type(res.ok ? 'application/x-ndjson' : 'application/json')
          .header('content-disposition', 'attachment; filename="intent-signals.jsonl"')
          .send(body)
      } catch {
        return reply.code(502).send({ error: 'gateway unreachable' })
      }
    },
  )

  // ── proactive alerts (gateway proxy) ─────────────────────────────────────
  // Per-partner alert list (newest first, capped upstream) and the operator
  // cancel switch. partnerId is required — the gateway 400s without it, and
  // failing here first keeps the error message honest about whose rule it is.
  app.get<{ Querystring: { partnerId?: string } }>('/v1/alerts', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    if (!req.query.partnerId) return reply.code(400).send({ error: 'partnerId required' })
    try {
      const res = await gatewayFetch(upath`/internal/alerts?partnerId=${req.query.partnerId}`)
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'gateway unreachable' })
    }
  })

  app.post<{ Params: { id: string } }>('/v1/alerts/:id/cancel', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const body = req.body as { partnerId?: unknown; userKey?: unknown } | null
    if (typeof body?.partnerId !== 'string' || typeof body?.userKey !== 'string') {
      return reply.code(400).send({ error: 'partnerId and userKey required' })
    }
    try {
      const res = await gatewayFetch(upath`/internal/alerts/${req.params.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ partnerId: body.partnerId, userKey: body.userKey }),
      })
      if (res.ok)
        void record(op, 'alert.cancel', req.params.id, {
          partnerId: body.partnerId,
          userKey: body.userKey,
        })
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'gateway unreachable' })
    }
  })

  // ── share links (gateway proxy) ──────────────────────────────────────────
  // Live/unexpired shares per partner; DELETE is the kill switch for a link
  // that leaked. Destructive, so audited — on success only.
  app.get<{ Querystring: { partnerId?: string } }>('/v1/shares', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    if (!req.query.partnerId) return reply.code(400).send({ error: 'partnerId required' })
    try {
      const res = await gatewayFetch(upath`/internal/shares?partnerId=${req.query.partnerId}`)
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'gateway unreachable' })
    }
  })

  app.delete<{ Params: { id: string } }>('/v1/shares/:id', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    try {
      // body '{}' on purpose: a bodyless DELETE through a JSON content-type
      // client 400s at the gateway (Fastify rejects empty JSON bodies).
      const res = await gatewayFetch(upath`/internal/shares/${req.params.id}`, {
        method: 'DELETE',
        body: '{}',
      })
      if (res.ok) void record(op, 'share.delete', req.params.id)
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'gateway unreachable' })
    }
  })

  // ── user identities (gateway proxy) ──────────────────────────────────────
  // Per-partner identity roster (last-seen DESC, capped upstream); the
  // gateway strips pinHash before answering. A read, so no audit row.
  app.get<{ Querystring: { partnerId?: string } }>('/v1/identities', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    if (!req.query.partnerId) return reply.code(400).send({ error: 'partnerId required' })
    try {
      const res = await gatewayFetch(upath`/internal/identities?partnerId=${req.query.partnerId}`)
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'gateway unreachable' })
    }
  })

  // ── forced-degraded control (gateway proxy) ──────────────────────────────
  // GET lists the partners currently forced degraded; POST flips one. The
  // force is an operator action against a live partner surface — audited.
  app.get('/v1/degraded', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    try {
      const res = await gatewayFetch('/internal/degraded')
      return reply.code(res.status).send(await res.json())
    } catch {
      return reply.code(502).send({ error: 'gateway unreachable' })
    }
  })

  app.post('/v1/degraded', async (req, reply) => {
    const op = operator(req, reply)
    if (!op) return reply
    const body = req.body as { partnerId?: unknown; forced?: unknown } | null
    if (typeof body?.partnerId !== 'string' || typeof body?.forced !== 'boolean') {
      return reply.code(400).send({ error: 'partnerId (string) and forced (boolean) required' })
    }
    try {
      const res = await gatewayFetch('/internal/degraded', {
        method: 'POST',
        body: JSON.stringify({ partnerId: body.partnerId, forced: body.forced }),
      })
      if (res.ok) void record(op, 'degraded.force', body.partnerId, { forced: body.forced })
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
        gatewayFetch('/internal/metrics'),
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
      const res = await gatewayFetch('/internal/metrics')
      if (res.ok) gateway = await res.json()
    } catch {
      /* gateway down — counts still render */
    }

    // The intelligence-side answer-cache stats are authoritative (Redis-backed
    // when configured); the gateway's cache counter is an in-process
    // passthrough that resets on restart.
    let intelligence: {
      mode: string
      model: string
      cache?: { entries: number; hitRate: number }
      usage?: unknown
    } | null = null
    try {
      const res = await fetchImpl(`${intelligenceUrl}/health`, {
        signal: AbortSignal.timeout(3_000),
      })
      if (res.ok) {
        const body = (await res.json()) as {
          mode?: string
          model?: string
          cache?: { entries?: number; hitRate?: number }
        }
        intelligence = {
          mode: body.mode ?? 'mock',
          model: body.model ?? 'mock',
          ...(body.cache
            ? { cache: { entries: body.cache.entries ?? 0, hitRate: body.cache.hitRate ?? 0 } }
            : {}),
        }
      }
    } catch {
      /* intelligence down — rest of the dashboard still renders */
    }
    // Measured token usage (may 404 on an older intelligence deploy — the
    // Pilot page falls back to its assumptions estimator when absent).
    if (intelligence) {
      try {
        const res = await fetchImpl(`${intelligenceUrl}/admin/usage`, {
          signal: AbortSignal.timeout(3_000),
        })
        if (res.ok) {
          const u = (await res.json()) as { calls?: unknown }
          // Shape-checked: an older deploy answering 200 with something else
          // (or a bare {}) must not masquerade as measured usage.
          if (u && typeof u.calls === 'number') intelligence.usage = u
        }
      } catch {
        /* usage stays absent */
      }
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
    // Full per-partner MAU-vs-quota rows for the Pilot page (alerts keep the
    // ≥80% cut). Quota is null on quota-less plans — utilization is honest —.
    const partnerMau: Array<{
      partnerId: string
      venueName: string
      status: string
      mau: number
      quota: number | null
    }> = []
    // One plans.list() serves every partner row (and the counts block below)
    // — a per-partner plans.get() here was an N+1 against the plans table.
    const [partnerRows, planRows] = await Promise.all([partners.list(), plans.list()])
    const planById = new Map(planRows.map((plan) => [plan.planId, plan]))
    for (const p of partnerRows) {
      const plan = p.planId ? (planById.get(p.planId) ?? null) : null
      const mau = byPartner[p.partnerId] ?? 0
      partnerMau.push({
        partnerId: p.partnerId,
        venueName: p.venueName,
        status: p.status,
        mau,
        quota: plan?.mauQuota ?? null,
      })
      if (p.status !== 'active' || plan?.mauQuota == null) continue
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
    partnerMau.sort((a, b) => b.mau - a.mau)

    return {
      gateway,
      intelligence,
      alerts,
      partnerMau,
      counts: {
        partners: partnerRows.length,
        // Self-serve `hippo register` signups waiting on operator approval.
        sandboxPartners: partnerRows.filter((p) => p.status === 'sandbox').length,
        plans: planRows.length,
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

  app.get('/health', async () => ({ ok: true, service: 'admin', sha: GIT_SHA, builtAt: BUILT_AT }))

  return app
}
