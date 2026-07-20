import { create } from "zustand"
import type { BookLevel, Candle, Trade } from "@/lib/ws/binance"
import type { AdminConfig, Balance, Handoff, Order, Position, TicketInput } from "@/lib/venue/types"

export const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT"]

interface ExchangeState {
  pair: string
  setPair: (p: string) => void

  // market data
  lastPrice: number
  changePct: number
  candles: Candle[]
  bids: BookLevel[]
  asks: BookLevel[]
  trades: Trade[]
  wsUp: boolean
  setTicker: (last: number, changePct: number) => void
  pushCandle: (c: Candle) => void
  seedCandles: (c: Candle[]) => void
  setBook: (bids: BookLevel[], asks: BookLevel[]) => void
  pushTrade: (t: Trade) => void
  setWsUp: (up: boolean) => void

  // venue state
  orders: Order[]
  positions: Position[]
  balances: Balance[]
  config: AdminConfig | null
  hostUp: boolean
  handoff: Handoff | null
  setSnapshot: (s: { orders: Order[]; positions: Position[]; balances: Balance[]; config: AdminConfig }) => void
  upsertOrder: (o: Order) => void
  setBalances: (b: Balance[]) => void
  setPositions: (p: Position[]) => void
  setConfig: (c: AdminConfig) => void
  setHostUp: (up: boolean) => void
  setHandoff: (h: Handoff | null) => void

  // ticket
  ticket: TicketInput
  patchTicket: (patch: Partial<TicketInput>) => void
}

export const useExchange = create<ExchangeState>((set) => ({
  pair: PAIRS[0],
  setPair: (pair) => set({ pair, candles: [], bids: [], asks: [], trades: [] }),

  lastPrice: 0,
  changePct: 0,
  candles: [],
  bids: [],
  asks: [],
  trades: [],
  wsUp: false,
  setTicker: (lastPrice, changePct) => set({ lastPrice, changePct }),
  seedCandles: (candles) => set({ candles, lastPrice: candles.at(-1)?.c ?? 0 }),
  pushCandle: (c) =>
    set((s) => {
      const candles = [...s.candles]
      const last = candles.at(-1)
      if (last && last.t === c.t) candles[candles.length - 1] = c
      else {
        candles.push(c)
        if (candles.length > 120) candles.shift()
      }
      return { candles, lastPrice: c.c }
    }),
  setBook: (bids, asks) => set({ bids, asks }),
  pushTrade: (t) => set((s) => ({ trades: [t, ...s.trades].slice(0, 40) })),
  setWsUp: (wsUp) => set({ wsUp }),

  orders: [],
  positions: [],
  balances: [],
  config: null,
  hostUp: false,
  handoff: null,
  setSnapshot: ({ orders, positions, balances, config }) => set({ orders, positions, balances, config }),
  upsertOrder: (o) =>
    set((s) => {
      const i = s.orders.findIndex((x) => x.id === o.id)
      const orders = [...s.orders]
      if (i >= 0) orders[i] = o
      else orders.unshift(o)
      return { orders }
    }),
  setBalances: (balances) => set({ balances }),
  setPositions: (positions) => set({ positions }),
  setConfig: (config) => set({ config }),
  setHostUp: (hostUp) => set({ hostUp }),
  setHandoff: (handoff) => set({ handoff }),

  ticket: { market: "spot", side: "buy", kind: "market", pair: PAIRS[0], qty: 0.01, leverage: 10, marginMode: "isolated", reduceOnly: false },
  patchTicket: (patch) => set((s) => ({ ticket: { ...s.ticket, ...patch } })),
}))
