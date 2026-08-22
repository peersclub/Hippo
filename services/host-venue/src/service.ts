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
import { getPool, type HostVenueStateStore, PostgresHostVenueStateStore } from '@hippo/stores'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { type ApiKeyRecord, verifySignature } from './hmac.js'
import { OPENAPI_DOC } from './openapi.js'
import { SnapshotPersister } from './persistence.js'
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

// Build provenance: stamped by the Docker build (Railway build args); an
// unstamped build reports "unknown", never a guessed value.
const GIT_SHA = process.env.GIT_SHA || 'unknown'
const BUILT_AT = process.env.BUILT_AT || 'unknown'

export type BuildOptions = {
  store: VenueStore
  /** apiKey → { secret, userId }. The parasite's key resolves to the SAME
   *  userId the host UI trades as, so their orders share one book. */
  keys: Map<string, ApiKeyRecord>
  /** Guard on /admin mutations. FAIL-CLOSED: when unset, every /admin/*
   *  request is refused 503 naming the missing env — never served open. */
  adminToken?: string
  /** Browser origins allowed to call /admin/* cross-origin (reflected, never
   *  `*`). Unset = no ACAO header on /admin/* at all; same-origin and proxy
   *  access keep working. Public venue routes stay permissive regardless. */
  adminOrigins?: string[]
  /** The userId the first-party UI trades as (and the demo key maps to). */
  uiUserId?: string
  /** Instruments advertised to the parasite via /v1/capabilities. */
  instruments?: string[]
  /**
   * Durable book of record (host_venue_state, stores migration 014).
   * Defaults to Postgres when DATABASE_URL is set (and not under test);
   * unset with no DATABASE_URL, the venue is memory-only exactly as before —
   * no pg connection is ever opened. Tests inject a shared store to prove
   * the book survives a restart.
   */
  stateStore?: HostVenueStateStore
  /** Row key in host_venue_state — one row per venue instance. */
  venueId?: string
  /** Coalescing window for debounced snapshot saves (ms). */
  persistDebounceMs?: number
  /** Gateway base URL for the forced-degraded proxy (GATEWAY_URL env). */
  gatewayUrl?: string
  /** Token presented to the gateway's /internal/degraded (INTERNAL_API_TOKEN
   * env) — held server-side only; the browser never sees it. */
  gatewayInternalToken?: string
  /** The partnerId the demo embed's sessions run under — the partner the
   * forced-degraded toggle targets (HIPPO_DEMO_PARTNER_ID env). Local dev
   * mints anonymous sessions on the seeded dev partner, hence the default. */
  demoPartnerId?: string
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
  // Protective exits (attached stop-loss / take-profit) — optional numerics on
  // the wire. Presence-validated here; the store validates the SANITY (side of
  // entry, long/short direction) with a human message.
  if (body.stopLossPrice !== undefined) {
    const sl = num(body.stopLossPrice)
    if (!Number.isFinite(sl) || sl <= 0) return 'invalid stopLossPrice'
    req.stopLossPrice = sl
  }
  if (body.takeProfitPrice !== undefined) {
    const tp = num(body.takeProfitPrice)
    if (!Number.isFinite(tp) || tp <= 0) return 'invalid takeProfitPrice'
    req.takeProfitPrice = tp
  }
  if (market === 'perp') {
    req.direction = body.direction === 'short' ? 'short' : 'long'
    req.leverage = Number.isFinite(num(body.leverage)) ? num(body.leverage) : 1
    // An unknown margin mode is a REJECTION, not a silent rewrite to isolated —
    // the trader must never get a different margin regime than they asked for.
    // Omitted = isolated (the venue default); the store then checks the mode
    // against what the venue's config actually supports.
    if (body.marginMode !== undefined && body.marginMode !== 'cross' && body.marginMode !== 'isolated')
      return 'invalid marginMode (want isolated or cross)'
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
    // Additive: protective children carry their entry's id, so the open-orders
    // view (and the parasite's blotter) can label them instead of guessing.
    ...(o.parentId !== undefined ? { parentId: o.parentId } : {}),
  }
}

