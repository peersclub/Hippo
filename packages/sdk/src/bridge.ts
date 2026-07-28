/**
 * Host bridge — the postMessage channel a host page uses to keep the embed in
 * sync with what the trader is looking at:
 *
 *   window.postMessage({ type: 'hippo:context',
 *                        symbol?: 'BTC/USDT',
 *                        price?: { last: 63631.63, lastDisplay?: '63,631.63' } })
 *
 * Security posture — window messages are UNTRUSTED input from anywhere:
 *   - Only messages shaped exactly like the contract above are accepted;
 *     every present field is type-checked strictly and the whole message is
 *     dropped on any mismatch. Everything else on the channel is ignored.
 *   - `symbol` must match SYMBOL_RE (a plain BASE/QUOTE pair) — it is data,
 *     never markup or code, and is normalized to uppercase before use.
 *   - `lastDisplay` is a bounded plain string rendered as TEXT only (Preact
 *     escapes it); nothing from the bridge is ever executed or HTML-injected.
 *   - The worst a forged message can do is repaint a displayed price or send
 *     a `context` hint the server independently validates — no trading action
 *     routes through the bridge, and the server re-validates every order.
 *
 * The bridge is ALWAYS listening regardless of `data-hippo-price-source`;
 * the mode only decides who ELSE feeds livePrice. An explicit host price is
 * the most authoritative "same number as the host", so it lands in any mode.
 * On a valid symbol change it updates pageSymbol (which resubscribes the
 * 'client' WS via its signal subscription) and sends a `context` uplink.
 */

import { formatPriceDisplay } from './price.js'
import { livePrice, pageSymbol } from './state.js'
import { send } from './transport.js'

/** A plain spot/perp pair — "BTC/USDT", "1000PEPE/USDT", … Nothing else. */
export const SYMBOL_RE = /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/i

/** Longest lastDisplay the bridge will carry — generous for any real price. */
export const MAX_DISPLAY_LEN = 24

export type BridgeContext = {
  symbol?: string
  price?: { last: number; lastDisplay?: string }
}

/**
 * Validate one raw window message. Returns the normalized context, or null
 * for anything that isn't a well-formed hippo:context — wrong type tag,
 * missing payload, mistyped/malformed fields (strict: one bad field rejects
 * the whole message rather than half-applying it).
 */
export function parseBridgeMessage(data: unknown): BridgeContext | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (d.type !== 'hippo:context') return null
  const out: BridgeContext = {}
  if (d.symbol !== undefined) {
    if (typeof d.symbol !== 'string' || !SYMBOL_RE.test(d.symbol)) return null
    out.symbol = d.symbol.toUpperCase()
  }
  if (d.price !== undefined) {
    if (typeof d.price !== 'object' || d.price === null || Array.isArray(d.price)) return null
    const p = d.price as Record<string, unknown>
    if (typeof p.last !== 'number' || !Number.isFinite(p.last) || p.last <= 0) return null
    if (
      p.lastDisplay !== undefined &&
      (typeof p.lastDisplay !== 'string' ||
        p.lastDisplay.length === 0 ||
        p.lastDisplay.length > MAX_DISPLAY_LEN)
    )
      return null
    out.price = { last: p.last, lastDisplay: p.lastDisplay as string | undefined }
  }
  if (out.symbol === undefined && out.price === undefined) return null
  return out
}

let installed = false

/** Attach the always-on window listener. Idempotent; never throws. */
export function installHostBridge(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('message', (ev: MessageEvent) => {
    try {
      const ctx = parseBridgeMessage(ev.data)
      if (!ctx) return
      if (ctx.symbol && ctx.symbol !== pageSymbol.value) {
        pageSymbol.value = ctx.symbol // 'client' mode resubscribes off this
        // Tell the server which market the trader is looking at now. Context,
        // never a command — nothing executes from it (and the gateway
        // re-validates the symbol against its own listings).
        void send({ kind: 'context', symbol: ctx.symbol })
      }
      if (ctx.price) {
        // An explicit host price applies to the message's symbol, else the
        // page's current one. No symbol at all → nothing to key it to; drop.
        const symbol = ctx.symbol ?? pageSymbol.value
        if (!symbol) return
        livePrice.value = {
          symbol,
          last: ctx.price.last,
          lastDisplay: ctx.price.lastDisplay ?? formatPriceDisplay(ctx.price.last),
          asOfIso: new Date().toISOString(),
        }
      }
    } catch {
      // Untrusted input never breaks the panel.
    }
  })
}
