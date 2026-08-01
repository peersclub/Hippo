/**
 * Order-draft edit logic — the pure half of OrderDraftCard (cards.tsx), kept
 * separate so it tests without jsdom, per the SDK convention.
 *
 * Thin-client law: the SDK never invents an order. The card's controls are
 * seeded from the server's OrderDraftFrame; these helpers only validate and
 * ECHO the trader's edits back as draft_action params, which the gateway
 * re-validates against venue capabilities before anything is prepared. The
 * client-side clamps exist to keep the CONTROLS honest (a slider can't leave
 * its bounds), not to authorize anything.
 */
import type { OrderDraft } from '@hippo/protocol'

/** Venue-cap fallbacks when the frame omits perp bounds. */
export const DEFAULT_MAX_LEVERAGE = 50
export const DEFAULT_LEVERAGE = 10

/** Size gate: submit stays disabled until the size parses to a number > 0. */
export function sizeValid(size: string): boolean {
  const v = size.trim()
  if (v === '') return false
  const n = Number(v)
  return Number.isFinite(n) && n > 0
}

/** Clamp a leverage value into [1, max] as an integer (slider truth). */
export function clampLeverage(lev: number, max: number): number {
  const bound = Math.max(1, Math.floor(Number.isFinite(max) ? max : DEFAULT_MAX_LEVERAGE))
  const n = Math.floor(Number.isFinite(lev) ? lev : DEFAULT_LEVERAGE)
  return Math.min(Math.max(1, n), bound)
}

/** The slider's upper bound — the frame's venue cap or the default. */
export function maxLeverageOf(frame: Pick<OrderDraft, 'maxLeverage'>): number {
  return frame.maxLeverage ?? DEFAULT_MAX_LEVERAGE
}

/** The slider's initial position — frame value (default 10), inside bounds. */
export function initialLeverage(frame: Pick<OrderDraft, 'leverage' | 'maxLeverage'>): number {
  return clampLeverage(frame.leverage ?? DEFAULT_LEVERAGE, maxLeverageOf(frame))
}

/**
 * Whether the card shows the protective-exit (stop-loss / take-profit)
 * inputs. FRAME PRESENCE drives it — the server includes the fields (possibly
 * empty) only when the venue supports attaching them; the SDK never decides
 * venue truth. Empty string = shown but unset.
 */
export function protectiveEnabled(
  frame: Pick<OrderDraft, 'stopLossPrice' | 'takeProfitPrice'>,
): boolean {
  return frame.stopLossPrice !== undefined || frame.takeProfitPrice !== undefined
}

/** The card's local edit state (component state seeded from the frame). */
export type DraftEdit = {
  capability: OrderDraft['capability']
  instrument: string
  orderType: 'market' | 'limit'
  size: string
  limitPrice: string
  /** '' when the venue doesn't offer protective exits (inputs hidden) or the
   * trader left them blank — either way the param is omitted on submit. */
  stopLossPrice: string
  takeProfitPrice: string
  leverage: number
  maxLeverage: number
  marginMode?: 'isolated' | 'cross'
}

export type DraftParams = {
  instrument: string
  orderType: 'market' | 'limit'
  size: string
  limitPrice?: string
  stopLossPrice?: string
  takeProfitPrice?: string
  leverage?: number
  marginMode?: 'isolated' | 'cross'
}

/**
 * Assemble the draft_action submit params from the card's edit state:
 *   - limitPrice rides only on limit orders (a market order has none);
 *   - stopLossPrice/takeProfitPrice ride whenever non-empty (spot or perp) —
 *     the gateway re-validates them against venue capabilities;
 *   - leverage/marginMode ride only on perps, leverage clamped to the
 *     venue bound client-side (the server re-clamps regardless);
 *   - strings are trimmed but otherwise echoed verbatim — the server is the
 *     validator, the client only refuses the obviously unsendable.
 */
export function assembleDraftParams(edit: DraftEdit): DraftParams {
  const params: DraftParams = {
    instrument: edit.instrument,
    orderType: edit.orderType,
    size: edit.size.trim(),
  }
  if (edit.orderType === 'limit' && edit.limitPrice.trim() !== '') {
    params.limitPrice = edit.limitPrice.trim()
  }
  if (edit.stopLossPrice.trim() !== '') params.stopLossPrice = edit.stopLossPrice.trim()
  if (edit.takeProfitPrice.trim() !== '') params.takeProfitPrice = edit.takeProfitPrice.trim()
  if (edit.capability === 'futures_perp') {
    params.leverage = clampLeverage(edit.leverage, edit.maxLeverage)
    if (edit.marginMode) params.marginMode = edit.marginMode
  }
  return params
}
