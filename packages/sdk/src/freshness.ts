/**
 * Stale-data threshold — baseline §7.5: declared, never silent. Past the
 * threshold the as-of line turns amber and REFRESH becomes the loudest
 * element. This is a timer over server truth, not client data logic.
 */
export const STALE_AFTER_MS = 3 * 60_000
export const STALE_CHECK_INTERVAL_MS = 30_000

/** True when the live-bar's asOfIso is older than the stale threshold. */
export function isStale(asOfIso: string, nowMs: number = Date.now()): boolean {
  const t = Date.parse(asOfIso)
  if (Number.isNaN(t)) return false
  return nowMs - t > STALE_AFTER_MS
}
