/**
 * Pure display helpers shared by the Dashboard and Pilot pages. Kept free of
 * JSX/router imports so the node-env vitest suite can exercise them directly.
 */

export type GatewayCache = { hits?: number; misses?: number; hitRate: number | null }
export type IntelCache = { entries: number; hitRate: number }

/**
 * Answer-cache hit rate for display. Intelligence-side stats win (Redis-backed
 * when configured); the gateway's since-boot counter is the fallback. A 0 with
 * no observed cache traffic anywhere means "no data yet", not a 0% hit rate —
 * rendered as null so the page shows an em-dash with a "no traffic yet" hint
 * instead of a number that reads as total cache failure.
 */
export function hitRateDisplay(
  intelCache: IntelCache | undefined,
  gwCache: GatewayCache | undefined,
): { rate: number | null; fromGateway: boolean } {
  const gwTraffic = (gwCache?.hits ?? 0) + (gwCache?.misses ?? 0)
  if (intelCache) {
    // The intelligence /health reports a bare 0 both for "all misses" and
    // "never asked" — the gateway's per-boot counters disambiguate, and a
    // non-empty cache proves traffic happened even if the gateway just booted
    // (Redis-backed entries survive restarts; a genuine all-miss 0 must render
    // as 0%, not "no traffic yet").
    const rate =
      intelCache.hitRate === 0 && gwTraffic === 0 && intelCache.entries === 0
        ? null
        : intelCache.hitRate
    return { rate, fromGateway: false }
  }
  if (!gwCache || gwCache.hitRate == null || gwTraffic === 0) {
    return { rate: null, fromGateway: false }
  }
  return { rate: gwCache.hitRate, fromGateway: true }
}
