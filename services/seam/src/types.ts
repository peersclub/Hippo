/**
 * Canonical Trading Interface (Build Plan/04) — the venue-neutral surface
 * every per-venue adapter implements. The governing sentence: if a trader
 * has to leave the conversation to find out what happened to their order,
 * the seam has failed.
 *
 * Approach A end to end: Hippo PREPARES (quote + ticket), the venue asks the
 * trader to CONFIRM, venue events flow back as lifecycle updates. Nothing
 * executes on Hippo's side, ever.
 */

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit'

/**
 * Capability tags MIRROR @hippo/protocol orders.ts (CanonicalOrder). The seam
 * keeps its own copies on purpose — the same deliberate decoupling the
 * conformance suite uses — so a protocol change is a conscious two-sided edit,
 * not a silent drift. If you touch these, diff against
 * packages/protocol/src/orders.ts.
 */
export type Capability = 'spot' | 'futures_perp' | 'options'

export type PrepareRequest = {
  partnerId: string
  userId: string
  side: OrderSide
  /** Explicit quantity as a string — the seam never guesses size. */
  size: string
  /** Normalized instrument, e.g. "BTC/USDT". */
  instrument: string
  orderType: OrderType
  limitPrice?: string
}

/**
 * Capability-tagged order plans — the seam-side mirror of the protocol's
 * CanonicalOrder members (packages/protocol/src/orders.ts), each carrying the
 * partner/user routing fields every seam call needs. `SpotPlan` is exactly the
 * legacy PrepareRequest shape plus its capability tag.
 */
export type SpotPlan = {
  capability: 'spot'
  partnerId: string
  userId: string
  side: OrderSide
  size: string
  instrument: string
  orderType: OrderType
  limitPrice?: string
}

export type FuturesPerpPlan = {
  capability: 'futures_perp'
  partnerId: string
  userId: string
  /** Normalized instrument, e.g. "BTC/USDT" (perp). */
  instrument: string
  direction: 'long' | 'short'
  action: 'open' | 'close'
  /** Multiplier, e.g. 13 (13×); the capability module validates ≤ venue max. */
  leverage: number
  marginMode: 'isolated' | 'cross'
  size: string
  reduceOnly: boolean
  orderType: OrderType
  limitPrice?: string
}

export type OptionsPlan = {
  capability: 'options'
  partnerId: string
  userId: string
  underlying: string
  optionType: 'call' | 'put'
  side: OrderSide
  strike: string
  /** ISO date, e.g. "2026-08-29". */
  expiry: string
  size: string
  orderType: OrderType
  limitPrice?: string
}

export type OrderPlan = SpotPlan | FuturesPerpPlan | OptionsPlan

/**
 * Per-venue capability params — mirrors @hippo/protocol VenueCapabilities.
 * A capability is ENABLED for a venue iff its params object is present.
 */
export type SpotParamsShape = Record<string, never>
export type FuturesPerpParamsShape = {
  maxLeverage: number
  marginModes: Array<'isolated' | 'cross'>
}
export type OptionsParamsShape = { settlement?: 'cash' | 'physical' }
export type VenueCapabilitiesShape = {
  spot?: SpotParamsShape
  futures_perp?: FuturesPerpParamsShape
  options?: OptionsParamsShape
}

export type PreparedTicket = {
  ticketId: string
  side: OrderSide
  instrument: string
  orderType: OrderType
  /** Which capability the ticket was prepared under. Additive; legacy spot
   *  tickets omit it. */
  capability?: Capability
  /** Display rows the SDK renders verbatim — the SDK never computes money. */
  rows: Array<{ label: string; value: string }>
  sideLabel: string // e.g. "BUY · MKT"
}

/** Mirrors @hippo/protocol LifecycleFrame's phase vocabulary. */
export type LifecyclePhase = 'awaiting_confirm' | 'filled' | 'partial' | 'cancelled' | 'expired'

export type LifecycleEvent = {
  ticketId: string
  phase: LifecyclePhase
  statusLine: string
  venueOrderId?: string
  fillPct?: number
  rows?: Array<{ label: string; value: string }>
}

export type PositionRow = {
  instrument: string
  size: string
  entry: string
  mark: string
  pnl: string
  tone: 'pos' | 'neg' | 'neutral'
}

export type OpenOrder = {
  orderId: string
  side: OrderSide
  summary: string
  status: string
}

export type Portfolio = {
  positions: PositionRow[]
  openOrders: OpenOrder[]
}

/** Structured logger surface adapters report through (a fastify logger fits). */
export type AdapterLog = {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
}

/**
 * Per-venue adapter contract. One implementation per venue, loaded by
 * partner config; `SimVenueAdapter` is the dev implementation and the
 * Assetworks adapter is the reference implementation against a real HTTP venue.
 * Venue events are delivered through `onEvent` — in production they arrive
 * from the venue's webhooks plus a poll reconciler; the adapter normalizes
 * both into LifecycleEvent.
 */
export interface VenueAdapter {
  prepare(req: PrepareRequest): Promise<PreparedTicket>
  /**
   * Capability-tagged prepare. Optional so pre-capability adapters keep
   * compiling; adapters that implement it MUST throw when the plan's
   * capability is absent from capabilities().
   */
  prepareOrder?(plan: OrderPlan): Promise<PreparedTicket>
  /** What this venue supports, per capability — callers gate plans on this. */
  capabilities(): Promise<VenueCapabilitiesShape>
  /** Fire-and-return: subsequent venue events flow through onEvent. */
  confirm(ticketId: string): Promise<void>
  /** true if the ticket was still cancellable venue-side. */
  cancel(ticketId: string): Promise<boolean>
  portfolio(partnerId: string, userId: string): Promise<Portfolio>
  onEvent(handler: (event: LifecycleEvent) => void): void
  /** Optional: receive the service's logger (wired by buildService) so
   * venue-API failures the adapter absorbs are still visible to operators. */
  setLogger?(log: AdapterLog): void
}
