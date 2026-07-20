/**
 * The venue's book of record: balances (with reserves), resting/settled orders,
 * open perp positions, pending js_callback handoffs, and the fill engine that
 * marries all of it to live prices.
 *
 * Design notes that matter for the parasite integration:
 *  • A market order is NOT filled instantly. It rests ACTIVE for at least
 *    `workingWindowMs` (>= the parasite reconciler's poll interval) so the
 *    reconciler observes it open, then observes it gone == FILLED. Fill-fast
 *    and the lifecycle card would time out to "expired". This is the single
 *    most important behaviour for a faithful test.
 *  • Funds are reserved at placement and consumed/released at fill/cancel, so
 *    an insufficient-balance order is rejected up front (a real use case), and
 *    a resting limit order can't be double-spent.
 *  • Every state change publishes an SSE event, so the host UI reflects an
 *    order the CONVERSATIONAL parasite placed exactly as it reflects one the
 *    human typed into the ticket — the whole point of the exercise.
 */
import { EventEmitter } from 'node:events'
import type {
  AdminConfig,
  Balance,
  Handoff,
  Order,
  PlaceRequest,
  Position,
  StreamEvent,
} from './types.js'
import { ORDER_STATUS } from './types.js'

type Wallet = Map<string, { total: number; reserved: number }>

export type PriceProvider = (pairName: string) => Promise<number>

const HANDOFF_TTL_MS = 90_000
const QUOTE_CCY = 'USDT'

/** "BTC-USDT" → "BTC" / "USDT". */
function split(pairName: string): [string, string] {
  const [base, quote] = pairName.split('-')
  return [base ?? pairName, quote ?? QUOTE_CCY]
}

export class VenueStore {
  private readonly bus = new EventEmitter()
  private nextOrderId = 10_000
  private readonly orders = new Map<number, Order>()
  private readonly positions = new Map<string, Position>() // `${userId}:${pairName}`
  private readonly handoffs = new Map<string, Handoff>()
  private readonly wallets = new Map<string, Wallet>() // userId → wallet
  private sweeping = false

  constructor(
    private readonly getPrice: PriceProvider,
    public config: AdminConfig,
    /** Opening balances handed to every user on first touch. */
    private readonly seed: Balance[] = [
      { currencyName: 'USDT', amount: 100_000 },
      { currencyName: 'BTC', amount: 2 },
      { currencyName: 'ETH', amount: 20 },
    ],
  ) {}

  // ── subscriptions ─────────────────────────────────────────────────────────
  subscribe(fn: (e: StreamEvent) => void): () => void {
    this.bus.on('event', fn)
    return () => this.bus.off('event', fn)
  }
  private emit(e: StreamEvent): void {
    this.bus.emit('event', e)
  }

  // ── wallet helpers ──────────────────────────────────────────────────────
  private wallet(userId: string): Wallet {
    let w = this.wallets.get(userId)
    if (!w) {
      w = new Map()
      for (const b of this.seed) w.set(b.currencyName, { total: b.amount, reserved: 0 })
      this.wallets.set(userId, w)
    }
    return w
  }
  private slot(userId: string, ccy: string) {
    const w = this.wallet(userId)
    let s = w.get(ccy)
    if (!s) {
      s = { total: 0, reserved: 0 }
      w.set(ccy, s)
    }
    return s
  }
  private available(userId: string, ccy: string): number {
    const s = this.slot(userId, ccy)
    return s.total - s.reserved
  }
  balances(userId: string): Balance[] {
    return [...this.wallet(userId).entries()]
      .filter(([, s]) => s.total > 1e-12)
      .map(([currencyName, s]) => ({ currencyName, amount: round(s.total) }))
  }
  private pushBalances(userId: string): void {
    this.emit({ type: 'balances', balances: this.balances(userId) })
  }

