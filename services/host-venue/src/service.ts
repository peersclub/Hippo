/**
 * Assetworks Exchange HTTP surface.
 *
 * TWO audiences, deliberately separated:
 *   • The PARASITE (Hippo's seam adapter) → the signed `/api/v1/trade/*` wire,
 *     a standard HMAC-signed venue trade API so the integration is exercised
 *     against genuine rails, not a sim timer.
 *   • The HOST'S OWN UI (first-party) → unsigned `/ui/*`, `/stream` (SSE),
 *     `/v1/capabilities`, `/admin/config`. The UI is the venue's own front end;
 *     it doesn't sign, it has a session.
 *
 * Both drive the SAME VenueStore, so an order the conversational parasite
 * places shows up in the host's native blotter and moves the same balances.
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { type ApiKeyRecord, verifySignature } from './hmac.js'
import type { VenueStore } from './store.js'
import {
  type AdminConfig,
  type Market,
  ORDER_SIDE,
  ORDER_STATUS,
  type Order,
  type PlaceRequest,
  TRADE_TYPE,
} from './types.js'

export type BuildOptions = {
  store: VenueStore
  /** apiKey → { secret, userId }. The parasite's key resolves to the SAME
   *  userId the host UI trades as, so their orders share one book. */
  keys: Map<string, ApiKeyRecord>
  /** Optional guard on /admin mutations; open in dev when unset. */
  adminToken?: string
  /** The userId the first-party UI trades as (and the demo key maps to). */
  uiUserId?: string
  /** Instruments advertised to the parasite via /v1/capabilities. */
  instruments?: string[]
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v))

/** Parse the signed (+ perp extension) wire body into a PlaceRequest. */
function parsePlace(body: Record<string, unknown>): PlaceRequest | string {
  const pairName = String(body.pairName ?? '')
  if (!/^[A-Z0-9]{2,10}-[A-Z0-9]{2,10}$/.test(pairName)) return 'invalid pairName'
  const side = num(body.orderType) === ORDER_SIDE.sell ? 'sell' : 'buy'
  const kind = num(body.tradeType) === TRADE_TYPE.market ? 'market' : 'limit'
  const qty = num(body.qty)
  const rate = num(body.rate)
  if (!Number.isFinite(qty) || qty <= 0) return 'invalid qty'
  if (!Number.isFinite(rate) || rate <= 0) return 'invalid rate'
  const market: Market = body.market === 'perp' ? 'perp' : 'spot'
  const req: PlaceRequest = { market, pairName, side, kind, qty, rate }
  if (typeof body.clientOrderId === 'string') req.clientOrderId = body.clientOrderId
  if (typeof body.marketOrderAmount === 'number') req.marketOrderAmount = body.marketOrderAmount
  if (market === 'perp') {
    req.direction = body.direction === 'short' ? 'short' : 'long'
    req.leverage = Number.isFinite(num(body.leverage)) ? num(body.leverage) : 1
    req.marginMode = body.marginMode === 'cross' ? 'cross' : 'isolated'
    req.reduceOnly = body.reduceOnly === true
  }
  return req
}

/** Open-order row the parasite reconciler reads. */
function toOpenRow(o: Order) {
  return {
    id: o.id,
    clientOrderId: o.clientOrderId,
    pairName: o.pairName,
    market: o.market,
    qty: o.qty,
    filledQty: o.filledQty,
    remainingQty: Math.max(0, o.qty - o.filledQty),
    rate: o.rate,
    status: o.status,
    orderType: o.side === 'sell' ? ORDER_SIDE.sell : ORDER_SIDE.buy,
    tradeTypeLabel: o.kind,
    orderTypeLabel: o.side,
  }
}

