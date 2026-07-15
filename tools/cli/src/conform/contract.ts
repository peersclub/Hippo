/**
 * The CTI contract as the conformance suite sees it: the minimal driver a
 * candidate adapter must satisfy, plus the venue-neutral data shapes the suite
 * asserts against. A driver adapts either an in-process VenueAdapter or a
 * running seam HTTP surface to this interface; the suite only ever talks to
 * the driver, so it grades hand-built and generated adapters identically.
 */

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit'

export interface PrepareInput {
  partnerId: string
  userId: string
  side: OrderSide
  size: string
  instrument: string
  orderType: OrderType
  limitPrice?: string
}

export interface TicketRow {
  label: string
  value: string
}

export interface PreparedTicketShape {
  ticketId: string
  sideLabel: string
  instrument: string
  orderType: OrderType
  rows: TicketRow[]
}

export type LifecyclePhase = 'awaiting_confirm' | 'filled' | 'partial' | 'cancelled' | 'expired'

export interface LifecycleEventShape {
  ticketId: string
  phase: LifecyclePhase
  statusLine: string
  venueOrderId?: string
  fillPct?: number
  rows?: TicketRow[]
}

export interface PortfolioShape {
  positions: Array<{ instrument: string; size: string }>
  openOrders: Array<{ orderId: string; side: OrderSide; summary: string; status: string }>
}

/**
 * What the suite drives. `onLifecycle` streams venue events (however the driver
 * sources them — in-process callback or the seam's delivery webhook). `close`
 * releases any listener/timer the driver holds.
 */
export interface ConformanceDriver {
  readonly target: string
  prepare(input: PrepareInput): Promise<PreparedTicketShape>
  confirm(ticketId: string): Promise<void>
  cancel(ticketId: string): Promise<boolean>
  portfolio(partnerId: string, userId: string): Promise<PortfolioShape>
  onLifecycle(handler: (event: LifecycleEventShape) => void): void
  close?(): Promise<void>
}

/** A terminal phase ends the lifecycle — the thread must reach one of these. */
export const TERMINAL_PHASES: ReadonlySet<LifecyclePhase> = new Set([
  'filled',
  'cancelled',
  'expired',
])
