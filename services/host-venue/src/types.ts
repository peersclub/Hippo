/**
 * Assetworks Exchange — venue-side domain + wire types.
 *
 * The spot trade wire is deliberately Assetworks-shaped (numeric enums, a
 * `{ status, data }` envelope, HMAC headers) so the integration we test is the
 * same SHAPE as the real Phase-3 pilot rails — a parasite adapter written for
 * one is a small diff from the other. Perps are a clean superset: the same
 * envelope with a `market: 'perp'` discriminator and position semantics the
 * spot wire never needed.
 */

/** Assetworks-compatible enums — a parasite that speaks Assetworks speaks these. */
export const ORDER_SIDE = { buy: 0, sell: 1 } as const
export const TRADE_TYPE = { limit: 10, market: 20 } as const
export const ORDER_STATUS = {
  ACTIVE: 10,
  SETTLED: 20,
  PARTIAL: 30,
  PARTIAL_CANCELED: 40,
  CANCELED: 50,
} as const

export type Market = 'spot' | 'perp'
export type Side = 'buy' | 'sell'
export type OrderKind = 'market' | 'limit'
export type Direction = 'long' | 'short'
export type MarginMode = 'isolated' | 'cross'

/** Confirm surface — Open Decision #6. `api`: the parasite places directly with
 *  its scoped key. `js_callback`: the parasite hands off and the HOST renders a
 *  native confirm modal; the trader approves on the host, the host places. */
export type ConfirmSurface = 'api' | 'js_callback'

/** How eligible orders settle. `working` (default) rests for workingWindowMs
 *  then fills; `instant` fills on the first sweep after the window (window may
 *  be 0); `manual` never auto-fills — the host approves each fill from the
 *  settings page, so an operator can hold an order in WORKING as long as they
 *  like and watch the parasite's working card. */
export type FillMode = 'working' | 'instant' | 'manual'

/** Live-tunable venue behaviour + capabilities, editable from the host
 *  settings page. Every field is a test lever whose effect is observable in
 *  the embedded Hippo chat. */
export type AdminConfig = {
  confirmSurface: ConfirmSurface
  /** Minimum time an order rests ACTIVE before it can settle. MUST be >= the
   *  parasite reconciler's poll interval, or a fast fill is never observed
   *  open→absent and the lifecycle card times out to "expired". */
  workingWindowMs: number
  /** Taker fee applied to spot notional and perp open/close. */
  feeRate: number
  /** Maker fee applied to resting limit orders that fill. */
  makerFee: number
  /** When true, market orders fill in two steps (PARTIAL → SETTLED) to
   *  exercise the parasite's partial-fill lifecycle path. */
  partialFills: boolean

  // ── realism & chaos ──
  fillMode: FillMode
  /** Market-order fill slippage against the taker, as a fraction (0.001 = 10bps). */
  slippagePct: number
  /** Artificial latency added to signed trade responses (ms) — surfaces the
   *  parasite's "working"/thinking states and stresses its timeouts. */
  latencyMs: number
  /** Probability [0..1] that a placement is rejected — exercises the chat's
   *  rejection card. */
  rejectRate: number
  /** When true, ALL placements are rejected with a maintenance error. */
  maintenance: boolean

  // ── capabilities (drive /v1/capabilities + what the parasite may place) ──
  capsSpot: boolean
  capsPerp: boolean
  capsOptions: boolean
  maxLeverage: number
  marginModes: Array<'isolated' | 'cross'>
  /** Tradable instruments advertised to the parasite, e.g. ["BTC/USDT", …]. */
  instruments: string[]
  /** Per-order base-quantity bounds (0 = unbounded). */
  minOrderSize: number
  maxOrderSize: number
}

/** A resting or settled order on the venue book. */
export type Order = {
  id: number
  /** Parasite-supplied idempotency/correlation id (the seam ticketId). Lets the
   *  reconciler match a placed order even before it learns the venue id — the
   *  js_callback surface relies on this. */
  clientOrderId?: string
  userId: string
  market: Market
  pairName: string // "BTC-USDT"
  side: Side
  kind: OrderKind
  qty: number
  filledQty: number
  rate: number // limit price, or the quote captured at market placement
  avgFillPrice?: number
  status: number // ORDER_STATUS
  // perp-only
  direction?: Direction
  leverage?: number
  marginMode?: MarginMode
  reduceOnly?: boolean
  createdAt: number
  settleAfter: number // now + workingWindowMs
}

/** Spot wallet balance per currency. */
export type Balance = { currencyName: string; amount: number }

/** An open perpetual position, marked to the live price. */
export type Position = {
  userId: string
  pairName: string
  direction: Direction
  size: number // base qty
  entry: number
  leverage: number
  marginMode: MarginMode
  margin: number // quote locked
  liquidation: number
}

/** A pending js_callback handoff awaiting the trader's approval in the host UI. */
export type Handoff = {
  clientOrderId: string
  userId: string
  place: PlaceRequest
  displayRows: Array<{ label: string; value: string }>
  state: 'pending' | 'placed' | 'rejected' | 'expired'
  venueOrderId?: number
  createdAt: number
}

/** Normalized place request (parsed from the Assetworks-shaped wire body). */
export type PlaceRequest = {
  clientOrderId?: string
  market: Market
  pairName: string
  side: Side
  kind: OrderKind
  qty: number
  rate: number
  marketOrderAmount?: number
  direction?: Direction
  leverage?: number
  marginMode?: MarginMode
  reduceOnly?: boolean
}

/** Any change worth pushing to the host UI over SSE. */
export type StreamEvent =
  | {
      type: 'snapshot'
      balances: Balance[]
      orders: Order[]
      positions: Position[]
      config: AdminConfig
    }
  | { type: 'order'; order: Order }
  | { type: 'fill'; order: Order }
  | { type: 'balances'; balances: Balance[] }
  | { type: 'positions'; positions: Position[] }
  | { type: 'config'; config: AdminConfig }
  | { type: 'handoff'; handoff: Handoff }
