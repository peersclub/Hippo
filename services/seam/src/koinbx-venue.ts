/**
 * KoinBX venue adapter — the hand-built Phase 3 pilot implementation of the
 * Canonical Trading Interface, and the reference target for `hippo init`
 * codegen (Build Plan/04, /05).
 *
 * Maps the venue-neutral seam onto KoinBX's private trade API
 * (koinbx/private-api-trade), which is HMAC-signed and per-key pair-scoped:
 *
 *   POST /api/v1/trade/orders         place    (CreateTradeDto)
 *   POST /api/v1/trade/orders/cancel  cancel   ({ orderId })
 *   POST /api/v1/trade/orders/open    reads    (OpenOrdersDto; ACTIVE + PARTIAL only)
 *   POST /api/v1/trade/balance        reads    ({ currencyName? })
 *
 * Auth headers on every request:
 *   x-api-key    <api key>
 *   x-timestamp  ISO 8601 (new Date().toISOString())
 *   x-signature  hex(HMAC-SHA256(bodyJSON + timestamp, secret))
 * The signed bodyJSON must be byte-identical to what is sent, so we stringify
 * exactly once and reuse it for both the signature and the request body.
 *
 * APPROACH A (Open Decision #1, locked): execution happens on partner rails.
 * Calling KoinBX's own order API IS partner-rails execution — Hippo runs no
 * matching engine. What is NOT yet frozen is the confirm SURFACE where the
 * trader approves (Open Decision #6: deep link vs partner JS callback vs
 * hosted modal). This adapter implements `confirm-surface = 'api'` (Hippo
 * places directly with a pair-scoped key) as the testable pilot default;
 * the three human-facing surfaces are declared in ConfirmSurface and left to
 * the pilot-partner integration, which the CLI must eventually support all of.
 *
 * Lifecycle without a webhook yet: KoinBX's open-orders endpoint returns only
 * ACTIVE (10) and PARTIAL (30) orders, so a poll reconciler treats "was
 * open, now absent" as terminal-filled. This is the backstop the BE doc calls
 * for; when the venue webhook and a dedicated order-status read land, they
 * disambiguate filled-vs-cancelled and this poll becomes reconciliation only.
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
  VenueCapabilitiesShape,
} from './types.js'

// KoinBX trade enums (koinbx/private-api-trade common/enums/trade.enum.ts).
const ORDER_TY = { buy: 0, sell: 1 } as const
const TRADE_TY = { limit: 10, market: 20 } as const // Limit / MarketValue (only two supported)
const ORDER_STATUS = {
  ACTIVE: 10,
  SETTLED: 20,
  PARTIAL: 30,
  PARTIAL_CANCELED: 40,
  CANCELED: 50,
} as const

/** Where the trader approves the order. Open Decision #6 — only 'api' is wired. */
export type ConfirmSurface = 'api' | 'deep_link' | 'js_callback' | 'hosted_modal'

export type KoinbxOptions = {
  apiKey: string
  secret: string
  /** Base URL of KoinBX private-api-trade, e.g. https://api.koinbx.com */
  baseUrl: string
  /** Live quote source (shared market-data service), slash-form symbols. */
  marketDataUrl?: string
  confirmSurface?: ConfirmSurface
  /** Poll reconciler cadence + ceiling. */
  pollIntervalMs?: number
  pollTimeoutMs?: number
  /** Injectable clock/fetch for tests; default to the real ones. */
  fetchImpl?: typeof fetch
}

const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? 'http://localhost:8790'
const KOINBX_TIMEOUT_MS = 5_000
/** Poll-tick failures are absorbed (transient by design) but warned about at
 * most this often, so a KoinBX outage that eats a whole poll window leaves
 * log evidence without one line per 2s tick. */
const POLL_WARN_INTERVAL_MS = 30_000

/** Canonical "BTC/USDT" → KoinBX "BTC-USDT" (dash-form, upper). */
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
  venueOrderId?: number
  poll?: ReturnType<typeof setInterval>
}

type CreateOrderResponse = {
  status: boolean
  data?: { orderId: number; qty: number; rate: number; orderValue?: number }
}

type OpenOrder = {
  id: number
  pairName: string
  qty: number
  filledQty: number
  remainingQty: number
  rate: number
  status: string
  orderType: number
  tradeTypeLabel?: string
  orderTypeLabel?: string
}

type OpenOrdersResponse = {
  status: boolean
  data?: { orders: OpenOrder[] }
}

type BalanceResponse = {
  status: boolean
  data?: Array<{ currencyName: string; amount: string | number }>
}

