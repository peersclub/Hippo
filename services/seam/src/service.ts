/**
 * Seam service HTTP surface (regional pod):
 *   POST /v1/prepare                      → PreparedTicket
 *   POST /v1/tickets/:id/confirm          → 202; venue events → callbackUrl
 *   POST /v1/tickets/:id/cancel           → { cancelled }
 *   GET  /v1/portfolio/:partnerId/:userId → { positions, openOrders }  (never cached)
 *   GET  /internal/audit                  → structured audit trail
 *   GET  /health
 *
 * Every prepare/confirm/cancel/delivery is appended to the audit log with an
 * idempotency key (BE doc §7) — the seam is the compliance-critical surface.
 * Venue lifecycle events are pushed to the caller's `callbackUrl` (the
 * gateway's /internal/venue-events); one retry, then the audit records the
 * failure — the gateway's poll reconciler is the production backstop.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { SimVenueAdapter } from './sim-venue.js'
import type {
  Capability,
  LifecycleEvent,
  OrderPlan,
  PreparedTicket,
  PrepareRequest,
  VenueAdapter,
} from './types.js'

type AuditEntry = {
  ts: number
  kind: 'prepare' | 'confirm' | 'cancel' | 'event_delivered' | 'event_delivery_failed'
  ticketId: string
  idempotencyKey: string
  detail?: string
}

/** In-memory audit tail cap; the logger (below) retains the full trail. */
const MAX_AUDIT_ENTRIES = 5_000

const SIDES = new Set(['buy', 'sell'])
const TYPES = new Set(['market', 'limit'])

/**
 * Options for the seam service. The whole trading surface is
 * compliance-critical and must never be network-open, so both knobs default to
 * env and fail closed when unset.
 */
export type ServiceOptions = {
  /** Shared secret guarding the trading + /internal surface; defaults to env. */
  internalToken?: string
  /**
   * Comma-separated list of origins the confirm `callbackUrl` may target
   * (SSRF allowlist); defaults to SEAM_CALLBACK_ALLOWED_ORIGINS env, then to
   * the gateway's own callback/base origin.
   */
  callbackAllowedOrigins?: string
}

/**
 * Origins the confirm `callbackUrl` may deliver venue events to. The seam
 * POSTs order-lifecycle events to a caller-supplied URL, so without an
 * allowlist a network peer could point the seam at any internal host (SSRF).
 * We only ever deliver to origins we explicitly trust. Precedence:
 *   1. opts.callbackAllowedOrigins  2. SEAM_CALLBACK_ALLOWED_ORIGINS env
 *   3. fallback: the origin of GATEWAY_CALLBACK_URL / GATEWAY_URL.
 */
function resolveCallbackOrigins(opts: ServiceOptions): Set<string> {
  const raw = opts.callbackAllowedOrigins ?? process.env.SEAM_CALLBACK_ALLOWED_ORIGINS ?? ''
  const origins = new Set<string>()
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      origins.add(new URL(entry).origin)
    } catch {
      /* ignore unparseable entries */
    }
  }
  if (origins.size === 0) {
    const fallback = process.env.GATEWAY_CALLBACK_URL ?? process.env.GATEWAY_URL
    if (fallback) {
      try {
        origins.add(new URL(fallback).origin)
      } catch {
        /* ignore */
      }
    }
  }
  return origins
}

function parsePrepare(body: unknown): PrepareRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const raw = body as Record<string, unknown>
  if (
    typeof raw.partnerId !== 'string' ||
    typeof raw.userId !== 'string' ||
    !SIDES.has(String(raw.side)) ||
    typeof raw.size !== 'string' ||
    typeof raw.instrument !== 'string' ||
    !/^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/.test(raw.instrument) ||
    !TYPES.has(String(raw.orderType))
  )
    return null
  if (raw.orderType === 'limit' && typeof raw.limitPrice !== 'string') return null
  return {
    partnerId: raw.partnerId,
    userId: raw.userId,
    side: raw.side as PrepareRequest['side'],
    size: raw.size,
    instrument: raw.instrument,
    orderType: raw.orderType as PrepareRequest['orderType'],
    ...(typeof raw.limitPrice === 'string' ? { limitPrice: raw.limitPrice } : {}),
  }
}

const INSTRUMENT = /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/
const CAPABILITIES = new Set<Capability>(['spot', 'futures_perp', 'options'])

