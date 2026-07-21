/**
 * Assetworks Exchange venue adapter — the reference implementation of the
 * Canonical Trading Interface against a real HTTP venue we fully control (the
 * host-venue service). It talks a standard HMAC-signed private trade API with a
 * poll reconciler as the webhook backstop, so the parasite integration is
 * exercised end to end (signing, reconcile, confirm surfaces) not simulated.
 *
 * Two capabilities worth calling out:
 *   1. BOTH confirm surfaces (Open Decision #6). The active surface is read
 *      from the host's /admin/config at confirm time, so the host's admin
 *      switch is authoritative — flip it in the UI and the next order takes
 *      the other path with no redeploy.
 *        • 'api'         → place directly with the scoped key.
 *        • 'js_callback' → hand off; the HOST renders a native confirm modal;
 *          on approval the host places; we poll the handoff to learn the venue
 *          order id, then reconcile normally.
 *   2. Reconcile-by-clientOrderId. Because the js_callback path means the host
 *      (not us) creates the order, we tag every order with the seam ticketId as
 *      clientOrderId and match on it — we don't need to have placed it ourselves.
 */
import { createHmac, randomUUID } from 'node:crypto'
import type {
  AdapterLog,
  FuturesPerpPlan,
  LifecycleEvent,
  LifecyclePhase,
  OrderPlan,
  Portfolio,
  PreparedTicket,
  PrepareRequest,
  VenueAdapter,
  VenueCapabilitiesShape,
} from './types.js'

const ORDER_TY = { buy: 0, sell: 1 } as const
const TRADE_TY = { limit: 10, market: 20 } as const
const ORDER_STATUS = {
  ACTIVE: 10,
  SETTLED: 20,
  PARTIAL: 30,
  PARTIAL_CANCELED: 40,
  CANCELED: 50,
} as const

export type ConfirmSurface = 'api' | 'js_callback'

export type AssetworksOptions = {
  apiKey: string
  secret: string
  /** Base URL of the Assetworks host trade API, e.g. http://localhost:8796 */
  baseUrl: string
  marketDataUrl?: string
  pollIntervalMs?: number
  pollTimeoutMs?: number
  /** Fallback surface if the host admin config can't be read. */
  confirmSurface?: ConfirmSurface
  fetchImpl?: typeof fetch
}

const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? 'http://localhost:8790'
const HOST_TIMEOUT_MS = 5_000
const POLL_WARN_INTERVAL_MS = 30_000

const toPairName = (instrument: string): string => instrument.replace('/', '-').toUpperCase()
const formatPrice = (n: number): string =>
  n >= 1000
    ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : n.toLocaleString('en-US', { maximumFractionDigits: 4 })
const formatAmount = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

type StoredTicket = {
  req: PrepareRequest
  price: number
  sizeNum: number
  pairName: string
  rows: Array<{ label: string; value: string }>
  venueOrderId?: number
  poll?: ReturnType<typeof setInterval>
  /** Present for futures_perp tickets — sent to the host on confirm so the
   *  order is placed as a perp (market:'perp' + direction/leverage/margin). */
  perp?: {
    direction: 'long' | 'short'
    leverage: number
    marginMode: 'isolated' | 'cross'
    reduceOnly: boolean
  }
}

type HostEnvelope<T> = { status: boolean; data?: T; error?: string }
type CreateOrderData = { orderId: number; qty: number; rate: number; orderValue?: number }
type OpenOrderRow = {
  id: number
  clientOrderId?: string
  pairName: string
  qty: number
  filledQty: number
  remainingQty: number
  rate: number
  status: number
  orderType: number
}
type BalanceRow = { currencyName: string; amount: string | number }
type PositionRow = {
  pairName: string
  direction: 'long' | 'short'
  size: number
  entry: number
  leverage: number
  liquidation: number
}

export class AssetworksVenueAdapter implements VenueAdapter {
  private readonly tickets = new Map<string, StoredTicket>()
  private handler: (event: LifecycleEvent) => void = () => {}
  private log: AdapterLog = { info: () => {}, warn: () => {}, error: () => {} }
  private lastPollWarnAt = 0
  private readonly opts: Required<Omit<AssetworksOptions, 'apiKey' | 'secret' | 'baseUrl'>> &
    Pick<AssetworksOptions, 'apiKey' | 'secret' | 'baseUrl'>