export function buildService(opts: BuildOptions) {
  const { store, keys } = opts
  const uiUserId = opts.uiUserId ?? 'trader-1'
  const instruments = opts.instruments ?? ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']

  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test' && { level: process.env.LOG_LEVEL ?? 'info' },
  })

  // Preserve the RAW body so the HMAC verifies against the exact bytes signed.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    ;(req as unknown as { rawBody: string }).rawBody = body as string
    try {
      done(null, (body as string).length ? JSON.parse(body as string) : {})
    } catch (err) {
      done(err as Error)
    }
  })

  app.addHook('onSend', async (_req, reply) => {
    reply.header('access-control-allow-origin', '*')
    reply.header('access-control-allow-headers', '*')
  })
  app.options('/*', async (_req, reply) => reply.code(204).send())

  // ── signed helper: verify HMAC, resolve userId ──────────────────────────
  function authed(req: FastifyRequest, reply: FastifyReply): string | null {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? ''
    const r = verifySignature(req.headers, raw, keys)
    if (!r.ok) {
      reply.code(r.code).send({ status: false, error: r.error })
      return null
    }
    return r.userId
  }

  // ═══ PARASITE-FACING (signed) ════════════════════════════════════════════
  app.post('/api/v1/trade/orders', async (req, reply) => {
    const userId = authed(req, reply)
    if (!userId) return reply
    const parsed = parsePlace((req.body ?? {}) as Record<string, unknown>)
    if (typeof parsed === 'string') return reply.code(400).send({ status: false, error: parsed })
    try {
      const order = store.place(userId, parsed)
      return {
        status: true,
        data: {
          orderId: order.id,
          qty: order.qty,
          rate: order.rate,
          orderValue: order.qty * order.rate,
        },
      }
    } catch (err) {
      return reply.code(400).send({ status: false, error: String((err as Error).message ?? err) })
    }
  })

  app.post('/api/v1/trade/orders/cancel', async (req, reply) => {
    const userId = authed(req, reply)
    if (!userId) return reply
    const orderId = num((req.body as { orderId?: unknown })?.orderId)
    const o = store.order(orderId)
    if (!o || o.userId !== userId) return { status: false, error: 'unknown order' }
    return { status: store.cancel(orderId) }
  })

  app.post('/api/v1/trade/orders/open', async (req, reply) => {
    const userId = authed(req, reply)
    if (!userId) return reply
    const pairName = (req.body as { pairName?: string })?.pairName
    return { status: true, data: { orders: store.openOrders(userId, pairName).map(toOpenRow) } }
  })

  app.post('/api/v1/trade/balance', async (req, reply) => {
    const userId = authed(req, reply)
    if (!userId) return reply
    return { status: true, data: store.balances(userId) }
  })

  app.post('/api/v1/trade/positions', async (req, reply) => {
    const userId = authed(req, reply)
    if (!userId) return reply
    return { status: true, data: await store.openPositions(userId) }
  })

  // Terminal-aware status-by-id. open-orders only lists ACTIVE+PARTIAL, so when
  // an order drops out the parasite reconciler can't tell filled from cancelled
  // — this read disambiguates (SETTLED vs CANCELED). By orderId or clientOrderId.
  app.post('/api/v1/trade/orders/status', async (req, reply) => {
    const userId = authed(req, reply)
    if (!userId) return reply
    const b = (req.body ?? {}) as { orderId?: unknown; clientOrderId?: unknown }
    const o =
      typeof b.clientOrderId === 'string'
        ? store.orderByClientId(b.clientOrderId)
        : store.order(num(b.orderId))
    if (!o || o.userId !== userId) return { status: false, error: 'unknown order' }
    return {
      status: true,
      data: { orderId: o.id, orderStatus: o.status, filledQty: o.filledQty, qty: o.qty },
    }
  })

  // js_callback: parasite hands off; host UI will approve/reject.
  app.post('/api/v1/trade/handoff', async (req, reply) => {
    const userId = authed(req, reply)
    if (!userId) return reply
    const b = (req.body ?? {}) as Record<string, unknown>
    const parsed = parsePlace(b)
    if (typeof parsed === 'string') return reply.code(400).send({ status: false, error: parsed })
    const clientOrderId = String(b.clientOrderId ?? '')
    if (!clientOrderId)
      return reply.code(400).send({ status: false, error: 'clientOrderId required for handoff' })
    const displayRows = Array.isArray(b.displayRows)
      ? (b.displayRows as Array<{ label: string; value: string }>)
      : []
    const h = store.createHandoff({
      clientOrderId,
      userId,
      place: { ...parsed, clientOrderId },
      displayRows,
    })
    return { status: true, data: { clientOrderId: h.clientOrderId, state: h.state } }
  })

  app.post('/api/v1/trade/handoff/status', async (req, reply) => {
    const userId = authed(req, reply)
    if (!userId) return reply
    const clientOrderId = String((req.body as { clientOrderId?: unknown })?.clientOrderId ?? '')
    const h = store.getHandoff(clientOrderId)
    if (!h || h.userId !== userId) return { status: false, error: 'unknown handoff' }
    return { status: true, data: { state: h.state, venueOrderId: h.venueOrderId } }
  })

  // ═══ HOST-UI-FACING (first-party, unsigned) ══════════════════════════════
  app.get('/v1/capabilities', async () => ({
    venue: 'assetworks',
    instruments,
    // VenueCapabilities shape (@hippo/protocol): presence == enabled.
    capabilities: {
      spot: {},
      futures_perp: { maxLeverage: 50, marginModes: ['isolated', 'cross'] },
    },
  }))

  // Human order ticket — same book as the parasite (uiUserId).
  app.post('/ui/orders', async (req, reply) => {
    const parsed = parsePlace((req.body ?? {}) as Record<string, unknown>)
    if (typeof parsed === 'string') return reply.code(400).send({ error: parsed })
    try {
      const order = store.place(uiUserId, parsed)
      return { ok: true, orderId: order.id }
    } catch (err) {
      return reply.code(400).send({ error: String((err as Error).message ?? err) })
    }
  })
  app.post('/ui/orders/:id/cancel', async (req) => {
    const id = num((req.params as { id: string }).id)
    return { ok: store.cancel(id) }
  })

  // js_callback approvals from the host's own confirm modal.
  app.post('/ui/handoff/:id/approve', async (req, reply) => {
    try {
      const order = store.approveHandoff((req.params as { id: string }).id)
      return { ok: true, orderId: order.id }
    } catch (err) {
      return reply.code(400).send({ error: String((err as Error).message ?? err) })
    }
  })
  app.post('/ui/handoff/:id/reject', async (req) => {
    store.rejectHandoff((req.params as { id: string }).id)
    return { ok: true }
  })

  // Admin drawer — flip the confirm surface and fill behaviour at runtime.
  function adminOk(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!opts.adminToken) return true
    if (req.headers['x-admin-token'] === opts.adminToken) return true
    reply.code(401).send({ error: 'bad admin token' })
    return false
  }
  app.get('/admin/config', async () => store.config)
  app.post('/admin/config', async (req, reply) => {
    if (!adminOk(req, reply)) return reply
    const b = (req.body ?? {}) as Partial<AdminConfig>
    const patch: Partial<AdminConfig> = {}
    if (b.confirmSurface === 'api' || b.confirmSurface === 'js_callback')
      patch.confirmSurface = b.confirmSurface
    if (typeof b.workingWindowMs === 'number') patch.workingWindowMs = b.workingWindowMs
    if (typeof b.feeRate === 'number') patch.feeRate = b.feeRate
    if (typeof b.partialFills === 'boolean') patch.partialFills = b.partialFills
    return store.setConfig(patch)
  })

  // AI-model control — a same-origin proxy to the intelligence service so the
  // host settings page can switch Hippo's model (and see it in chat) without
  // the browser touching the internal AI service directly. Demo/test control;
  // the venue itself has no opinion on Hippo's model.
  const intelligenceUrl = process.env.INTELLIGENCE_URL ?? 'http://localhost:8791'
  app.get('/admin/ai/model', async (_req, reply) => {
    try {
      const res = await fetch(`${intelligenceUrl}/admin/model`, {
        signal: AbortSignal.timeout(3_000),
      })
      return await res.json()
    } catch (err) {
      return reply.code(502).send({ error: `intelligence unreachable: ${String(err)}` })
    }
  })
  app.post('/admin/ai/model', async (req, reply) => {
    if (!adminOk(req, reply)) return reply
    const model = (req.body as { model?: unknown })?.model
    if (typeof model !== 'string' || !model)
      return reply.code(400).send({ error: 'model required' })
    try {
      const res = await fetch(`${intelligenceUrl}/admin/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(3_000),
      })
      return await res.json()
    } catch (err) {
      return reply.code(502).send({ error: `intelligence unreachable: ${String(err)}` })
    }
  })

  // SSE stream powering the live blotter/positions/balances in the host UI.
  app.get('/stream', (req, reply) => {
    const userId = (req.query as { userId?: string })?.userId ?? uiUserId
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    })
    const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    send(store.snapshot(userId))
    const unsub = store.subscribe(send)
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)
    req.raw.on('close', () => {
      clearInterval(keepAlive)
      unsub()
    })
  })

  app.get('/health', async () => ({ ok: true, service: 'host-venue', venue: 'assetworks' }))

  return app
}

export { ORDER_STATUS }