export class KoinbxVenueAdapter implements VenueAdapter {
  private readonly tickets = new Map<string, StoredTicket>()
  private handler: (event: LifecycleEvent) => void = () => {}
  private log: AdapterLog = { info: () => {}, warn: () => {}, error: () => {} }
  private lastPollWarnAt = 0
  private readonly opts: Required<Omit<KoinbxOptions, 'apiKey' | 'secret' | 'baseUrl'>> &
    Pick<KoinbxOptions, 'apiKey' | 'secret' | 'baseUrl'>

  constructor(options: KoinbxOptions) {
    if (!options.apiKey || !options.secret || !options.baseUrl)
      throw new Error('KoinbxVenueAdapter requires apiKey, secret and baseUrl')
    this.opts = {
      marketDataUrl: MARKET_DATA_URL,
      confirmSurface: 'api',
      pollIntervalMs: 2_000,
      pollTimeoutMs: 120_000,
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

  /** The KoinBX pilot binds the spot private-trade API only; futures live on a
   *  separate backend not wired here, so this venue advertises spot alone. The
   *  capability framework then gates any perp/options plan out with a clean
   *  "not supported on this venue" rather than a bad order. */
  async capabilities(): Promise<VenueCapabilitiesShape> {
    return { spot: {} }
  }

  /** Signed POST to the KoinBX private trade API. */
  private async signedPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
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
      signal: AbortSignal.timeout(KOINBX_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`KoinBX ${path} → ${res.status}`)
    return (await res.json()) as T
  }

  private async quote(instrument: string): Promise<number> {
    const res = await this.opts.fetchImpl(
      `${this.opts.marketDataUrl}/v1/snapshot?symbol=${encodeURIComponent(instrument)}`,
      { signal: AbortSignal.timeout(3_000) },
    )
    if (!res.ok) throw new Error(`quote unavailable for ${instrument}: ${res.status}`)
    const snap = (await res.json()) as { last: number }
    if (typeof snap.last !== 'number') throw new Error('malformed snapshot')
    return snap.last
  }

  async prepare(req: PrepareRequest): Promise<PreparedTicket> {
    // PREPARE is quote-only — Approach A places nothing until confirm. Display
    // strings are built here; the SDK renders them verbatim and computes no money.
    const sizeNum = Number(req.size)
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) throw new Error('invalid order size')

    const isLimit = req.orderType === 'limit'
    const price = isLimit ? Number(req.limitPrice) : await this.quote(req.instrument)
    if (!Number.isFinite(price) || price <= 0) throw new Error('invalid price')

    const estCost = sizeNum * price
    const baseAsset = req.instrument.split('/')[0] ?? req.instrument
    const ticketId = `t_${randomUUID().replaceAll('-', '').slice(0, 10)}`

    this.tickets.set(ticketId, {
      req,
      price,
      sizeNum,
      pairName: toPairName(req.instrument),
    })

    return {
      ticketId,
      side: req.side,
      instrument: req.instrument,
      orderType: req.orderType,
      sideLabel: `${req.side.toUpperCase()} · ${isLimit ? 'LMT' : 'MKT'}`,
      rows: [
        { label: 'Instrument', value: req.instrument.replace('/', ' / ') },
        { label: 'Size', value: `${req.size} ${baseAsset}` },
        { label: isLimit ? 'Limit price' : 'Est. price', value: formatPrice(price) },
        {
          label: 'Est. value',
          value: `${formatAmount(estCost)} ${req.instrument.split('/')[1] ?? ''}`.trim(),
        },
      ],
    }
  }

  async confirm(ticketId: string): Promise<void> {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) throw new Error(`unknown ticket ${ticketId}`)

    if (this.opts.confirmSurface !== 'api')
      // The human-facing confirm surfaces (deep link / JS callback / hosted
      // modal) are Open Decision #6, owned by the pilot-partner integration.
      throw new Error(
        `confirm-surface '${this.opts.confirmSurface}' not wired yet (Open Decision #6)`,
      )

    const isLimit = ticket.req.orderType === 'limit'
    const body: Record<string, unknown> = {
      pairName: ticket.pairName,
      orderType: ORDER_TY[ticket.req.side],
      tradeType: isLimit ? TRADE_TY.limit : TRADE_TY.market,
      qty: ticket.sizeNum,
      rate: ticket.price,
    }
    // MarketValue (20) is the only market type KoinBX exposes; it wants a quote
    // amount. Supplying it from size×quote makes the by-base-qty intent resolve
    // to ~size. When MarketQty (30) is enabled this becomes a direct qty map.
    if (!isLimit) body.marketOrderAmount = ticket.sizeNum * ticket.price

    const placed = await this.signedPost<CreateOrderResponse>('/api/v1/trade/orders', body)
    if (!placed.status || !placed.data?.orderId)
      throw new Error('KoinBX rejected the order at placement')