  // ── reads the parasite reconciler / portfolio uses ──────────────────────
  openOrders(userId: string, pairName?: string): Order[] {
    // Contract: only ACTIVE + PARTIAL are "open". A settled/cancelled order
    // dropping out of this list is how the reconciler concludes terminal.
    return [...this.orders.values()].filter(
      (o) =>
        o.userId === userId &&
        (o.status === ORDER_STATUS.ACTIVE || o.status === ORDER_STATUS.PARTIAL) &&
        (!pairName || o.pairName === pairName),
    )
  }
  allOrders(userId: string): Order[] {
    return [...this.orders.values()].filter((o) => o.userId === userId).sort((a, b) => b.id - a.id)
  }
  order(id: number): Order | undefined {
    return this.orders.get(id)
  }

  async openPositions(userId: string): Promise<Position[]> {
    const out: Position[] = []
    for (const p of this.positions.values()) {
      if (p.userId !== userId) continue
      out.push({ ...p })
    }
    return out
  }

  // ── placement ────────────────────────────────────────────────────────────
  /** Validate + reserve + open. Throws with a human message on rejection so the
   *  parasite (and the human ticket) get a clean "why". */
  place(userId: string, req: PlaceRequest): Order {
    if (!Number.isFinite(req.qty) || req.qty <= 0) throw new Error('invalid size')
    if (!Number.isFinite(req.rate) || req.rate <= 0) throw new Error('invalid price')
    const [base, quote] = split(req.pairName)

    if (req.market === 'spot') this.reserveSpot(userId, req, base, quote)
    else this.reservePerp(userId, req, quote)

    const now = Date.now()
    const order: Order = {
      id: this.nextOrderId++,
      clientOrderId: req.clientOrderId,
      userId,
      market: req.market,
      pairName: req.pairName,
      side: req.side,
      kind: req.kind,
      qty: req.qty,
      filledQty: 0,
      rate: req.rate,
      status: ORDER_STATUS.ACTIVE,
      direction: req.direction,
      leverage: req.leverage,
      marginMode: req.marginMode,
      reduceOnly: req.reduceOnly,
      createdAt: now,
      settleAfter: now + this.config.workingWindowMs,
    }
    this.orders.set(order.id, order)
    this.emit({ type: 'order', order })
    return order
  }

  private reserveSpot(userId: string, req: PlaceRequest, base: string, quote: string): void {
    if (req.side === 'buy') {
      const need = req.qty * req.rate * (1 + this.config.feeRate)
      if (this.available(userId, quote) < need)
        throw new Error(
          `insufficient ${quote}: need ${round(need)}, have ${round(this.available(userId, quote))}`,
        )
      this.slot(userId, quote).reserved += need
    } else {
      if (this.available(userId, base) < req.qty)
        throw new Error(
          `insufficient ${base}: need ${req.qty}, have ${round(this.available(userId, base))}`,
        )
      this.slot(userId, base).reserved += req.qty
    }
  }

  private reservePerp(userId: string, req: PlaceRequest, quote: string): void {
    if (req.reduceOnly) return // closing frees margin, never needs new margin
    const lev = req.leverage ?? 1
    const notional = req.qty * req.rate
    const margin = notional / lev + notional * this.config.feeRate
    if (this.available(userId, quote) < margin)
      throw new Error(`insufficient margin: need ${round(margin)} ${quote}`)
    this.slot(userId, quote).reserved += margin
  }

  // ── cancel ────────────────────────────────────────────────────────────────
  cancel(id: number): boolean {
    const o = this.orders.get(id)
    if (!o || (o.status !== ORDER_STATUS.ACTIVE && o.status !== ORDER_STATUS.PARTIAL)) return false
    this.releaseReserve(o)
    o.status = o.filledQty > 0 ? ORDER_STATUS.PARTIAL_CANCELED : ORDER_STATUS.CANCELED
    this.emit({ type: 'order', order: o })
    return true
  }