/** Full-history order row (all statuses) the parasite's listOrders reads. Adds
 *  the creation timestamp + avg fill price the open-orders row never needed. */
function toAllRow(o: Order) {
  return { ...toOpenRow(o), createdAt: o.createdAt, avgFillPrice: o.avgFillPrice }
}

export function buildService(opts: BuildOptions) {
  const { store, keys } = opts
  const uiUserId = opts.uiUserId ?? 'trader-1'
  const instruments = opts.instruments ?? ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']

  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test' && { level: process.env.LOG_LEVEL ?? 'info' },
  })

  // ── durable book of record ────────────────────────────────────────────────
  // Same store-resolution shape as the seam's audit trail: Postgres when
  // DATABASE_URL is set (never under NODE_ENV=test), injected store for
  // tests, and nothing at all otherwise — a venue without a database keeps
  // today's in-memory behaviour byte for byte.
  const usePg = Boolean(process.env.DATABASE_URL) && process.env.NODE_ENV !== 'test'
  const stateStore =
    opts.stateStore ?? (usePg ? new PostgresHostVenueStateStore(getPool()) : undefined)
  if (stateStore) {
    const venueId = opts.venueId ?? 'assetworks'
    const persister = new SnapshotPersister(
      () => stateStore.save(venueId, store.snapshot(), Date.now()),
      (err) => app.log.error({ err }, 'host-venue state save failed'),
      opts.persistDebounceMs ?? 1_000,
    )
    // Boot: restore the persisted book BEFORE serving (app.listen/inject wait
    // on onReady). A failed load is deliberately fatal — serving a blank book
    // would clobber the durable one on the next debounced save.
    app.addHook('onReady', async () => {
      const snap = await stateStore.load(venueId)
      if (snap !== null) {
        store.restore(snap)
        app.log.info({ venueId }, 'host-venue state restored')
      }
    })
    // Every mutation (order/fill/balances/positions/config/handoff — incl.
    // resetWallet and sweep-driven fills) funnels through the store's emit,
    // so one subscription is the single persistence choke point.
    store.subscribe(() => persister.schedule())
    // Graceful shutdown: push any pending snapshot before the process goes.
    app.addHook('onClose', () => persister.flush())
  }

  // Preserve the RAW body so the HMAC verifies against the exact bytes signed.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    ;(req as unknown as { rawBody: string }).rawBody = body as string
    try {
      done(null, (body as string).length ? JSON.parse(body as string) : {})
    } catch (err) {
      done(err as Error)
    }
  })

  // ── CORS, split by audience ───────────────────────────────────────────────
  // Public venue routes (/v1/*, /health, /ui/*, the signed wire) stay
  // permissive — the demo frontends on vercel.app need it. The ADMIN surface
  // must never carry `*`: it reflects an origin only when it is explicitly
  // allowlisted (HOST_VENUE_ADMIN_ORIGINS, comma list). No allowlist = no
  // ACAO header on /admin/* — same-origin and server-side proxy access are
  // unaffected, browsers on foreign origins are refused by CORS.
  const adminOrigins =
    opts.adminOrigins ??
    (process.env.HOST_VENUE_ADMIN_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  // Match on the DECODED path: fastify routes on the decoded URL, so testing
  // the raw req.url would let `/%61dmin/config` reach the handler unguarded.
  const isAdminUrl = (url: string) => {
    let path = url.split('?')[0] ?? url
    try {
      path = decodeURIComponent(path)
    } catch {
      // malformed escapes cannot route anywhere — treat as admin to fail closed
      return true
    }
    return path === '/admin' || path.startsWith('/admin/')
  }
  app.addHook('onSend', async (req, reply) => {
    if (isAdminUrl(req.url)) {
      const origin = req.headers.origin
      if (typeof origin === 'string' && adminOrigins.includes(origin)) {
        reply.header('access-control-allow-origin', origin)
        reply.header('access-control-allow-headers', '*')
        reply.header('vary', 'origin')
      }
      return
    }
    reply.header('access-control-allow-origin', '*')
    reply.header('access-control-allow-headers', '*')
  })
  app.options('/*', async (_req, reply) => reply.code(204).send())

  // ── admin fail-closed gate ───────────────────────────────────────────────
  // With no admin token configured, the ENTIRE /admin surface is refused —
  // loudly, naming the missing env — rather than served open. An unset env in
  // production must never mean "everyone is admin".
  app.addHook('onRequest', async (req, reply) => {
    if (!opts.adminToken && isAdminUrl(req.url))
      return reply.code(503).send({
        error:
          'admin surface disabled: ASSETWORKS_ADMIN_TOKEN is not set — set it to enable /admin/*',
      })
  })

  // Simulated venue latency on the signed trade surface — makes the parasite's
  // "working"/thinking states visible and stresses its request timeouts.
  app.addHook('preHandler', async (req) => {
    const ms = store.config.latencyMs
    if (ms > 0 && req.url.startsWith('/api/v1/trade')) await new Promise((r) => setTimeout(r, ms))
  })

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

  // Full orders blotter (all statuses) — the book of record behind the
  // parasite's consolidated orders_summary. openOrders lists only ACTIVE+
  // PARTIAL; this returns settled and cancelled too, newest first.
  app.post('/api/v1/trade/orders/all', async (req, reply) => {
    const userId = authed(req, reply)
    if (!userId) return reply
    return { status: true, data: { orders: store.allOrders(userId).map(toAllRow) } }
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
  // Capabilities are DERIVED from live admin config, so toggling spot/perp/
  // options or maxLeverage on the settings page reflects in what the parasite
  // discovers (and may place). VenueCapabilities shape: presence == enabled.
  // ── discovery surface (feeds `hippo scan` — the second-venue dogfood) ────
  app.get('/openapi.json', async () => OPENAPI_DOC)
  app.get('/', async (_req, reply) => {
    reply.type('text/html')
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#3b82f6"><title>Assetworks Exchange</title>
<style>body{font:16px/1.6 Inter,system-ui,sans-serif;background:#0b0d12;color:#e9ebf0;max-width:640px;margin:80px auto;padding:0 20px}a{color:#3b82f6}code{background:#171a21;padding:2px 6px;border-radius:4px}</style>
</head><body><h1>Assetworks Exchange</h1>
<p>Demo venue for spot and perpetual futures trading — the integration target the Hippo test-host parasites onto.</p>
<p>API: HMAC-signed trade wire, documented at <a href="/openapi.json">/openapi.json</a>. Capabilities at <a href="/v1/capabilities">/v1/capabilities</a>.</p>
</body></html>`
  })

  app.get('/v1/capabilities', async () => {
    const c = store.config
    const capabilities: Record<string, unknown> = {}
    // protectiveExits: presence == the venue accepts attached stop-loss /
    // take-profit on orders. Always on when the capability itself is on (v1;
    // an admin gate can arrive later without a wire change).
    if (c.capsSpot) capabilities.spot = { protectiveExits: true }
    if (c.capsPerp)
      capabilities.futures_perp = {
        maxLeverage: c.maxLeverage,
        marginModes: c.marginModes,
        protectiveExits: true,
      }
    if (c.capsOptions) capabilities.options = { settlement: 'cash' }
    return {
      venue: 'assetworks',
      instruments: c.instruments.length ? c.instruments : instruments,
      // Per-order base-quantity bounds (0 = unbounded) — enforced at placement,
      // so they must be advertised too: the parasite can size orders honestly
      // instead of discovering the limit as a rejection.
      minOrderSize: c.minOrderSize,
      maxOrderSize: c.maxOrderSize,
      capabilities,
    }
  })

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
  // Manual fill — the host approves a working order (fillMode='manual').
  app.post('/ui/orders/:id/fill', async (req) => {
    const id = num((req.params as { id: string }).id)
    return { ok: await store.manualFill(id) }
  })
  // Reset the demo wallet + clear positions (fresh slate for a demo run).
  app.post('/ui/wallet/reset', async () => {
    store.resetWallet(uiUserId)
    return { ok: true }
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
  // No fail-open branch: an unset token never reaches here (the onRequest
  // gate above already refused the whole /admin surface with a 503).
  function adminOk(req: FastifyRequest, reply: FastifyReply): boolean {
    if (opts.adminToken && req.headers['x-admin-token'] === opts.adminToken) return true
    reply.code(401).send({ error: 'bad admin token' })
    return false
  }
  app.get('/admin/config', async () => store.config)
  app.post('/admin/config', async (req, reply) => {
    if (!adminOk(req, reply)) return reply
    const b = (req.body ?? {}) as Partial<AdminConfig>
    const patch: Partial<AdminConfig> = {}
    const numKeys = [
      'workingWindowMs',
      'feeRate',
      'makerFee',
      'slippagePct',
      'latencyMs',
      'rejectRate',
      'maxLeverage',
      'minOrderSize',
      'maxOrderSize',
    ] as const
    const boolKeys = ['partialFills', 'maintenance', 'capsSpot', 'capsPerp', 'capsOptions'] as const
    if (b.confirmSurface === 'api' || b.confirmSurface === 'js_callback')
      patch.confirmSurface = b.confirmSurface
    if (b.fillMode === 'working' || b.fillMode === 'instant' || b.fillMode === 'manual')
      patch.fillMode = b.fillMode
    for (const k of numKeys)
      if (typeof b[k] === 'number' && Number.isFinite(b[k])) patch[k] = Math.max(0, b[k] as number)
    for (const k of boolKeys) if (typeof b[k] === 'boolean') patch[k] = b[k]
    if (Array.isArray(b.marginModes))
      patch.marginModes = b.marginModes.filter((m) => m === 'isolated' || m === 'cross')
    if (Array.isArray(b.instruments))
      patch.instruments = b.instruments.filter(
        (s) => typeof s === 'string' && /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/.test(s),
      )
    return store.setConfig(patch)
  })

  // AI-model control — a same-origin proxy to the intelligence service so the
  // host settings page can switch Hippo's model (and see it in chat) without
  // the browser touching the internal AI service directly. Demo/test control;
  // the venue itself has no opinion on Hippo's model.
  const intelligenceUrl = process.env.INTELLIGENCE_URL ?? 'http://localhost:8791'
  // Generic same-origin proxy to the intelligence service so the settings page
  // can drive Hippo's engine (model / mock / cache / persona) and see it in
  // chat, without the browser touching the internal AI service directly.
  async function aiProxy(
    reply: FastifyReply,
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ) {
    try {
      const res = await fetch(`${intelligenceUrl}${path}`, {
        method,
        ...(method === 'POST'
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }
          : {}),
        signal: AbortSignal.timeout(3_000),
      })
      return await res.json()
    } catch (err) {
      return reply.code(502).send({ error: `intelligence unreachable: ${String(err)}` })
    }
  }
  // GET → combined AI status; the settings page reads this once.
  app.get('/admin/ai', async (req, reply) => {
    if (!adminOk(req, reply)) return reply
    return aiProxy(reply, '/admin/status', 'GET')
  })
  app.get('/admin/ai/model', async (req, reply) => {
    if (!adminOk(req, reply)) return reply
    return aiProxy(reply, '/admin/model', 'GET')
  })
  app.post('/admin/ai/model', async (req, reply) => {
    if (!adminOk(req, reply)) return reply
    const model = (req.body as { model?: unknown })?.model
    if (typeof model !== 'string' || !model)
      return reply.code(400).send({ error: 'model required' })
    return aiProxy(reply, '/admin/model', 'POST', { model })
  })
  app.post('/admin/ai/mode', async (req, reply) => {
    if (!adminOk(req, reply)) return reply
    return aiProxy(reply, '/admin/mode', 'POST', {
      forceMock: (req.body as { forceMock?: unknown })?.forceMock === true,
    })
  })
  app.post('/admin/ai/cache', async (req, reply) => {
    if (!adminOk(req, reply)) return reply
    return aiProxy(reply, '/admin/cache', 'POST', {
      enabled: (req.body as { enabled?: unknown })?.enabled !== false,
    })
  })
  app.post('/admin/ai/persona', async (req, reply) => {
    if (!adminOk(req, reply)) return reply
    return aiProxy(reply, '/admin/persona', 'POST', {
      level: (req.body as { level?: unknown })?.level ?? null,
    })
  })

  // Forced-degraded control — the "force degraded AI" toggle on the host
  // settings page (SLA demo, PRD gate 5). Same-origin proxy to the gateway's
  // operator-guarded /internal/degraded: the venue presents INTERNAL_API_TOKEN
  // server-side, so the browser never holds an operator credential — exactly
  // the trust shape of the AI proxy above. Scoped to the DEMO partner id; the
  // gateway ignores everything else, so a production partner can never be
  // flipped from here.
  // Fail-closed like the gateway side: with no INTERNAL_API_TOKEN configured
  // the gateway refuses the call and this proxy surfaces that error honestly.
  const gatewayUrl = opts.gatewayUrl ?? process.env.GATEWAY_URL ?? 'http://localhost:8788'
  const gatewayInternalToken = opts.gatewayInternalToken ?? process.env.INTERNAL_API_TOKEN ?? ''
  const demoPartnerId = opts.demoPartnerId ?? process.env.HIPPO_DEMO_PARTNER_ID ?? 'koinbx-dev'
  async function gatewayDegraded(reply: FastifyReply, method: 'GET' | 'POST', forced?: boolean) {
    try {
      const res = await fetch(`${gatewayUrl}/internal/degraded`, {
        method,
        headers: {
          'x-hippo-internal-token': gatewayInternalToken,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST'
          ? { body: JSON.stringify({ partnerId: demoPartnerId, forced }) }
          : {}),
        signal: AbortSignal.timeout(3_000),
      })
      const body = (await res.json()) as { forced?: unknown; error?: unknown }
      if (!res.ok)
        return reply
          .code(502)
          .send({ error: typeof body.error === 'string' ? body.error : `gateway ${res.status}` })
      const forcedNow =
        method === 'GET'
          ? Array.isArray(body.forced) && body.forced.includes(demoPartnerId)
          : body.forced === true
      return { partnerId: demoPartnerId, forced: forcedNow }
    } catch (err) {
      return reply.code(502).send({ error: `gateway unreachable: ${String(err)}` })
    }
  }
  app.get('/admin/gateway/degraded', async (req, reply) => {
    if (!adminOk(req, reply)) return reply
    return gatewayDegraded(reply, 'GET')
  })
  app.post('/admin/gateway/degraded', async (req, reply) => {
    if (!adminOk(req, reply)) return reply
    return gatewayDegraded(reply, 'POST', (req.body as { forced?: unknown })?.forced === true)
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
    send(store.uiSnapshot(userId))
    const unsub = store.subscribe(send)
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)
    req.raw.on('close', () => {
      clearInterval(keepAlive)
      unsub()
    })
  })

  app.get('/health', async () => ({
    ok: true,
    service: 'host-venue',
    venue: 'assetworks',
    sha: GIT_SHA,
    builtAt: BUILT_AT,
  }))

  return app
}

export { ORDER_STATUS }
