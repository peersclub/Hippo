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

export type PreparedTicket = {
  ticketId: string
  side: OrderSide
  instrument: string
  orderType: OrderType
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

/**
 * Per-venue adapter contract. One implementation per venue, loaded by
 * partner config; `SimVenueAdapter` is the dev implementation and the
 * hand-built KoinBX adapter (Phase 3 pilot) is the CLI's codegen target.
 * Venue events are delivered through `onEvent` — in production they arrive
 * from the venue's webhooks plus a poll reconciler; the adapter normalizes
 * both into LifecycleEvent.
 */
export interface VenueAdapter {
  prepare(req: PrepareRequest): Promise<PreparedTicket>
  /** Fire-and-return: subsequent venue events flow through onEvent. */
  confirm(ticketId: string): Promise<void>
  /** true if the ticket was still cancellable venue-side. */
  cancel(ticketId: string): Promise<boolean>
  portfolio(partnerId: string, userId: string): Promise<Portfolio>
  onEvent(handler: (event: LifecycleEvent) => void): void
}
