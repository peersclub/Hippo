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
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { SimVenueAdapter } from './sim-venue.js'
import type { LifecycleEvent, PrepareRequest, VenueAdapter } from './types.js'

type AuditEntry = {
  ts: number
  kind: 'prepare' | 'confirm' | 'cancel' | 'event_delivered' | 'event_delivery_failed'
  ticketId: string
  idempotencyKey: string
  detail?: string
}

const SIDES = new Set(['buy', 'sell'])
const TYPES = new Set(['market', 'limit'])

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

export function buildService(adapter: VenueAdapter = new SimVenueAdapter()): FastifyInstance & {
  audit: AuditEntry[]
} {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test' && { level: 'info' },
  }) as unknown as FastifyInstance & { audit: AuditEntry[] }

  const audit: AuditEntry[] = []
  app.audit = audit
  const record = (entry: Omit<AuditEntry, 'ts' | 'idempotencyKey'>) =>
    audit.push({ ...entry, ts: Date.now(), idempotencyKey: `idem_${randomUUID().slice(0, 12)}` })

  /** callbackUrl per confirmed ticket — where venue events get delivered. */
  const callbacks = new Map<string, string>()

  adapter.onEvent((event: LifecycleEvent) => {
    const callbackUrl = callbacks.get(event.ticketId)
    if (!callbackUrl) return
    if (event.phase !== 'partial') callbacks.delete(event.ticketId) // terminal
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
      record({
        kind: 'event_delivery_failed',
        ticketId: event.ticketId,
        detail: String(err),
      })
    }
  }

  app.post('/v1/prepare', async (req, reply) => {
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

  app.post<{ Params: { id: string } }>('/v1/tickets/:id/confirm', async (req, reply) => {
    const { callbackUrl } = (req.body ?? {}) as { callbackUrl?: string }
    if (typeof callbackUrl !== 'string' || !callbackUrl.startsWith('http'))
      return reply.code(400).send({ error: 'callbackUrl required' })
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

  app.post<{ Params: { id: string } }>('/v1/tickets/:id/cancel', async (req) => {
    const cancelled = await adapter.cancel(req.params.id)
    callbacks.delete(req.params.id)
    record({ kind: 'cancel', ticketId: req.params.id, detail: String(cancelled) })
    return { cancelled }
  })

  app.get<{ Params: { partnerId: string; userId: string } }>(
    '/v1/portfolio/:partnerId/:userId',
    async (req) => adapter.portfolio(req.params.partnerId, req.params.userId),
  )

  app.get('/internal/audit', async () => audit)

  app.get('/health', async () => ({ ok: true, service: 'seam', audited: audit.length }))

  return app
}
