// Binance PUBLIC market data (no keys) — the open-source feed powering the
// chart, book, and tape. Modeled on assetwork-ai-web's WebSocketManager:
// single socket, auto-reconnect with backoff, typed callbacks.

export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
}
export interface BookLevel {
  price: number
  qty: number
}
export interface Trade {
  price: number
  qty: number
  sell: boolean
  t: number
}
export interface Ticker {
  last: number
  changePct: number
}

export interface BinanceHandlers {
  onKline?: (c: Candle) => void
  onBook?: (bids: BookLevel[], asks: BookLevel[]) => void
  onTrade?: (t: Trade) => void
  onTicker?: (t: Ticker) => void
  onStatus?: (up: boolean) => void
}

const REST = "https://api.binance.com/api/v3/klines"
const stream = (sym: string) =>
  `wss://stream.binance.com:9443/stream?streams=${sym}@kline_1m/${sym}@depth20@100ms/${sym}@trade/${sym}@ticker`

export class BinanceStream {
  private ws: WebSocket | null = null
  private closed = false
  private attempts = 0
  private handlers: BinanceHandlers = {}

  constructor(private pair: string) {}

  /** Seed 1m candle history via REST (so the chart isn't empty on connect). */
  async seedCandles(): Promise<Candle[]> {
    const sym = this.pair.replace("/", "").toUpperCase()
    const res = await fetch(`${REST}?symbol=${sym}&interval=1m&limit=120`)
    const raw = (await res.json()) as (string | number)[][]
    return raw.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }))
  }

  connect(handlers: BinanceHandlers) {
    this.handlers = handlers
    this.open()
  }

  private open() {
    if (this.closed) return
    const sym = this.pair.replace("/", "").toLowerCase()
    const ws = new WebSocket(stream(sym))
    this.ws = ws
    ws.onopen = () => {
      this.attempts = 0
      this.handlers.onStatus?.(true)
    }
    ws.onclose = () => {
      this.handlers.onStatus?.(false)
      if (!this.closed) {
        this.attempts++
        setTimeout(() => this.open(), Math.min(1000 * this.attempts, 8000))
      }
    }
    ws.onmessage = (m) => {
      const { stream: s, data } = JSON.parse(m.data)
      if (s.endsWith("@kline_1m")) {
        const k = data.k
        this.handlers.onKline?.({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c })
      } else if (s.includes("@depth")) {
        this.handlers.onBook?.(
          data.bids.map((b: string[]) => ({ price: +b[0], qty: +b[1] })),
          data.asks.map((a: string[]) => ({ price: +a[0], qty: +a[1] })),
        )
      } else if (s.endsWith("@trade")) {
        this.handlers.onTrade?.({ price: +data.p, qty: +data.q, sell: data.m, t: +data.T })
      } else if (s.endsWith("@ticker")) {
        this.handlers.onTicker?.({ last: +data.c, changePct: +data.P })
      }
    }
  }

  close() {
    this.closed = true
    this.ws?.close()
  }
}
