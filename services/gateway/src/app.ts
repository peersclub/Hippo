/**
 * Production gateway — sessions, SSE frame journal with resume, orchestrator.
 * Speaks the exact wire surface the SDK was built against (identical to
 * services/mock-gateway): POST /v1/session, GET /v1/stream (SSE),
 * POST /v1/turns, GET /health. See Build Plan/10 BE Architecture §1–2.
 */
import { timingSafeEqual } from 'node:crypto'
import cors from '@fastify/cors'
import { Uplink } from '@hippo/protocol'
import {
  getPool,
  InMemoryPartnerStore,
  InMemoryPlanStore,
  InMemoryUserStore,
  type PartnerStore,
  type PlanStore,
  PostgresPartnerStore,
  PostgresPlanStore,
  PostgresUserStore,
  type UserStore,
} from '@hippo/stores'
import Fastify from 'fastify'
import { createOrchestrator } from './orchestrator/index.js'
import { createIntelligenceClient } from './orchestrator/intelligence.js'
import { createMarketClient } from './orchestrator/market.js'
import { createMemoryClient } from './orchestrator/memory.js'
import { createSeamClient } from './orchestrator/seam.js'
import { authenticate, createSessionStore, type SessionStore } from './plugins/auth.js'
import { createEmitter, streamSession } from './plugins/sse.js'
import { Telemetry } from './plugins/telemetry.js'

const PORT = Number(process.env.PORT ?? 8788)

export type GatewayOptions = {
  intel?: import('./orchestrator/intelligence.js').IntelligenceClient
  market?: import('./orchestrator/market.js').MarketClient
  memory?: import('./orchestrator/memory.js').MemoryClient
  seam?: import('./orchestrator/seam.js').SeamClient
  /** Throw on invalid frames instead of log+drop. Defaults to true in tests. */
  strictFrames?: boolean
  /** Allow anonymous {partnerKey} sessions. Defaults to HIPPO_DEV !== '0'. */
  devMode?: boolean
  /** Shared secret for /internal/sessions (admin panel). Fail-closed when
   * unset. Defaults to INTERNAL_API_TOKEN. */
  internalToken?: string
  /** Partner/plan/user registries. Postgres when DATABASE_URL is set,
   * in-memory (koinbx-dev seed) otherwise. */
  partnerStore?: PartnerStore
  planStore?: PlanStore
  userStore?: UserStore
  /** Override the session store (tests inject a Redis-backed one). Defaults to
   * Redis when REDIS_URL is set, else in-memory. */
  sessions?: SessionStore
}

