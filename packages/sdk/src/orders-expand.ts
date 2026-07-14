/**
 * Orders-strip expansion logic — pure, testable. Baseline §3: tapping a
 * pill expands its full order card in place (max-height animation, thread
 * pushed down); tapping again collapses. "+ New order" expands a draft
 * hint — order placement stays conversational, never a form.
 */

/** Sentinel expansion target for the dashed "+ New order" pill. */
export const NEW_ORDER = '+new' as const

export type ExpandTarget = string | null

/** Second tap on the same pill collapses; a different pill switches. */
export function toggleExpand(current: ExpandTarget, target: string): ExpandTarget {
  return current === target ? null : target
}

/**
 * Parse a server-formatted pill summary (e.g. "BUY 0.05 BTC · MKT") into
 * its display segments for the expanded card: the first segment is the
 * order line, the rest are detail badges. Display-only splitting — the SDK
 * never computes money or reinterprets order semantics.
 */
export function parseOrderSummary(summary: string): { main: string; details: string[] } {
  const segs = summary
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean)
  return { main: segs[0] ?? summary.trim(), details: segs.slice(1) }
}

/**
 * Example intents for the new-order hint. These FILL the composer — they
 * are never auto-sent; the trader always hits send themselves.
 */
export const EXAMPLE_INTENTS = ['buy 0.05 btc at market', 'sell half my SOL position'] as const
