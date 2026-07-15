/**
 * Production gateway — sessions, SSE frame journal with resume, orchestrator.
 * Speaks the exact wire surface the SDK was built against (identical to
 * services/mock-gateway): POST /v1/session, GET /v1/stream (SSE),
 * POST /v1/turns, GET /health. See Build Plan/10 BE Architecture §1–2.
 */
import cors from '@fastify/cors'
import { Uplink } from '@hippo/protocol'
import Fastify from 'fastify'
import { createOrchestrator } from './orchestrator/index.js'
import { createIntelligenceClient } from './orchestrator/intelligence.js'
import { createMarketClient } from './orchestrator/market.js'
import { createMemoryClient } from './orchestrator/memory.js'
import { createSeamClient } from './orchestrator/seam.js'
import { authenticate, SessionStore } from './plugins/auth.js'
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
}

export async function buildApp(opts: GatewayOptions = {}) {
  const isTest = process.env.NODE_ENV === 'test'
  const devMode = opts.devMode ?? process.env.HIPPO_DEV !== '0'

  const app = Fastify({ logger: { level: isTest ? 'silent' : 'info' } })
  await app.register(cors, { origin: true })

  const sessions = new SessionStore()
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
    const auth = authenticate(req.headers.authorization, body.partnerKey, devMode)
    if (!auth.ok) {
      reply.code(401)
      return { error: auth.error }
    }
    const session = sessions.create(auth.partner, auth.venueUserId)
    return {
      sessionId: session.id,
      config: {
        venueName: auth.partner.venueName,
        locales: auth.partner.locales,
        suggestedQueries: auth.partner.suggestedQueries,
      },
    }
  })

  app.get('/v1/stream', async (req, reply) => {
    const { session: sessionId } = req.query as { session?: string }
    const session = sessionId ? sessions.get(sessionId) : null
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

  return { app, sessions, emit, telemetry }
}

if (process.env.NODE_ENV !== 'test') {
  const { app } = await buildApp()
  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`gateway on :${PORT} — sessions, SSE journal, orchestrator live`)
}
