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
  fillTimer?: ReturnType<typeof setTimeout>
}

export class SimVenueAdapter implements VenueAdapter {
  private readonly tickets = new Map<string, StoredTicket>()
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

  async confirm(ticketId: string): Promise<void> {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) throw new Error(`unknown ticket ${ticketId}`)

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

  async portfolio(): Promise<Portfolio> {
    // Demo portfolio (moved here from the gateway's Phase 2 stub). A real
    // adapter maps the venue's positions/orders endpoints. NEVER cached.
    return {
      positions: [
        {
          instrument: 'BTC/USDT',
          size: '0.31 BTC',
          entry: '58,420',
          mark: '61,240',
          pnl: '+874.20 USDT',
          tone: 'pos',
        },
        {
          instrument: 'SOL/USDT',
          size: '42 SOL',
          entry: '171.10',
          mark: '166.40',
          pnl: '−197.40 USDT',
          tone: 'neg',
        },
        {
          instrument: 'ADA/USDT',
          size: '5,000 ADA',
          entry: '0.4980',
          mark: '0.5210',
          pnl: '+115.00 USDT',
          tone: 'pos',
        },
      ],
      openOrders: [
        { orderId: 'o_btc', side: 'buy', summary: 'BUY 0.05 BTC · MKT', status: 'FILLING 40%' },
        { orderId: 'o_sol', side: 'sell', summary: 'SELL 12 SOL @ 168.00', status: 'OPEN' },
        { orderId: 'o_ada', side: 'buy', summary: 'BUY 2,500 ADA @ 0.5210', status: 'OPEN' },
      ],
    }
  }
}
