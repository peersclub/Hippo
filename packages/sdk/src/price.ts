/**
 * Live-price sources — a small strategy keyed by the embed's
 * `data-hippo-price-source`, deciding who feeds the `livePrice` signal:
 *
 *   'server' (default) — passive. The gateway's `price_tick` frames land in
 *     livePrice via state.ts routing; nothing to start here.
 *   'client' — the SDK opens the same public Binance WebSocket ticker the
 *     demo host uses (wss://stream.binance.com:9443/ws/<sym>@ticker), so the
 *     panel's number IS the host's number without any server hop. Reconnects
 *     with capped exponential backoff; closes/reopens on symbol change.
 *   'host' — passive. The host page pushes prices over the postMessage
 *     bridge (bridge.ts); nothing to start here either.
 *
 * The host bridge is ALWAYS listening regardless of mode — an explicit host
 * price is the most authoritative "same number as the host" and overwrites
 * whatever the mode's own feed last wrote. This module must never throw into
 * the panel: every WS callback is failure-isolated.
 *
 * Pure helpers (URL builder, ticker parse, display format) are exported for
 * the pure-logic test suite; only the subscribe machinery touches WebSocket.
 */
import { type LivePrice, livePrice, pageSymbol } from './state.js'

export type PriceSource = 'server' | 'client' | 'host'

/** Normalize the embed attr; anything unknown means the safe default. */
export function normalizePriceSource(raw: string | null | undefined): PriceSource {
  return raw === 'client' || raw === 'host' ? raw : 'server'
}

/** "BTC/USDT" → "btcusdt" — Binance stream symbol (lowercase, no slash). */
export function wsSymbol(symbol: string): string {
  return symbol.replace('/', '').toLowerCase()
}

/** Public Binance ticker stream for one symbol — mirrors the demo host. */
export function tickerWsUrl(symbol: string): string {
  return `wss://stream.binance.com:9443/ws/${wsSymbol(symbol)}@ticker`
}

/** Format a live price for display — the host's fmtPx convention (2dp at
 * ≥1000, 4dp below), so the panel's number reads like the host's. This is a
 * live display, not a money row the trader confirms (those stay
 * server-formatted strings, protocol law). */
export function formatPriceDisplay(n: number): string {
  const d = n >= 1000 ? 2 : 4
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

/**
 * Parse one raw Binance `@ticker` message into a LivePrice for `symbol`.
 * Null for anything else — junk bytes, a different symbol (a stale socket
 * mid-resubscribe), or a payload without a finite last price. `c` is the
 * last price, `P` the 24h change %, `E` the event time (ms).
 */
export function parseTicker(raw: string, symbol: string): LivePrice | null {
  let d: unknown
  try {
    d = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof d !== 'object' || d === null) return null
  const m = d as { s?: unknown; c?: unknown; P?: unknown; E?: unknown }
  if (typeof m.s !== 'string' || m.s.toLowerCase() !== wsSymbol(symbol)) return null
  const last = Number(m.c)
  if (typeof m.c !== 'string' || !Number.isFinite(last) || last <= 0) return null
  const pct = Number(m.P)
  const ts = typeof m.E === 'number' && Number.isFinite(m.E) ? m.E : Date.now()
  return {
    symbol,
    last,
    lastDisplay: formatPriceDisplay(last),
    changePct: typeof m.P === 'string' && Number.isFinite(pct) ? pct : undefined,
    asOfIso: new Date(ts).toISOString(),
  }
}

// ── 'client' mode machinery ─────────────────────────────────────────────────
// One socket for the current pageSymbol. Same backoff shape as transport.ts:
// exponential from 1s capped at 30s, reset by a genuinely open socket.

const WS_BACKOFF_BASE_MS = 1000
const WS_BACKOFF_MAX_MS = 30_000

let ws: WebSocket | null = null
let currentSymbol: string | null = null
let backoff = WS_BACKOFF_BASE_MS
let retryTimer: ReturnType<typeof setTimeout> | null = null
let clientMode = false

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
}

function scheduleRetry(symbol: string) {
  if (retryTimer) return
  const delay = backoff
  backoff = Math.min(backoff * 2, WS_BACKOFF_MAX_MS)
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (clientMode && symbol === currentSymbol) openSocket(symbol)
  }, delay)
}

function openSocket(symbol: string) {
  try {
    ws = new WebSocket(tickerWsUrl(symbol))
  } catch {
    scheduleRetry(symbol)
    return
  }
  const sock = ws
  sock.onopen = () => {
    if (symbol === currentSymbol) backoff = WS_BACKOFF_BASE_MS
  }
  sock.onmessage = (ev) => {
    // A stale socket mid-resubscribe must never write the old market's price.
    if (symbol !== currentSymbol) return
    try {
      const tick = parseTicker(String(ev.data), symbol)
      if (tick) livePrice.value = tick
    } catch {
      // Wire data never throws into the panel.
    }
  }
  sock.onclose = () => {
    if (clientMode && symbol === currentSymbol) scheduleRetry(symbol)
  }
  sock.onerror = () => {
    // Force the close path (which owns the retry) — some engines fire error
    // without close on handshake failures.
    try {
      sock.close()
    } catch {
      // already closed
    }
  }
}

function subscribe(symbol: string | null) {
  if (symbol === currentSymbol) return
  currentSymbol = symbol
  clearRetry()
  backoff = WS_BACKOFF_BASE_MS
  const old = ws
  ws = null
  if (old) {
    try {
      old.close() // its onclose no-ops: currentSymbol moved on
    } catch {
      // already closed
    }
  }
  if (symbol) openSocket(symbol)
}

/**
 * Install the price source for this embed. 'server' and 'host' are passive —
 * their feeds arrive via frame routing / the bridge. 'client' follows the
 * pageSymbol signal: subscribe fires immediately with the current value
 * (initial open) and again on every bridge-driven symbol change (resubscribe).
 */
export function initPriceSource(mode: PriceSource): void {
  if (mode !== 'client' || clientMode) return
  if (typeof WebSocket === 'undefined') return // never throw into the panel
  clientMode = true
  pageSymbol.subscribe((sym) => {
    try {
      subscribe(sym)
    } catch {
      // A price feed failure never breaks the panel.
    }
  })
}