/** Validate a capability-tagged order plan off the wire into a typed OrderPlan. */
function parsePlan(body: unknown): OrderPlan | null {
  if (typeof body !== 'object' || body === null) return null
  const r = body as Record<string, unknown>
  if (typeof r.partnerId !== 'string' || typeof r.userId !== 'string') return null
  if (!CAPABILITIES.has(r.capability as Capability)) return null
  if (!TYPES.has(String(r.orderType))) return null
  if (typeof r.size !== 'string') return null
  if (r.orderType === 'limit' && typeof r.limitPrice !== 'string') return null
  const orderType = r.orderType as PrepareRequest['orderType']
  const limit = typeof r.limitPrice === 'string' ? { limitPrice: r.limitPrice } : {}

  if (r.capability === 'spot') {
    if (typeof r.instrument !== 'string' || !INSTRUMENT.test(r.instrument)) return null
    if (!SIDES.has(String(r.side))) return null
    return {
      capability: 'spot',
      partnerId: r.partnerId,
      userId: r.userId,
      side: r.side as 'buy' | 'sell',
      size: r.size,
      instrument: r.instrument,
      orderType,
      ...limit,
    }
  }
  if (r.capability === 'futures_perp') {
    if (typeof r.instrument !== 'string' || !INSTRUMENT.test(r.instrument)) return null
    if (r.direction !== 'long' && r.direction !== 'short') return null
    if (r.marginMode !== 'isolated' && r.marginMode !== 'cross') return null
    if (typeof r.leverage !== 'number' || !(r.leverage >= 1)) return null
    return {
      capability: 'futures_perp',
      partnerId: r.partnerId,
      userId: r.userId,
      instrument: r.instrument,
      direction: r.direction,
      action: r.action === 'close' ? 'close' : 'open',
      leverage: r.leverage,
      marginMode: r.marginMode,
      size: r.size,
      reduceOnly: r.reduceOnly === true,
      orderType,
      ...limit,
    }
  }
  // options
  if (typeof r.underlying !== 'string') return null
  if (r.optionType !== 'call' && r.optionType !== 'put') return null
  if (!SIDES.has(String(r.side))) return null
  if (typeof r.strike !== 'string' || typeof r.expiry !== 'string') return null
  return {
    capability: 'options',
    partnerId: r.partnerId,
    userId: r.userId,
    underlying: r.underlying,
    optionType: r.optionType,
    side: r.side as 'buy' | 'sell',
    strike: r.strike,
    expiry: r.expiry,
    size: r.size,
    orderType,
    ...limit,
  }
}