  constructor(options: AssetworksOptions) {
    if (!options.apiKey || !options.secret || !options.baseUrl)
      throw new Error('AssetworksVenueAdapter requires apiKey, secret and baseUrl')
    this.opts = {
      marketDataUrl: MARKET_DATA_URL,
      pollIntervalMs: 2_000,
      pollTimeoutMs: 120_000,
      confirmSurface: 'api',
      fetchImpl: fetch,
      ...options,
    }
  }

  onEvent(handler: (event: LifecycleEvent) => void): void {
    this.handler = handler
  }
  setLogger(log: AdapterLog): void {
    this.log = log
  }

  private async signedPost<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<HostEnvelope<T>> {
    const bodyJson = JSON.stringify(body)
    const timestamp = new Date().toISOString()
    const signature = createHmac('sha256', this.opts.secret)
      .update(bodyJson + timestamp)
      .digest('hex')
    const res = await this.opts.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'x-timestamp': timestamp,
        'x-signature': signature,
      },
      body: bodyJson,
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    })
    if (!res.ok && res.status !== 400) throw new Error(`assetworks ${path} → ${res.status}`)
    return (await res.json()) as HostEnvelope<T>
  }

  private async quote(instrument: string): Promise<number> {
    const res = await this.opts.fetchImpl(
      `${this.opts.marketDataUrl}/v1/snapshot?symbol=${encodeURIComponent(instrument)}`,
      {
        signal: AbortSignal.timeout(3_000),
      },
    )
    if (!res.ok) throw new Error(`quote unavailable for ${instrument}: ${res.status}`)
    const snap = (await res.json()) as { last: number }
    if (typeof snap.last !== 'number') throw new Error('malformed snapshot')
    return snap.last
  }

  /** Read the host's live confirm surface (admin switch is authoritative). */
  private async resolveConfirmSurface(): Promise<ConfirmSurface> {
    try {
      const res = await this.opts.fetchImpl(`${this.opts.baseUrl}/admin/config`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (res.ok) {
        const cfg = (await res.json()) as { confirmSurface?: ConfirmSurface }
        if (cfg.confirmSurface === 'api' || cfg.confirmSurface === 'js_callback')
          return cfg.confirmSurface
      }
    } catch {
      /* fall through to the configured default */
    }
    return this.opts.confirmSurface
  }

  async prepare(req: PrepareRequest): Promise<PreparedTicket> {
    const sizeNum = Number(req.size)
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) throw new Error('invalid order size')
    const isLimit = req.orderType === 'limit'
    const price = isLimit ? Number(req.limitPrice) : await this.quote(req.instrument)
    if (!Number.isFinite(price) || price <= 0) throw new Error('invalid price')

    const estCost = sizeNum * price
    const baseAsset = req.instrument.split('/')[0] ?? req.instrument
    const ticketId = `t_${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const rows = [
      { label: 'Instrument', value: req.instrument.replace('/', ' / ') },
      { label: 'Size', value: `${req.size} ${baseAsset}` },
      { label: isLimit ? 'Limit price' : 'Est. price', value: formatPrice(price) },
      {
        label: 'Est. value',
        value: `${formatAmount(estCost)} ${req.instrument.split('/')[1] ?? ''}`.trim(),
      },
    ]
    this.tickets.set(ticketId, { req, price, sizeNum, pairName: toPairName(req.instrument), rows })
    return {
      ticketId,
      side: req.side,
      instrument: req.instrument,
      orderType: req.orderType,
      sideLabel: `${req.side.toUpperCase()} · ${isLimit ? 'LMT' : 'MKT'}`,
      rows,
    }
  }

  /** Discover what the host supports (spot + perps), read live from the host's
   *  own /v1/capabilities. Falls back to the known Assetworks set if offline. */
  async capabilities(): Promise<VenueCapabilitiesShape> {
    try {
      const res = await this.opts.fetchImpl(`${this.opts.baseUrl}/v1/capabilities`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (res.ok) {
        const body = (await res.json()) as { capabilities?: VenueCapabilitiesShape }
        if (body.capabilities) return body.capabilities
      }
    } catch {
      /* fall through */
    }
    return { spot: {}, futures_perp: { maxLeverage: 50, marginModes: ['isolated', 'cross'] } }
  }

  /** Capability-tagged prepare. Spot reuses prepare(); futures_perp builds a
   *  perp ticket that confirm() places on the host as a perp order. Options are
   *  not offered by this venue. */
  async prepareOrder(plan: OrderPlan): Promise<PreparedTicket> {
    if (plan.capability === 'spot') {
      const ticket = await this.prepare(plan)
      return { ...ticket, capability: 'spot' }
    }
    if (plan.capability === 'futures_perp') return this.prepareFutures(plan)
    throw new Error('options are not supported on this venue')
  }

  private async prepareFutures(plan: FuturesPerpPlan): Promise<PreparedTicket> {
    const sizeNum = Number(plan.size)
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) throw new Error('invalid order size')
    if (!Number.isFinite(plan.leverage) || plan.leverage < 1 || plan.leverage > 50)
      throw new Error('invalid leverage (venue max 50×)')
    const isLimit = plan.orderType === 'limit'
    const entry = isLimit ? Number(plan.limitPrice) : await this.quote(plan.instrument)
    if (!Number.isFinite(entry) || entry <= 0) throw new Error('invalid price')

    const liquidation =
      plan.direction === 'long' ? entry * (1 - 1 / plan.leverage) : entry * (1 + 1 / plan.leverage)
    const margin = (sizeNum * entry) / plan.leverage
    const baseAsset = plan.instrument.split('/')[0] ?? plan.instrument
    const quoteAsset = plan.instrument.split('/')[1] ?? 'USDT'
    // Open long / close short = buy; open short / close long = sell.
    const side = (plan.action === 'open') === (plan.direction === 'long') ? 'buy' : 'sell'
    const ticketId = `t_${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const rows = [
      { label: 'Instrument', value: `${plan.instrument.replace('/', ' / ')} PERP` },
      { label: 'Direction', value: plan.direction.toUpperCase() },
      { label: 'Leverage', value: `${plan.leverage}×` },
      { label: 'Margin mode', value: plan.marginMode === 'cross' ? 'Cross' : 'Isolated' },
      { label: 'Size', value: `${plan.size} ${baseAsset}` },
      { label: isLimit ? 'Limit entry' : 'Est. entry', value: formatPrice(entry) },
      { label: 'Est. liquidation price', value: formatPrice(liquidation) },
      { label: 'Est. margin', value: `${formatAmount(margin)} ${quoteAsset}` },
    ]
    this.tickets.set(ticketId, {
      req: {
        partnerId: plan.partnerId,
        userId: plan.userId,
        side,
        size: plan.size,
        instrument: plan.instrument,
        orderType: plan.orderType,
        ...(plan.limitPrice ? { limitPrice: plan.limitPrice } : {}),
      },
      price: entry,
      sizeNum,
      pairName: toPairName(plan.instrument),
      rows,
      perp: {
        direction: plan.direction,
        leverage: plan.leverage,
        marginMode: plan.marginMode,
        reduceOnly: plan.reduceOnly,
      },
    })
    return {
      ticketId,
      side,
      instrument: plan.instrument,
      orderType: plan.orderType,
      capability: 'futures_perp',
      sideLabel: `${plan.action.toUpperCase()} ${plan.direction.toUpperCase()} ${plan.leverage}× · ${isLimit ? 'LMT' : 'MKT'}`,
      rows,
    }
  }

  async confirm(ticketId: string): Promise<void> {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) throw new Error(`unknown ticket ${ticketId}`)
    const surface = await this.resolveConfirmSurface()
    const isLimit = ticket.req.orderType === 'limit'
    const orderBody: Record<string, unknown> = {
      clientOrderId: ticketId,
      pairName: ticket.pairName,
      orderType: ORDER_TY[ticket.req.side],
      tradeType: isLimit ? TRADE_TY.limit : TRADE_TY.market,
      qty: ticket.sizeNum,
      rate: ticket.price,
    }
    if (ticket.perp) {
      orderBody.market = 'perp'
      orderBody.direction = ticket.perp.direction
      orderBody.leverage = ticket.perp.leverage
      orderBody.marginMode = ticket.perp.marginMode
      orderBody.reduceOnly = ticket.perp.reduceOnly
    }

    if (surface === 'js_callback') {
      // Hand off — the HOST asks the trader to confirm and places on approval.
      const handoff = await this.signedPost('/api/v1/trade/handoff', {
        ...orderBody,
        displayRows: ticket.rows,
      })
      if (!handoff.status) throw new Error(handoff.error ?? 'assetworks rejected the handoff')
      this.startHandoffWatcher(ticketId, ticket)
      return
    }

    // 'api' — place directly with the scoped key (Assetworks-style).
    const placed = await this.signedPost<CreateOrderData>('/api/v1/trade/orders', orderBody)
    if (!placed.status || !placed.data?.orderId)
      throw new Error(placed.error ?? 'assetworks rejected the order at placement')
    ticket.venueOrderId = placed.data.orderId
    this.startReconciler(ticketId, ticket)
  }

  /** js_callback: watch the handoff until the host places, rejects, or it expires. */
  private startHandoffWatcher(ticketId: string, ticket: StoredTicket): void {
    const startedAt = Date.now()
    const tick = async () => {
      try {
        const st = await this.signedPost<{ state: string; venueOrderId?: number }>(
          '/api/v1/trade/handoff/status',
          { clientOrderId: ticketId },
        )
        const state = st.data?.state
        if (state === 'placed') {
          ticket.venueOrderId = st.data?.venueOrderId
          this.stopReconciler(ticket)
          this.startReconciler(ticketId, ticket) // now reconcile the real order
          return
        }
        if (state === 'rejected') {
          this.stopReconciler(ticket)
          this.handler({ ticketId, phase: 'cancelled', statusLine: 'DECLINED ON THE VENUE' })
          this.tickets.delete(ticketId)
          return
        }
        if (state === 'expired') {
          this.stopReconciler(ticket)
          this.handler({
            ticketId,
            phase: 'expired',
            statusLine: 'CONFIRMATION TIMED OUT — CHECK THE VENUE',
          })
          this.tickets.delete(ticketId)
          return
        }
      } catch (err) {
        this.warnThrottled(err, ticketId, ticket.venueOrderId, 'handoff status poll failed')
      }
      if (Date.now() - startedAt > this.opts.pollTimeoutMs) {
        this.stopReconciler(ticket)
        this.handler({
          ticketId,
          phase: 'expired',
          statusLine: 'CONFIRMATION TIMED OUT — CHECK THE VENUE',
        })
        this.tickets.delete(ticketId)
      }
    }
    ticket.poll = setInterval(() => void tick(), this.opts.pollIntervalMs)
    if (typeof ticket.poll.unref === 'function') ticket.poll.unref()
    void tick()
  }

  /** Poll reconciler (webhook backstop) — identical contract to the Assetworks one:
   *  while the order shows in open-orders it is working; once it drops out we
   *  treat it as terminally filled. We match by clientOrderId first so the
   *  js_callback path (host placed it) reconciles the same way. */
  private startReconciler(ticketId: string, ticket: StoredTicket): void {
    const startedAt = Date.now()
    let sawOpen = false
    const tick = async () => {
      try {
        const open = await this.fetchOpenOrders(ticket.pairName)
        const mine = open.find(
          (o) => (o.clientOrderId && o.clientOrderId === ticketId) || o.id === ticket.venueOrderId,
        )
        if (mine) {
          sawOpen = true
          ticket.venueOrderId = mine.id
          if (mapStatus(mine.status) === 'partial')
            this.handler({
              ticketId,
              phase: 'partial',
              statusLine: 'PARTIALLY FILLED',
              venueOrderId: String(mine.id),
              fillPct: mine.qty > 0 ? Math.round((mine.filledQty / mine.qty) * 100) : undefined,
              rows: [
                { label: 'Filled', value: `${mine.filledQty} / ${mine.qty}` },
                { label: 'Rate', value: formatPrice(mine.rate) },
              ],
            })
        } else if (sawOpen) {
          this.emitFilled(ticketId, ticket)
          return this.stopReconciler(ticket)
        }
      } catch (err) {
        this.warnThrottled(
          err,
          ticketId,
          ticket.venueOrderId,
          'assetworks poll tick failed — retrying until the ceiling',
        )
      }
      if (Date.now() - startedAt > this.opts.pollTimeoutMs) this.emitUnresolved(ticketId, ticket)
    }
    ticket.poll = setInterval(() => void tick(), this.opts.pollIntervalMs)
    if (typeof ticket.poll.unref === 'function') ticket.poll.unref()
    void tick()
  }

  private warnThrottled(
    err: unknown,
    ticketId: string,
    venueOrderId: number | undefined,
    msg: string,
  ): void {
    if (Date.now() - this.lastPollWarnAt >= POLL_WARN_INTERVAL_MS) {
      this.lastPollWarnAt = Date.now()
      this.log.warn({ err, ticketId, venueOrderId }, msg)
    }
  }

  private emitFilled(ticketId: string, ticket: StoredTicket): void {
    this.handler({
      ticketId,
      phase: 'filled',
      statusLine: 'FILLED',
      venueOrderId: ticket.venueOrderId ? String(ticket.venueOrderId) : undefined,
      rows: [
        { label: 'Avg fill', value: formatPrice(ticket.price) },
        { label: 'Venue order ID', value: String(ticket.venueOrderId ?? '') },
      ],
    })
    this.tickets.delete(ticketId)
  }

  private emitUnresolved(ticketId: string, ticket: StoredTicket): void {
    this.stopReconciler(ticket)
    if (!this.tickets.has(ticketId)) return
    this.log.warn(
      { ticketId, venueOrderId: ticket.venueOrderId },
      'poll ceiling reached without a terminal state — emitting expired',
    )
    this.handler({
      ticketId,
      phase: 'expired',
      statusLine: 'STILL WORKING ON THE VENUE — CHECK THERE FOR THE FINAL STATUS',
      venueOrderId: ticket.venueOrderId ? String(ticket.venueOrderId) : undefined,
    })
    this.tickets.delete(ticketId)
  }

  private stopReconciler(ticket: StoredTicket): void {
    if (ticket.poll) clearInterval(ticket.poll)
    ticket.poll = undefined
  }

  async cancel(ticketId: string): Promise<boolean> {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) return false
    this.stopReconciler(ticket)
    this.tickets.delete(ticketId)
    if (ticket.venueOrderId === undefined) return true // nothing placed venue-side yet
    try {
      const res = await this.signedPost<unknown>('/api/v1/trade/orders/cancel', {
        orderId: ticket.venueOrderId,
      })
      return res.status !== false
    } catch (err) {
      this.log.error(
        { err, ticketId, venueOrderId: ticket.venueOrderId },
        'assetworks cancel failed — the order may still be resting on the venue',
      )
      return false
    }
  }

  private async fetchOpenOrders(pairName?: string): Promise<OpenOrderRow[]> {
    const res = await this.signedPost<{ orders: OpenOrderRow[] }>('/api/v1/trade/orders/open', {
      ...(pairName ? { pairName } : {}),
      limit: 100,
    })
    return res.data?.orders ?? []
  }

  async portfolio(_partnerId: string, _userId: string): Promise<Portfolio> {
    // Merge spot balances + open perp positions + open orders — so a perp
    // opened in the host UI is visible when the parasite reads the portfolio.
    const [balance, positions, open] = await Promise.all([
      this.signedPost<BalanceRow[]>('/api/v1/trade/balance', {}),
      this.signedPost<PositionRow[]>('/api/v1/trade/positions', {}),
      this.fetchOpenOrders(),
    ])

    const spot = (balance.data ?? [])
      .filter((b) => Number(b.amount) > 0)
      .map((b) => ({
        instrument: b.currencyName,
        size: `${b.amount} ${b.currencyName}`,
        entry: '—',
        mark: '—',
        pnl: '—',
        tone: 'neutral' as const,
      }))

    const perps = (positions.data ?? []).map((p) => ({
      instrument: `${p.pairName} ${p.leverage}x ${p.direction.toUpperCase()}`,
      size: `${p.size}`,
      entry: formatPrice(p.entry),
      mark: '—',
      pnl: '—',
      tone: 'neutral' as const,
    }))

    const openOrders = open.map((o) => ({
      orderId: String(o.id),
      side: (o.orderType === ORDER_TY.sell ? 'sell' : 'buy') as 'buy' | 'sell',
      summary: `${o.orderType === ORDER_TY.sell ? 'SELL' : 'BUY'} ${o.remainingQty} ${o.pairName} @ ${formatPrice(o.rate)}`,
      status: String(o.status),
    }))

    return { positions: [...perps, ...spot], openOrders }
  }
}

function mapStatus(status: number | string): LifecyclePhase {
  const n = Number(status)
  if (n === ORDER_STATUS.PARTIAL) return 'partial'
  if (n === ORDER_STATUS.CANCELED || n === ORDER_STATUS.PARTIAL_CANCELED) return 'cancelled'
  if (n === ORDER_STATUS.SETTLED) return 'filled'
  return 'awaiting_confirm'
}
