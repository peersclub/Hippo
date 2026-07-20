/**
 * Assetworks Exchange venue adapter — the test-host counterpart to
 * koinbx-venue.ts. It is intentionally the SAME shape as the KoinBX pilot
 * adapter (HMAC-signed private trade API, poll reconciler as the webhook
 * backstop), which is the point: a parasite adapter for one venue is a small
 * diff from another, and the Assetworks host lets us exercise the whole
 * Canonical Trading Interface against a venue we fully control.
 *
 * Two things it adds over the KoinBX adapter, both requested for the test host:
 *   1. BOTH confirm surfaces (Open Decision #6). The active surface is read
 *      from the host's /admin/config at confirm time, so the host's admin
 *      switch is authoritative — flip it in the UI and the next order takes
 *      the other path with no redeploy.
 *        • 'api'         → place directly with the scoped key (as KoinBX does).
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
  LifecycleEvent,
  LifecyclePhase,
  Portfolio,
  PreparedTicket,
  PrepareRequest,
  VenueAdapter,
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

    // 'api' — place directly with the scoped key (KoinBX-style).
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

  /** Poll reconciler (webhook backstop) — identical contract to the KoinBX one:
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
