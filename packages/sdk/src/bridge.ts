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

import { acceptAck, applyAck } from './host-actions.js'
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
 * Host page-control opt-in (data-hippo-page-control). When true, the SDK
 * advertises `pageControl` on its context uplinks — the gateway emits
 * host_action frames ONLY after that arrived true — and accepts the host's
 * acks. Set once at mount from the embed dataset (panel.tsx). Module-scoped,
 * not a render signal: nothing in the UI depends on it directly.
 */
let pageControl = false
export function setPageControl(on: boolean): void {
  pageControl = on
}

/**
 * Host capability declaration (August 2026) — the verbs the host page supports,
 * collected from its `hippo:capabilities` message:
 *
 *   SDK → host:  { source:'hippo-sdk',  type:'hippo:capabilities:request' }
 *   host → SDK:  { source:'hippo-host', type:'hippo:capabilities', actions: string[] }
 *
 * Both directions exist because load order is unknowable: the host announces
 * proactively on ITS load (covers "SDK mounted first"), and answers the SDK's
 * request (covers "host loaded first" — the SDK asks only after its listener
 * is installed, so the answer can't be missed). null = no declaration received;
 * with pageControl on, the context uplink then OMITS hostActions and the
 * gateway falls back to the legacy chart trio (the contract's back-compat rule
 * — omission IS the legacy encoding, so we never synthesize a trio here).
 */
let hostActions: string[] | null = null

/** Bounds mirrored from ContextUplink.hostActions (≤24 verbs, each ≤40 chars). */
export const MAX_HOST_ACTIONS = 24
export const MAX_ACTION_LEN = 40

/** Test/remount hook — clears the collected declaration. */
export function resetHostActions(): void {
  hostActions = null
}

/**
 * Validate one raw window message as a host capability declaration. Strict on
 * shape (wrong source/type/actions → null, same posture as parseBridgeMessage);
 * lenient on entries — a non-string, empty or oversized verb is DROPPED, not
 * fatal, so a host growing its vocabulary can never knock out the verbs the
 * contract can carry. Deduped and capped to the uplink bound.
 */
export function parseCapabilities(data: unknown): string[] | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (d.source !== 'hippo-host' || d.type !== 'hippo:capabilities') return null
  if (!Array.isArray(d.actions)) return null
  const out: string[] = []
  for (const a of d.actions) {
    if (typeof a !== 'string' || a.length === 0 || a.length > MAX_ACTION_LEN) continue
    if (!out.includes(a)) out.push(a)
    if (out.length >= MAX_HOST_ACTIONS) break
  }
  return out
}

/** The `context` uplink payload, stamped with pageControl when the host opted
 * in — plus the host's declared verbs once its capabilities message arrived
 * (omitted otherwise: pageControl with NO hostActions is the wire encoding for
 * "legacy chart verbs only"). Shared by the symbol-change send and the
 * session-start advertise so both carry the flags; pure + exported so its
 * shape is unit-testable. */
export function contextPayload(opts: { symbol?: string } = {}): {
  kind: 'context'
  symbol?: string
  pageControl?: true
  hostActions?: string[]
} {
  return {
    kind: 'context',
    ...(opts.symbol ? { symbol: opts.symbol } : {}),
    ...(pageControl ? { pageControl: true } : {}),
    ...(pageControl && hostActions ? { hostActions: [...hostActions] } : {}),
  }
}

/**
 * Advertise the host's page-control opt-in to the gateway. mountPanel calls
 * this once the session is live (after connect); a no-symbol context is still
 * valid — pageControl is the payload. No-op when the host never opted in, so a
 * page that didn't ask can never be driven.
 */
export function advertisePageControl(): void {
  if (!pageControl) return
  void send(contextPayload({ symbol: pageSymbol.value ?? undefined }))
}

/**
 * Store a freshly-declared verb set and re-advertise. Safe to call any time:
 * before the session exists, `send` no-ops and the post-connect
 * advertisePageControl carries the verbs; after, this uplink updates the
 * gateway's stored set. An unchanged declaration is dropped (hosts may
 * re-announce on every request).
 */
export function acceptCapabilities(actions: string[]): void {
  const prev = hostActions
  if (prev !== null && prev.length === actions.length && actions.every((a, i) => prev[i] === a)) {
    return
  }
  hostActions = actions
  advertisePageControl()
}

/**
 * Ask the host page to (re)declare its verbs. Called at mount AFTER
 * installHostBridge — our listener is live, so the answer can't race us — and
 * only when the host opted into page control (capabilities are meaningless
 * without it). Never throws.
 */
export function requestHostCapabilities(): void {
  if (!pageControl || typeof window === 'undefined') return
  try {
    window.postMessage(
      { source: 'hippo-sdk', type: 'hippo:capabilities:request' },
      window.location.origin,
    )
  } catch {
    // Untrusted host environment — never let a post failure break the panel.
  }
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
      // Host page-control ack (hippo:action:result) — same untrusted-input
      // posture as context, plus an origin gate: we posted the action to our
      // own origin, so the host acks from there. Wrong origin/source/actionId
      // is dropped; a valid ack settles the chip.
      const ack = acceptAck(ev.origin, window.location.origin, ev.data)
      if (ack) {
        applyAck(ack)
        return
      }
      // Host capability declaration — same origin gate as acks (the host
      // announces from its own window), same strict-shape posture.
      if (ev.origin === window.location.origin) {
        const caps = parseCapabilities(ev.data)
        if (caps) {
          acceptCapabilities(caps)
          return
        }
      }
      const ctx = parseBridgeMessage(ev.data)
      if (!ctx) return
      if (ctx.symbol && ctx.symbol !== pageSymbol.value) {
        pageSymbol.value = ctx.symbol // 'client' mode resubscribes off this
        // Tell the server which market the trader is looking at now. Context,
        // never a command — nothing executes from it (and the gateway
        // re-validates the symbol against its own listings). Re-carries the
        // pageControl opt-in so a symbol change keeps the gateway willing to
        // emit host_action frames.
        void send(contextPayload({ symbol: ctx.symbol }))
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
