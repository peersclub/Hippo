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

/**
 * Plain-JSON image of the venue's entire book of record — everything a
 * restart must not lose: orders (incl. terminal ones the reconciler still
 * reads), positions, wallets with reserves, pending handoffs, the admin
 * drawer config, and the monotonic order-id counter (without it, two orders
 * minted across restarts would collide on the same id — observed live).
 * Runtime-only bits (the SSE EventEmitter, the sweep-reentrancy flag, the
 * price provider) are deliberately NOT part of the snapshot.
 */
export type VenueSnapshot = {
  /** Snapshot schema version — bump when the shape changes. */
  v: 1
  nextOrderId: number
  orders: Order[]
  positions: Position[]
  handoffs: Handoff[]
  /** userId → currency → slot (the nested wallet Maps, flattened). */
  wallets: Record<string, Record<string, { total: number; reserved: number }>>
  config: AdminConfig
}

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
  /** Look up an order by the parasite-supplied clientOrderId (the seam ticket).
   *  Terminal orders are retained, so this resolves after fill/cancel too —
   *  which is exactly what lets the reconciler tell cancelled from filled. */
  orderByClientId(clientOrderId: string): Order | undefined {
    for (const o of this.orders.values()) if (o.clientOrderId === clientOrderId) return o
    return undefined
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

    // ── chaos & policy gates (test levers) ──
    if (this.config.maintenance)
      throw new Error('venue under maintenance — orders are temporarily rejected')
    const cap = this.config[req.market === 'perp' ? 'capsPerp' : 'capsSpot']
    if (!cap) throw new Error(`${req.market} trading is disabled on this venue`)
    if (this.config.minOrderSize > 0 && req.qty < this.config.minOrderSize)
      throw new Error(`below minimum order size (${this.config.minOrderSize})`)
    if (this.config.maxOrderSize > 0 && req.qty > this.config.maxOrderSize)
      throw new Error(`above maximum order size (${this.config.maxOrderSize})`)
    if (req.market === 'perp' && (req.leverage ?? 1) > this.config.maxLeverage)
      throw new Error(`leverage exceeds venue max (${this.config.maxLeverage}×)`)
    if (this.config.rejectRate > 0 && this.rand() < this.config.rejectRate)
      throw new Error('order rejected by the venue (simulated)')

    this.validateProtectiveExits(req)

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
      stopLossPrice: req.stopLossPrice,
      takeProfitPrice: req.takeProfitPrice,
      createdAt: now,
      settleAfter: now + (this.config.fillMode === 'instant' ? 0 : this.config.workingWindowMs),
    }
    this.orders.set(order.id, order)
    this.emit({ type: 'order', order })
    return order
  }

  /** Sanity-check attached stop-loss / take-profit against the entry price.
   *  Long (perp long / spot buy): stop < entry < tp. Short: tp < entry < stop.
   *  Spot SELL orders reject protective exits outright — after a spot sell the
   *  trader holds quote, so a "protective" child would open exposure, not
   *  close it. Throws a human message (same contract as the policy gates). */
  private validateProtectiveExits(req: PlaceRequest): void {
    const { stopLossPrice: sl, takeProfitPrice: tp } = req
    if (sl === undefined && tp === undefined) return
    if (sl !== undefined && (!Number.isFinite(sl) || sl <= 0))
      throw new Error('invalid stop-loss price')
    if (tp !== undefined && (!Number.isFinite(tp) || tp <= 0))
      throw new Error('invalid take-profit price')
    if (req.reduceOnly)
      throw new Error('protective exits cannot be attached to a closing (reduce-only) order')
    const isLong = req.market === 'perp' ? req.direction !== 'short' : req.side === 'buy'
    if (req.market === 'spot' && req.side === 'sell')
      throw new Error('protective exits are supported on buy orders only for spot')
    if (isLong) {
      if (sl !== undefined && sl >= req.rate)
        throw new Error(`stop-loss (${sl}) must be below the entry price (${req.rate}) for a long`)
      if (tp !== undefined && tp <= req.rate)
        throw new Error(
          `take-profit (${tp}) must be above the entry price (${req.rate}) for a long`,
        )
    } else {
      if (sl !== undefined && sl <= req.rate)
        throw new Error(`stop-loss (${sl}) must be above the entry price (${req.rate}) for a short`)
      if (tp !== undefined && tp >= req.rate)
        throw new Error(
          `take-profit (${tp}) must be below the entry price (${req.rate}) for a short`,
        )
    }
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

  /** Host-approved fill (fillMode='manual'). Fills the order now at its rate
   *  (limit) or the live price with slippage (market). Returns false if the
   *  order isn't fillable. */
  async manualFill(id: number): Promise<boolean> {
    const o = this.orders.get(id)
    if (!o || (o.status !== ORDER_STATUS.ACTIVE && o.status !== ORDER_STATUS.PARTIAL)) return false
    let price = o.rate
    if (o.kind !== 'limit') {
      // market + stop are takers: live price with slippage.
      try {
        price = this.fillPrice(o, await this.getPrice(o.pairName))
      } catch {
        return false
      }
    }
    this.fill(o, price)
    return true
  }

  /** Reset the demo wallet to the seed balances (or a supplied seed) and clear
   *  the user's open perp positions — a clean slate for a fresh demo run. */
  resetWallet(userId: string, seed?: Balance[]): void {
    const w = new Map<string, { total: number; reserved: number }>()
    for (const b of seed ?? this.seed) w.set(b.currencyName, { total: b.amount, reserved: 0 })
    this.wallets.set(userId, w)
    for (const key of [...this.positions.keys()])
      if (key.startsWith(`${userId}:`)) this.positions.delete(key)
    this.pushBalances(userId)
    void this.openPositions(userId).then((positions) => this.emit({ type: 'positions', positions }))
  }

  private releaseReserve(o: Order): void {
    // Protective children never reserved anything (the entry's fill provides
    // the funds/position they act on), so there is nothing to release.
    if (o.parentId !== undefined) return
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
      // Manual fill mode: nothing auto-fills; the host approves each fill from
      // the settings page, holding orders in WORKING for as long as they like.
      if (this.config.fillMode === 'manual') return
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
        this.fill(o, this.fillPrice(o, price))
      }
    } finally {
      this.sweeping = false
    }
  }

  private marketable(o: Order, price: number): boolean {
    if (o.kind === 'market') return true
    // Stop: ARMS on the ADVERSE side — the inverse of the limit rule. A sell
    // stop (protecting a long) triggers when the market falls TO or THROUGH
    // the trigger; a buy stop (protecting a short) when it rises to it.
    if (o.kind === 'stop') return o.side === 'buy' ? price >= o.rate : price <= o.rate
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
      // OCO: a filled protective child retires its sibling — the position
      // must never be double-closed by its own protection.
      if (o.ocoSiblingId !== undefined) this.cancel(o.ocoSiblingId)
      // Entry filled with protective exits attached → spawn the children.
      if (o.stopLossPrice !== undefined || o.takeProfitPrice !== undefined)
        this.spawnProtectiveChildren(o)
    } else {
      o.status = ORDER_STATUS.PARTIAL
      // Hold the next slice one more window so the reconciler sees PARTIAL.
      o.settleAfter = Date.now() + this.config.workingWindowMs
      this.emit({ type: 'order', order: o })
    }
  }

  /** Market orders fill at the live price moved against the taker by the
   *  configured slippage; limit orders fill at their resting rate (the maker).
   *  Stops are TAKERS once triggered — they close at market with slippage. */
  private fillPrice(o: Order, price: number): number {
    if (o.kind === 'limit') return o.rate
    const s = this.config.slippagePct
    if (!s) return price
    return o.side === 'buy' ? price * (1 + s) : price * (1 - s)
  }

  /** Random in [0,1). Isolated so the chaos gates have one seam to reason about. */
  private rand(): number {
    return Math.random()
  }

  private applyFill(o: Order, qty: number, price: number): void {
    const [base, quote] = split(o.pairName)
    const notional = qty * price
    // Resting limit orders are makers; market orders are takers.
    const fee = notional * (o.kind === 'limit' ? this.config.makerFee : this.config.feeRate)
    if (o.market === 'spot') {
      if (o.side === 'buy') {
        // Consume the quote reserve at the ORDER rate (what we locked), credit base.
        this.slot(o.userId, quote).reserved -= qty * o.rate * (1 + this.config.feeRate)
        this.slot(o.userId, quote).total -= notional + fee
        this.slot(o.userId, base).total += qty
      } else {
        // Protective children never reserved the base (avoiding a double
        // reserve across the OCO pair), so only non-children release one.
        if (o.parentId === undefined) this.slot(o.userId, base).reserved -= qty
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
      if (existing.size <= 1e-9) {
        this.positions.delete(key)
        // The position is gone — by a protective child, a manual close, or
        // anything else. Any surviving protective children are now orphans
        // that would OPEN exposure if they ever triggered: cancel them. The
        // order doing the closing is excluded (its fill is still settling).
        this.cancelProtectiveChildren(o.userId, o.pairName, o.id)
      } else this.positions.set(key, existing)
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

  // ── protective exits (attached stop-loss / take-profit, OCO) ────────────
  /**
   * The entry filled and the position/holding exists — create the venue-native
   * protective children:
   *   • TAKE-PROFIT: a resting REDUCE-ONLY LIMIT at the tp price. It rides the
   *     normal sweep (fills as a MAKER when price crosses favourably).
   *   • STOP: kind 'stop' — rests until price crosses ADVERSELY, then closes
   *     at market with taker slippage (see marketable/fillPrice).
   * The pair is OCO-linked; either fill cancels the sibling, and a position
   * closed by any other means cancels both (applyPerpFill). Children never
   * reserve funds — the filled entry provides the position (perp) or the base
   * holding (spot). NOTE (spot): with no reserve, a trader who manually sells
   * the base out from under the children can strand them; the OCO pair itself
   * stays consistent. Perp children are reduce-only, so they can never exceed
   * the live position.
   */
  private spawnProtectiveChildren(entry: Order): void {
    const closeSide: Order['side'] =
      entry.market === 'perp' ? (entry.side === 'buy' ? 'sell' : 'buy') : 'sell'
    const now = Date.now()
    const child = (kind: 'limit' | 'stop', rate: number, tag: 'tp' | 'sl'): Order => ({
      id: this.nextOrderId++,
      clientOrderId: entry.clientOrderId ? `${entry.clientOrderId}:${tag}` : undefined,
      userId: entry.userId,
      market: entry.market,
      pairName: entry.pairName,
      side: closeSide,
      kind,
      qty: entry.qty,
      filledQty: 0,
      rate,
      status: ORDER_STATUS.ACTIVE,
      ...(entry.market === 'perp'
        ? {
            direction: entry.direction,
            leverage: entry.leverage,
            marginMode: entry.marginMode,
            reduceOnly: true,
          }
        : {}),
      parentId: entry.id,
      createdAt: now,
      settleAfter: now, // armed immediately — the price condition gates the fill
    })
    const tp =
      entry.takeProfitPrice !== undefined ? child('limit', entry.takeProfitPrice, 'tp') : undefined
    const sl =
      entry.stopLossPrice !== undefined ? child('stop', entry.stopLossPrice, 'sl') : undefined
    if (tp && sl) {
      tp.ocoSiblingId = sl.id
      sl.ocoSiblingId = tp.id
    }
    for (const o of [tp, sl]) {
      if (!o) continue
      this.orders.set(o.id, o)
      this.emit({ type: 'order', order: o })
    }
  }

  /** Cancel every open protective child on (user, pair) except `excludeId` —
   *  called when the perp position closes by any means. */
  private cancelProtectiveChildren(userId: string, pairName: string, excludeId: number): void {
    for (const o of this.orders.values()) {
      if (o.parentId === undefined || o.id === excludeId) continue
      if (o.userId !== userId || o.pairName !== pairName) continue
      if (o.status !== ORDER_STATUS.ACTIVE && o.status !== ORDER_STATUS.PARTIAL) continue
      this.cancel(o.id)
    }
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

  /** Per-user snapshot event for a freshly connected SSE client (host UI). */
  uiSnapshot(userId: string): Extract<StreamEvent, { type: 'snapshot' }> {
    return {
      type: 'snapshot',
      balances: this.balances(userId),
      orders: this.allOrders(userId),
      positions: [...this.positions.values()].filter((p) => p.userId === userId),
      config: this.config,
    }
  }

  // ── persistence (host_venue_state, stores migration 014) ─────────────────
  /** Whole-book image for the durable state store. Plain JSON only — safe to
   *  `JSON.stringify` and hand to Postgres. */
  snapshot(): VenueSnapshot {
    const wallets: VenueSnapshot['wallets'] = {}
    for (const [userId, w] of this.wallets) {
      const flat: Record<string, { total: number; reserved: number }> = {}
      for (const [ccy, s] of w) flat[ccy] = { total: s.total, reserved: s.reserved }
      wallets[userId] = flat
    }
    return {
      v: 1,
      nextOrderId: this.nextOrderId,
      orders: [...this.orders.values()].map((o) => ({ ...o })),
      positions: [...this.positions.values()].map((p) => ({ ...p })),
      handoffs: [...this.handoffs.values()].map((h) => ({ ...h, place: { ...h.place } })),
      wallets,
      config: { ...this.config },
    }
  }

  /** Rebuild the book from a persisted snapshot (boot path — runs before the
   *  service accepts traffic, so nothing is emitted; SSE clients get a fresh
   *  uiSnapshot on connect anyway). Throws on an unrecognized shape so the
   *  boot wiring can refuse to serve a blank book over a durable one.
   *
   *  Re-arm semantics for in-flight work:
   *   • ACTIVE/PARTIAL **market** orders get a FRESH working window from
   *     restore time. Their old `settleAfter` is almost certainly in the past
   *     after a restart, so without re-arming they'd fill on the very first
   *     sweep — faster than the parasite reconciler's poll, breaking the
   *     observed open→absent lifecycle contract. A fresh window is the
   *     conservative choice: the order never settles EARLIER than promised.
   *   • Resting **limit** orders keep their original `settleAfter` (absolute
   *     epoch ms — still meaningful after a restart) and simply re-enter the
   *     normal sweep price-check path: past-window + marketable fills, not
   *     marketable keeps resting. Exactly how a resting maker order behaves.
   *   • Pending **handoffs** keep their `createdAt`; the sweep's TTL check
   *     expires any that outlived the restart, which is correct — the host's
   *     confirm modal did not survive the restart either. */
  restore(raw: unknown): void {
    const snap = raw as VenueSnapshot
    if (typeof snap !== 'object' || snap === null || snap.v !== 1)
      throw new Error('unrecognized host-venue snapshot (want v=1)')
    this.orders.clear()
    this.positions.clear()
    this.handoffs.clear()
    this.wallets.clear()

    // Config first — the re-arm below reads the PERSISTED workingWindowMs.
    // Merge over boot defaults so a snapshot written before a new admin knob
    // existed still gets that knob's default.
    this.config = { ...this.config, ...snap.config }

    const now = Date.now()
    for (const o of snap.orders ?? []) {
      const order: Order = { ...o }
      if (
        order.kind === 'market' &&
        (order.status === ORDER_STATUS.ACTIVE || order.status === ORDER_STATUS.PARTIAL)
      )
        order.settleAfter = now + this.config.workingWindowMs
      this.orders.set(order.id, order)
    }
    for (const p of snap.positions ?? []) this.positions.set(`${p.userId}:${p.pairName}`, { ...p })
    for (const h of snap.handoffs ?? []) this.handoffs.set(h.clientOrderId, { ...h })
    for (const [userId, flat] of Object.entries(snap.wallets ?? {})) {
      const w: Wallet = new Map()
      for (const [ccy, s] of Object.entries(flat))
        w.set(ccy, { total: s.total, reserved: s.reserved })
      this.wallets.set(userId, w)
    }
    // Never move the counter backwards: take the max of the persisted value,
    // anything visible on the restored book, and the boot default.
    let maxId = 0
    for (const id of this.orders.keys()) if (id > maxId) maxId = id
    this.nextOrderId = Math.max(snap.nextOrderId ?? 0, maxId + 1, this.nextOrderId)
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