    ticket.venueOrderId = placed.data.orderId
    this.startReconciler(ticketId, ticket)
  }

  /**
   * Poll reconciler (webhook backstop). While the order shows in open-orders it
   * is ACTIVE/PARTIAL; once it drops out we treat it as terminally filled and
   * stop. A cancel clears the poll so no phantom fill is emitted.
   */
  private startReconciler(ticketId: string, ticket: StoredTicket): void {
    const startedAt = Date.now()
    let sawOpen = false

    const tick = async () => {
      try {
        const open = await this.fetchOpenOrders(
          ticket.req.partnerId,
          ticket.req.userId,
          ticket.pairName,
        )
        const mine = open.find((o) => o.id === ticket.venueOrderId)
        if (mine) {
          sawOpen = true
          const phase = mapStatus(mine.status)
          if (phase === 'partial')
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
          // Was open, now gone → terminally filled (webhook will confirm exact).
          this.emitFilled(ticketId, ticket)
          return this.stopReconciler(ticket)
        }
      } catch (err) {
        // Transient poll failure — keep trying until the timeout ceiling,
        // but leave rate-limited log evidence (a venue outage that eats the
        // whole window otherwise ends in an "expired" card with zero trace).
        if (Date.now() - this.lastPollWarnAt >= POLL_WARN_INTERVAL_MS) {
          this.lastPollWarnAt = Date.now()
          this.log.warn(
            { err, ticketId, venueOrderId: ticket.venueOrderId },
            'koinbx poll tick failed — retrying until the ceiling',
          )
        }
      }
      if (Date.now() - startedAt > this.opts.pollTimeoutMs) this.emitUnresolved(ticketId, ticket)
    }

    ticket.poll = setInterval(() => void tick(), this.opts.pollIntervalMs)
    if (typeof ticket.poll.unref === 'function') ticket.poll.unref()
    void tick()
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

  /**
   * Poll ceiling reached without a terminal signal. KoinBX exposes no
   * order-status-by-id and no lifecycle webhook (see the header note), so
   * Hippo genuinely cannot cheaply learn the final state of an order still
   * resting on the book. Rather than hang the lifecycle card forever we emit a
   * terminal `expired` frame that hands the trader back to the venue — the
   * card resolves and the ticket is released. A venue webhook (Open Decisions)
   * removes the need for this fallback.
   */
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
    // Pre-confirm: nothing exists venue-side, local drop is enough.
    if (ticket.venueOrderId === undefined) return true
    try {
      const res = await this.signedPost<{ status?: boolean }>('/api/v1/trade/orders/cancel', {
        orderId: ticket.venueOrderId,
      })
      return res.status !== false
    } catch (err) {
      // false also means "ticket not found" to the caller, so a REAL resting
      // order that failed to cancel venue-side must be loud here.
      this.log.error(
        { err, ticketId, venueOrderId: ticket.venueOrderId },
        'koinbx cancel failed — the order may still be resting on the venue',
      )
      return false
    }
  }

  private async fetchOpenOrders(
    _partnerId: string,
    _userId: string,
    pairName?: string,
  ): Promise<OpenOrder[]> {
    // userId is bound to the API key server-side (ApiKeyGuard), not sent.
    const res = await this.signedPost<OpenOrdersResponse>('/api/v1/trade/orders/open', {
      ...(pairName ? { pairName } : {}),
      limit: 100,
    })
    return res.data?.orders ?? []
  }

  async portfolio(partnerId: string, userId: string): Promise<Portfolio> {
    // Spot venue: "positions" are non-zero wallet balances (no cost basis, so
    // no entry/mark/pnl from this API). Open orders map straight across.
    const [balance, open] = await Promise.all([
      this.signedPost<BalanceResponse>('/api/v1/trade/balance', {}),
      this.fetchOpenOrders(partnerId, userId),
    ])

    const positions = (balance.data ?? [])
      .filter((b) => Number(b.amount) > 0)
      .map((b) => ({
        instrument: b.currencyName,
        size: `${b.amount} ${b.currencyName}`,
        entry: '—',
        mark: '—',
        pnl: '—',
        tone: 'neutral' as const,
      }))

    const openOrders = open.map((o) => ({
      orderId: String(o.id),
      side: (o.orderType === ORDER_TY.sell ? 'sell' : 'buy') as 'buy' | 'sell',
      summary: `${o.orderType === ORDER_TY.sell ? 'SELL' : 'BUY'} ${o.remainingQty} ${o.pairName} @ ${formatPrice(o.rate)}`,
      status: o.status,
    }))

    return { positions, openOrders }
  }
}

/** KoinBX status label/number → canonical LifecyclePhase. */
function mapStatus(status: string): LifecyclePhase {
  const s = String(status).toLowerCase()
  if (s.includes('partial') && !s.includes('cancel')) return 'partial'
  if (s.includes('cancel')) return 'cancelled'
  if (s.includes('settle') || s === String(ORDER_STATUS.SETTLED)) return 'filled'
  return 'awaiting_confirm'
}