  private releaseReserve(o: Order): void {
    const remaining = o.qty - o.filledQty
    if (remaining <= 0) return
    const [base, quote] = split(o.pairName)
    if (o.market === 'spot') {
      if (o.side === 'buy')
        this.slot(o.userId, quote).reserved -= remaining * o.rate * (1 + this.config.feeRate)
      else this.slot(o.userId, base).reserved -= remaining
    } else if (!o.reduceOnly) {
      const lev = o.leverage ?? 1
      const notional = remaining * o.rate
      this.slot(o.userId, quote).reserved -= notional / lev + notional * this.config.feeRate
      this.clampReserve(o.userId, quote)
    }
  }
  private clampReserve(userId: string, ccy: string): void {
    const s = this.slot(userId, ccy)
    if (s.reserved < 0) s.reserved = 0
  }

  // ── fill engine ───────────────────────────────────────────────────────────
  /** One sweep tick — call on an interval. Fills anything eligible. */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const now = Date.now()
      // Expire stale handoffs first.
      for (const h of this.handoffs.values()) {
        if (h.state === 'pending' && now - h.createdAt > HANDOFF_TTL_MS) {
          h.state = 'expired'
          this.emit({ type: 'handoff', handoff: h })
        }
      }
      const priceCache = new Map<string, number>()
      for (const o of this.orders.values()) {
        if (o.status !== ORDER_STATUS.ACTIVE && o.status !== ORDER_STATUS.PARTIAL) continue
        if (now < o.settleAfter) continue
        let price = priceCache.get(o.pairName)
        if (price === undefined) {
          try {
            price = await this.getPrice(o.pairName)
          } catch {
            continue // no quote this tick — try again next sweep
          }
          priceCache.set(o.pairName, price)
        }
        if (!this.marketable(o, price)) continue
        this.fill(o, o.kind === 'limit' ? o.rate : price)
      }
    } finally {
      this.sweeping = false
    }
  }

  private marketable(o: Order, price: number): boolean {
    if (o.kind === 'market') return true
    // Limit: crosses when the market reaches the trader's price or better.
    return o.side === 'buy' ? price <= o.rate : price >= o.rate
  }

  private fill(o: Order, price: number): void {
    // Optional two-step fill to exercise the parasite's PARTIAL path: fill half
    // on the first eligible tick, the rest on the next.
    const remaining = o.qty - o.filledQty
    const doPartial = this.config.partialFills && o.filledQty === 0 && remaining > 0
    const fillQty = doPartial ? remaining / 2 : remaining
    this.applyFill(o, fillQty, price)

    o.filledQty = round(o.filledQty + fillQty)
    o.avgFillPrice = price
    if (o.filledQty >= o.qty - 1e-9) {
      o.status = ORDER_STATUS.SETTLED
      this.emit({ type: 'fill', order: o })
    } else {
      o.status = ORDER_STATUS.PARTIAL
      // Hold the next slice one more window so the reconciler sees PARTIAL.
      o.settleAfter = Date.now() + this.config.workingWindowMs
      this.emit({ type: 'order', order: o })
    }
  }

  private applyFill(o: Order, qty: number, price: number): void {
    const [base, quote] = split(o.pairName)
    const notional = qty * price
    const fee = notional * this.config.feeRate
    if (o.market === 'spot') {
      if (o.side === 'buy') {
        // Consume the quote reserve at the ORDER rate (what we locked), credit base.
        this.slot(o.userId, quote).reserved -= qty * o.rate * (1 + this.config.feeRate)
        this.slot(o.userId, quote).total -= notional + fee
        this.slot(o.userId, base).total += qty
      } else {
        this.slot(o.userId, base).reserved -= qty
        this.slot(o.userId, base).total -= qty
        this.slot(o.userId, quote).total += notional - fee
      }
      this.clampReserve(o.userId, quote)
      this.clampReserve(o.userId, base)
      this.pushBalances(o.userId)
    } else {
      this.applyPerpFill(o, qty, price, quote)
    }
  }

  private applyPerpFill(o: Order, qty: number, price: number, quote: string): void {
    const key = `${o.userId}:${o.pairName}`
    const existing = this.positions.get(key)
    const dir = o.direction ?? (o.side === 'buy' ? 'long' : 'short')
    const lev = o.leverage ?? 1
    const fee = qty * price * this.config.feeRate
    this.slot(o.userId, quote).total -= fee

    if (o.reduceOnly || (existing && existing.direction !== dir)) {
      // Closing / reducing: realize PnL on the closed size, release margin.
      if (!existing) return
      const closeQty = Math.min(qty, existing.size)
      const pnl =
        existing.direction === 'long'
          ? (price - existing.entry) * closeQty
          : (existing.entry - price) * closeQty
      const releasedMargin = (existing.margin / existing.size) * closeQty
      this.slot(o.userId, quote).reserved -= releasedMargin
      this.slot(o.userId, quote).total += pnl
      existing.size = round(existing.size - closeQty)
      existing.margin = round(existing.margin - releasedMargin)
      if (existing.size <= 1e-9) this.positions.delete(key)
      else this.positions.set(key, existing)
    } else {
      // Opening / adding: reserve already locked at placement; average in.
      const addMargin = (qty * price) / lev
      const prev = existing ?? {
        userId: o.userId,
        pairName: o.pairName,
        direction: dir,
        size: 0,
        entry: 0,
        leverage: lev,
        marginMode: o.marginMode ?? 'isolated',
        margin: 0,
        liquidation: 0,
      }
      const newSize = prev.size + qty
      prev.entry = round((prev.entry * prev.size + price * qty) / newSize)
      prev.size = round(newSize)
      prev.margin = round(prev.margin + addMargin)
      prev.leverage = lev
      prev.direction = dir
      prev.liquidation = liquidation(dir, prev.entry, lev)
      this.positions.set(key, prev)
    }
    this.clampReserve(o.userId, quote)
    this.pushBalances(o.userId)
    void this.openPositions(o.userId).then((positions) =>
      this.emit({ type: 'positions', positions }),
    )
  }

  // ── js_callback handoffs ────────────────────────────────────────────────
  createHandoff(h: Omit<Handoff, 'state' | 'createdAt'>): Handoff {
    const handoff: Handoff = { ...h, state: 'pending', createdAt: Date.now() }
    this.handoffs.set(handoff.clientOrderId, handoff)
    this.emit({ type: 'handoff', handoff })
    return handoff
  }
  getHandoff(clientOrderId: string): Handoff | undefined {
    return this.handoffs.get(clientOrderId)
  }
  /** Trader approved in the host UI → place for real, mark placed. */
  approveHandoff(clientOrderId: string): Order {
    const h = this.handoffs.get(clientOrderId)
    if (h?.state !== 'pending') throw new Error('no pending handoff')
    const order = this.place(h.userId, h.place)
    h.state = 'placed'
    h.venueOrderId = order.id
    this.emit({ type: 'handoff', handoff: h })
    return order
  }
  rejectHandoff(clientOrderId: string): void {
    const h = this.handoffs.get(clientOrderId)
    if (h?.state !== 'pending') return
    h.state = 'rejected'
    this.emit({ type: 'handoff', handoff: h })
  }

  snapshot(userId: string): Extract<StreamEvent, { type: 'snapshot' }> {
    return {
      type: 'snapshot',
      balances: this.balances(userId),
      orders: this.allOrders(userId),
      positions: [...this.positions.values()].filter((p) => p.userId === userId),
      config: this.config,
    }
  }

  setConfig(patch: Partial<AdminConfig>): AdminConfig {
    this.config = { ...this.config, ...patch }
    this.emit({ type: 'config', config: this.config })
    return this.config
  }
}

/** Simplified isolated-margin liquidation price (no maintenance-margin curve —
 *  enough to display and to test the "close before liq" flow). */
function liquidation(dir: 'long' | 'short', entry: number, lev: number): number {
  return dir === 'long' ? round(entry * (1 - 1 / lev)) : round(entry * (1 + 1 / lev))
}

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8
}