export async function buildApp(opts: GatewayOptions = {}) {
  const isTest = process.env.NODE_ENV === 'test'
  const devMode = opts.devMode ?? process.env.HIPPO_DEV !== '0'

  const app = Fastify({ logger: { level: isTest ? 'silent' : 'info' } })
  await app.register(cors, { origin: true })

  const usePg = Boolean(process.env.DATABASE_URL) && !isTest
  const partners =
    opts.partnerStore ?? (usePg ? new PostgresPartnerStore(getPool()) : new InMemoryPartnerStore())
  const plans =
    opts.planStore ?? (usePg ? new PostgresPlanStore(getPool()) : new InMemoryPlanStore())
  const users =
    opts.userStore ?? (usePg ? new PostgresUserStore(getPool()) : new InMemoryUserStore())

  const sessions =
    opts.sessions ??
    createSessionStore({
      ...(process.env.REDIS_URL ? { redisUrl: process.env.REDIS_URL } : {}),
      log: app.log,
      // Durable resume resolves partners from the registry, not a hardcoded list.
      partnerLookup: (partnerId) => partners.get(partnerId),
    })
  const telemetry = new Telemetry()
  const emit = createEmitter({ strict: opts.strictFrames ?? isTest, log: app.log })
  const orchestrator = createOrchestrator({
    intel: opts.intel ?? createIntelligenceClient(),
    market: opts.market ?? createMarketClient(),
    memory: opts.memory ?? createMemoryClient(),
    seam: opts.seam ?? createSeamClient(),
    emit,
    telemetry,
    log: app.log,
  })

  app.post('/v1/session', async (req, reply) => {
    const body = (req.body ?? {}) as { partnerKey?: string }
    const auth = await authenticate(partners, req.headers.authorization, body.partnerKey, devMode)
    if (!auth.ok) {
      reply.code(401)
      return { error: auth.error }
    }

    // Blocked end-users never get a session (admin panel primitive).
    if (auth.venueUserId) {
      const user = await users.get(auth.partner.partnerId, auth.venueUserId)
      if (user?.status === 'blocked') {
        reply.code(401)
        return { error: 'user blocked' }
      }
    }

    // Plan MAU quota: a NEW distinct user this month past the ceiling → 429.
    // Returning users (already counted) keep working — the quota bounds
    // billable distinct users, it never cuts off someone mid-month.
    const plan = auth.partner.planId ? await plans.get(auth.partner.planId) : undefined
    if (plan?.mauQuota != null) {
      const alreadyCounted = auth.venueUserId
        ? telemetry.hasPartnerUser(auth.partner.partnerId, auth.venueUserId)
        : false
      if (!alreadyCounted && telemetry.partnerMau(auth.partner.partnerId) >= plan.mauQuota) {
        reply.code(429)
        return { error: 'plan MAU quota reached' }
      }
    }

    const session = sessions.create(auth.partner, auth.venueUserId)
    telemetry.recordPartnerUser(auth.partner.partnerId, auth.venueUserId ?? session.id)

    // Lazily register authenticated end-users (never anonymous sessions);
    // fire-and-forget — registry writes must not slow session mint.
    if (auth.venueUserId) {
      void users
        .upsertSeen(auth.partner.partnerId, auth.venueUserId)
        .catch((err) => app.log.warn({ err }, 'users upsert failed'))
    }

    return {
      sessionId: session.id,
      config: {
        venueName: auth.partner.venueName,
        locales: auth.partner.locales,
        suggestedQueries: auth.partner.suggestedQueries,
        // Plan entitlements pass through for SDK feature gating (additive).
        ...(plan ? { entitlements: plan.entitlements } : {}),
      },
    }
  })

  app.get('/v1/stream', async (req, reply) => {
    const { session: sessionId } = req.query as { session?: string }
    // Live object first; on a Redis-backed store, fall back to a durable cold
    // resume (rebuild + replay the frame journal) so a reconnect survives a
    // pod restart. In-memory stores have no `resume` — a miss stays a miss.
    let session = sessionId ? sessions.get(sessionId) : null
    if (!session && sessionId && sessions.resume) session = await sessions.resume(sessionId)
    if (!session) {
      reply.code(404)
      return { error: 'unknown session' }
    }
    // Opening frames land in the journal first, so the replay-then-live path
    // below is the only delivery mechanism — one ordering for everything.
    orchestrator.onStreamConnect(session)
    return streamSession(session, req, reply)
  })

  app.post('/v1/turns', async (req, reply) => {
    const parsed = Uplink.safeParse(req.body)
    if (!parsed.success) {
      reply.code(400)
      return { error: 'invalid uplink', issues: parsed.error.issues }
    }
    const session = sessions.get(parsed.data.sessionId)
    if (!session) {
      reply.code(404)
      return { error: 'unknown session' }
    }
    orchestrator.handleUplink(session, parsed.data)
    return { ok: true }
  })

  /** Venue lifecycle events delivered by the seam (the callbackUrl given at
   * confirm time). Internal route: in pods this sits on the cluster network
   * behind mTLS, never exposed through the partner-facing ingress. */
  app.post('/internal/venue-events', async (req, reply) => {
    const event = req.body as import('./orchestrator/seam.js').VenueEvent
    if (typeof event?.ticketId !== 'string' || typeof event?.phase !== 'string') {
      reply.code(400)
      return { error: 'invalid venue event' }
    }
    const routed = orchestrator.onVenueEvent(event)
    return { ok: true, routed }
  })

  app.get('/health', async () => ({ ok: true, service: 'gateway' }))

  // In-memory counters for dev; OTel + telemetry_events replace this in pods.
  app.get('/internal/metrics', async () => telemetry.snapshot())

  // ── live-session inventory + kill switch (admin panel) ──────────────────
  // Guarded by INTERNAL_API_TOKEN (timing-safe, fail-closed) — unlike the
  // mTLS-assumed routes above, revoking sessions is a mutating power.
  const internalToken = opts.internalToken ?? process.env.INTERNAL_API_TOKEN ?? ''
  function internalGuard(
    req: { headers: Record<string, unknown> },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): boolean {
    if (!internalToken) {
      reply.code(503).send({ error: 'sessions surface disabled: INTERNAL_API_TOKEN not set' })
      return false
    }
    const presented = req.headers['x-hippo-internal-token']
    const actual = Buffer.from(typeof presented === 'string' ? presented : '')
    const expected = Buffer.from(internalToken)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      reply.code(401).send({ error: 'invalid internal token' })
      return false
    }
    return true
  }

  app.get<{ Querystring: { partnerId?: string } }>('/internal/sessions', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const all = sessions.list()
    const { partnerId } = req.query
    return partnerId ? all.filter((s) => s.partnerId === partnerId) : all
  })

  app.delete<{ Params: { id: string } }>('/internal/sessions/:id', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    return { revoked: sessions.revoke(req.params.id) }
  })

  return { app, sessions, emit, telemetry, partners, plans, users }
}

if (process.env.NODE_ENV !== 'test') {
  const { app } = await buildApp()
  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`gateway on :${PORT} — sessions, SSE journal, orchestrator live`)
}