export function buildService(
  adapter: VenueAdapter = new SimVenueAdapter(),
  opts: ServiceOptions = {},
): FastifyInstance & {
  audit: AuditEntry[]
} {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test' && { level: process.env.LOG_LEVEL ?? 'info' },
  }) as unknown as FastifyInstance & { audit: AuditEntry[] }

  // Adapters absorb venue-API failures to keep lifecycles resilient; the
  // logger is how those failures stay visible to operators.
  adapter.setLogger?.(app.log)

  // In-memory tail of the audit trail (bounded — a steady-state pod must not
  // grow with order flow). Every entry is ALSO written through the logger, so
  // the log pipeline retains the full compliance record across restarts; the
  // durable telemetry_events store (BE doc §7) is the production home.
  const audit: AuditEntry[] = []
  let auditedTotal = 0
  app.audit = audit
  const record = (entry: Omit<AuditEntry, 'ts' | 'idempotencyKey'>) => {
    const full: AuditEntry = {
      ...entry,
      ts: Date.now(),
      idempotencyKey: `idem_${randomUUID().slice(0, 12)}`,
    }
    audit.push(full)
    auditedTotal += 1
    if (audit.length > MAX_AUDIT_ENTRIES) audit.shift()
    app.log.info({ audit: full }, 'seam audit')
  }

  // ── trust boundary: every trading + /internal route requires the shared
  // INTERNAL_API_TOKEN (timing-safe, fail-closed). This surface places and
  // cancels real orders and reads balances — it must never be network-open.
  // Same pattern as the gateway's /internal routes and memory's /admin.
  const internalToken = opts.internalToken ?? process.env.INTERNAL_API_TOKEN ?? ''
  function internalGuard(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!internalToken) {
      reply.code(503).send({ error: 'trading surface disabled: INTERNAL_API_TOKEN not set' })
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

  const callbackOrigins = resolveCallbackOrigins(opts)

  /** callbackUrl per confirmed ticket — where venue events get delivered. */
  const callbacks = new Map<string, string>()

  /** Only these phases end a ticket's lifecycle — awaiting_confirm (placement
   * acks, cancel-pending) and partial both precede more events. Deleting the
   * route on any non-partial phase silently dropped the fill that followed a
   * placement ack. */
  const TERMINAL_PHASES = new Set(['filled', 'cancelled', 'expired'])

  adapter.onEvent((event: LifecycleEvent) => {
    const callbackUrl = callbacks.get(event.ticketId)
    if (!callbackUrl) return
    if (TERMINAL_PHASES.has(event.phase)) callbacks.delete(event.ticketId)
    void deliver(callbackUrl, event)
  })

  async function deliver(url: string, event: LifecycleEvent, attempt = 1): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(3_000),
      })
      if (!res.ok) throw new Error(`callback ${res.status}`)
      record({ kind: 'event_delivered', ticketId: event.ticketId, detail: event.phase })
    } catch (err) {
      if (attempt < 2) return deliver(url, event, attempt + 1) // one retry
      // The gateway missed a lifecycle event (e.g. the trader never sees
      // FILLED) — that must be loud, not just a row in the in-memory audit.
      app.log.error(
        { err, ticketId: event.ticketId, phase: event.phase, url },
        'venue event delivery failed after retry',
      )
      record({
        kind: 'event_delivery_failed',
        ticketId: event.ticketId,
        detail: String(err),
      })
    }
  }

  app.post('/v1/prepare', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const parsed = parsePrepare(req.body)
    if (parsed === null) return reply.code(400).send({ error: 'invalid prepare request' })
    try {
      const ticket = await adapter.prepare(parsed)
      record({
        kind: 'prepare',
        ticketId: ticket.ticketId,
        detail: `${parsed.side} ${parsed.size} ${parsed.instrument}`,
      })
      return ticket
    } catch (err) {
      return reply.code(502).send({ error: `venue prepare failed: ${String(err)}` })
    }
  })

  // What the venue supports, per capability — callers gate plans on this.
  app.get('/v1/capabilities', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    return adapter.capabilities()
  })

  // Capability-tagged prepare (spot / futures_perp / options). Gated on the
  // venue's advertised capabilities, then routed to prepareOrder — with a spot
  // fallback to prepare() so pre-capability adapters keep working.
  app.post('/v1/prepare-order', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const plan = parsePlan(req.body)
    if (plan === null) return reply.code(400).send({ error: 'invalid order plan' })
    const caps = await adapter.capabilities()
    if (caps[plan.capability] === undefined)
      return reply
        .code(422)
        .send({ error: `capability '${plan.capability}' not supported on this venue` })
    const detail =
      plan.capability === 'options'
        ? `options ${plan.underlying}`
        : `${plan.capability} ${plan.instrument}`
    try {
      let ticket: PreparedTicket
      if (adapter.prepareOrder) ticket = await adapter.prepareOrder(plan)
      else if (plan.capability === 'spot')
        ticket = await adapter.prepare({
          partnerId: plan.partnerId,
          userId: plan.userId,
          side: plan.side,
          size: plan.size,
          instrument: plan.instrument,
          orderType: plan.orderType,
          ...(plan.limitPrice ? { limitPrice: plan.limitPrice } : {}),
        })
      else
        return reply.code(422).send({ error: `venue adapter cannot prepare '${plan.capability}'` })
      record({ kind: 'prepare', ticketId: ticket.ticketId, detail })
      return ticket
    } catch (err) {
      return reply.code(502).send({ error: `venue prepare failed: ${String(err)}` })
    }
  })

  app.post<{ Params: { id: string } }>('/v1/tickets/:id/confirm', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const { callbackUrl } = (req.body ?? {}) as { callbackUrl?: string }
    if (typeof callbackUrl !== 'string' || !callbackUrl.startsWith('http'))
      return reply.code(400).send({ error: 'callbackUrl required' })
    // SSRF guard: only deliver venue events to explicitly trusted origins.
    let origin: string
    try {
      origin = new URL(callbackUrl).origin
    } catch {
      return reply.code(400).send({ error: 'callbackUrl invalid' })
    }
    if (!callbackOrigins.has(origin))
      return reply.code(400).send({ error: 'callbackUrl origin not allowed' })
    try {
      callbacks.set(req.params.id, callbackUrl)
      await adapter.confirm(req.params.id)
      record({ kind: 'confirm', ticketId: req.params.id })
      return reply.code(202).send({ accepted: true })
    } catch (err) {
      callbacks.delete(req.params.id)
      return reply.code(404).send({ error: String(err) })
    }
  })

  app.post<{ Params: { id: string } }>('/v1/tickets/:id/cancel', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const cancelled = await adapter.cancel(req.params.id)
    callbacks.delete(req.params.id)
    record({ kind: 'cancel', ticketId: req.params.id, detail: String(cancelled) })
    return { cancelled }
  })

  app.get<{ Params: { partnerId: string; userId: string } }>(
    '/v1/portfolio/:partnerId/:userId',
    async (req, reply) => {
      if (!internalGuard(req, reply)) return reply
      return adapter.portfolio(req.params.partnerId, req.params.userId)
    },
  )

  app.get('/internal/audit', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    return audit
  })

  app.get('/health', async () => ({ ok: true, service: 'seam', audited: auditedTotal }))

  return app
}
