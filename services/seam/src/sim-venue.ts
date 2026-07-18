/**
 * Simulated venue adapter — the dev/demo implementation of the Canonical
 * Trading Interface. Quotes come from the live market-data service (real
 * prices, honest tickets); the confirm→fill lifecycle is simulated with a
 * timer where a real venue sends webhooks. The hand-built KoinBX adapter
 * (Phase 3 pilot) replaces this class behind the same interface — and later
 * becomes the `hippo init` codegen reference.
 */
import { randomUUID } from 'node:crypto'
import type {
  LifecycleEvent,
  Portfolio,
  PreparedTicket,
  PrepareRequest,
  VenueAdapter,
} from './types.js'

const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? 'http://localhost:8790'

/** Flat dev taker fee. A real adapter reads the venue's fee schedule. */
const FEE_RATE = 0.001

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
  confirmed?: boolean
  fillTimer?: ReturnType<typeof setTimeout>
}

/** Net position per (user, instrument), accumulated from actual fills. */
type PositionAgg = { netSize: number; costBasis: number }

export class SimVenueAdapter implements VenueAdapter {
  private readonly tickets = new Map<string, StoredTicket>()
  /** `${partnerId}:${userId}` → instrument → net position from real fills. */
  private readonly books = new Map<string, Map<string, PositionAgg>>()
  private handler: (event: LifecycleEvent) => void = () => {}

  constructor(private readonly opts: { fillDelayMs?: number; marketDataUrl?: string } = {}) {}

  onEvent(handler: (event: LifecycleEvent) => void): void {
    this.handler = handler
  }

  private async quote(instrument: string): Promise<number> {
    const base = this.opts.marketDataUrl ?? MARKET_DATA_URL
    const res = await fetch(`${base}/v1/snapshot?symbol=${encodeURIComponent(instrument)}`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) throw new Error(`quote unavailable for ${instrument}: ${res.status}`)
    const snap = (await res.json()) as { last: number }
    if (typeof snap.last !== 'number') throw new Error('malformed snapshot')
    return snap.last
  }

  async prepare(req: PrepareRequest): Promise<PreparedTicket> {
    const sizeNum = Number(req.size)
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) throw new Error('invalid order size')

    const isLimit = req.orderType === 'limit'
    const price = isLimit ? Number(req.limitPrice) : await this.quote(req.instrument)
    if (!Number.isFinite(price) || price <= 0) throw new Error('invalid price')

    // Est. cost = size × price × (1 + fee). Display strings are built HERE —
    // the SDK draws what the server sends; it never computes money.
    const estCost = sizeNum * price * (1 + FEE_RATE)
    const baseAsset = req.instrument.split('/')[0] ?? req.instrument
    const ticketId = `t_${randomUUID().replaceAll('-', '').slice(0, 10)}`

    this.tickets.set(ticketId, { req, price, sizeNum })

    return {
      ticketId,
      side: req.side,
      instrument: req.instrument,
      orderType: req.orderType,
      sideLabel: `${req.side.toUpperCase()} · ${isLimit ? 'LMT' : 'MKT'}`,
      rows: [
        { label: 'Instrument', value: req.instrument.replace('/', ' / ') },
        { label: 'Size', value: `${req.size} ${baseAsset}` },
        {
          label: isLimit ? 'Limit price' : 'Est. price',
          value: formatPrice(price),
        },
        { label: 'Est. cost incl. fees', value: `${formatAmount(estCost)} USDT` },
      ],
    }
  }

  private recordFill(req: PrepareRequest, sizeNum: number, price: number): void {
    const bookKey = `${req.partnerId}:${req.userId}`
    const book = this.books.get(bookKey) ?? new Map<string, PositionAgg>()
    const agg = book.get(req.instrument) ?? { netSize: 0, costBasis: 0 }
    const signed = req.side === 'buy' ? sizeNum : -sizeNum
    agg.netSize += signed
    agg.costBasis += signed * price
    if (Math.abs(agg.netSize) < 1e-12) book.delete(req.instrument)
    else book.set(req.instrument, agg)
    this.books.set(bookKey, book)
  }

  async confirm(ticketId: string): Promise<void> {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) throw new Error(`unknown ticket ${ticketId}`)
    ticket.confirmed = true

    // SIMULATION — a real venue confirms with the trader, then its webhooks
    // land here. The fill uses the actuals captured at prepare time.
    ticket.fillTimer = setTimeout(() => {
      const venueOrderId = `SIM-${Math.floor(10_000_000 + Math.random() * 89_999_999)}`
      this.handler({
        ticketId,
        phase: 'filled',
        statusLine: 'FILLED',
        venueOrderId,
        rows: [
          { label: 'Avg fill', value: formatPrice(ticket.price) },
          {
            label: 'Fees (actual)',
            value: `${formatAmount(ticket.sizeNum * ticket.price * FEE_RATE)} USDT`,
          },
          { label: 'Venue order ID', value: venueOrderId },
        ],
      })
      this.recordFill(ticket.req, ticket.sizeNum, ticket.price)
      this.tickets.delete(ticketId)
    }, this.opts.fillDelayMs ?? 3_000)
  }

  async cancel(ticketId: string): Promise<boolean> {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) return false
    if (ticket.fillTimer) clearTimeout(ticket.fillTimer)
    this.tickets.delete(ticketId)
    return true
  }

  async portfolio(partnerId: string, userId: string): Promise<Portfolio> {
    // REAL state only — production semantics. A fresh user is empty; open
    // orders are actual confirmed-but-unfilled tickets; positions accumulate
    // from actual fills and are marked to the LIVE market price. Never a
    // fabricated row. NEVER cached.
    const openOrders = [...this.tickets.entries()]
      .filter(
        ([, t]) => t.confirmed && t.req.partnerId === partnerId && t.req.userId === userId,
      )
      .map(([ticketId, t]) => {
        const base = t.req.instrument.split('/')[0] ?? t.req.instrument
        const summary =
          t.req.orderType === 'limit'
            ? `${t.req.side.toUpperCase()} ${t.req.size} ${base} @ ${formatPrice(t.price)}`
            : `${t.req.side.toUpperCase()} ${t.req.size} ${base} · MKT`
        return { orderId: ticketId, side: t.req.side, summary, status: 'FILLING' }
      })

    const book = this.books.get(`${partnerId}:${userId}`) ?? new Map<string, PositionAgg>()
    const positions = await Promise.all(
      [...book.entries()].map(async ([instrument, agg]) => {
        const base = instrument.split('/')[0] ?? instrument
        const entry = agg.costBasis / agg.netSize
        // Live mark; if the feed is briefly unreachable, degrade honestly to
        // entry-only (no invented P&L) rather than failing the whole read.
        let mark: number | null = null
        try {
          mark = await this.quote(instrument)
        } catch {
          mark = null
        }
        const pnl = mark === null ? null : (mark - entry) * agg.netSize
        return {
          instrument,
          size: `${agg.netSize.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${base}`,
          entry: formatPrice(entry),
          mark: mark === null ? '—' : formatPrice(mark),
          pnl: pnl === null ? '—' : `${pnl >= 0 ? '+' : '−'}${formatAmount(Math.abs(pnl))} USDT`,
          tone: pnl === null ? ('neutral' as const) : pnl >= 0 ? ('pos' as const) : ('neg' as const),
        }
      }),
    )

    return { positions, openOrders }
  }
}
