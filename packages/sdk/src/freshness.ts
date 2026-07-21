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

/** How long the refresh-land amber flash holds (the brand's "flash" verb). */
export const LANDED_FLASH_MS = 700

/**
 * Stale age prefix for the as-of line — "⚠ 14 MIN OLD · " (prototype stale
 * variant). Null while fresh or when the date is unparseable. Age math on a
 * timestamp is clock arithmetic, not data logic — the server's asOf string
 * itself stays untouched beside it.
 */
export function staleAgeLabel(asOfIso: string, nowMs: number = Date.now()): string | null {
  if (!isStale(asOfIso, nowMs)) return null
  const mins = Math.floor((nowMs - Date.parse(asOfIso)) / 60_000)
  if (mins < 60) return `⚠ ${mins} MIN OLD · `
  return `⚠ ${Math.floor(mins / 60)} HR OLD · `
}
