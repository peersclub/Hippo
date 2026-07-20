// The host FE's OWN copy of the venue wire types. Deliberately NOT imported
// from any Hippo package — the boundary is the HTTP contract, so each side
// declares its own view of it (a real 3rd-party integration works this way).

export const ORDER_STATUS_LABEL: Record<number, [string, string]> = {
  10: ["ACTIVE", "active"],
  20: ["FILLED", "settled"],
  30: ["PARTIAL", "partial"],
  40: ["PART-CXL", "canceled"],
  50: ["CANCELED", "canceled"],
}

export type Market = "spot" | "perp"
export type Side = "buy" | "sell"
export type OrderKind = "market" | "limit"
export type Direction = "long" | "short"
export type MarginMode = "isolated" | "cross"
export type ConfirmSurface = "api" | "js_callback"

export interface Order {
  id: number
  clientOrderId?: string
  market: Market
  pairName: string
  side: Side
  kind: OrderKind
  qty: number
  filledQty: number
  rate: number
  status: number
  direction?: Direction
  leverage?: number
  marginMode?: MarginMode
}

export interface Position {
  pairName: string
  direction: Direction
  size: number
  entry: number
  leverage: number
  marginMode: MarginMode
  margin: number
  liquidation: number
}

export interface Balance {
  currencyName: string
  amount: number
}

export interface AdminConfig {
  confirmSurface: ConfirmSurface
  workingWindowMs: number
  feeRate: number
  partialFills: boolean
}

export interface Handoff {
  clientOrderId: string
  place: { pairName: string; side: Side; qty: number; market: Market }
  displayRows: { label: string; value: string }[]
  state: "pending" | "placed" | "rejected" | "expired"
}

export type StreamEvent =
  | { type: "snapshot"; balances: Balance[]; orders: Order[]; positions: Position[]; config: AdminConfig }
  | { type: "order"; order: Order }
  | { type: "fill"; order: Order }
  | { type: "balances"; balances: Balance[] }
  | { type: "positions"; positions: Position[] }
  | { type: "config"; config: AdminConfig }
  | { type: "handoff"; handoff: Handoff }

/** Order ticket the human fills in (before mapping to the signed wire). */
export interface TicketInput {
  market: Market
  side: Side
  kind: OrderKind
  pair: string
  qty: number
  limitPrice?: number
  leverage: number
  marginMode: MarginMode
  reduceOnly: boolean
}
