/**
 * Ambient market pulse — the server-side signal behind the minimized pill's
 * glow + mono event tag ("BTC +4.2% 1H").
 *
 * The rule is deliberately modest (baseline: one state, no counts): when the
 * session's symbol moved more than PULSE_THRESHOLD_PCT in the last hour, the
 * ticker poll emits ONE pulse frame per session per PULSE_COOLDOWN_MS — never
 * a stream of them, never a counter. The SDK shows the tag on the minimized
 * pill only and clears it the moment the panel opens.
 *
 * Delivery is TRANSIENT by contract (the price_tick precedent): a pulse is an
 * ambient nudge about *now*, so it rides the journal-bypassing SSE path. A
 * journaled pulse would replay on every resume and re-glow a pill the trader
 * already opened — exactly the stale-alert smell the transient path exists to
 * prevent.
 *
 * The 1h move is computed HERE, server-side, from market-data's hourly spark.
 * The SDK renders the tag verbatim (stop-line law: no client market math).
 */
import type { MarketSnapshot } from './orchestrator/market.js'

/** Typographic minus (U+2212) — same glyph market-data uses in stat cells. */
const MINUS = '−'

export const DEFAULT_PULSE_THRESHOLD_PCT = 3
export const DEFAULT_PULSE_COOLDOWN_MS = 30 * 60_000

/**
 * Last-hour move from the snapshot: `last` vs the hourly close one candle
 * back (`spark` is hourly closes oldest → newest, so spark[len-1] ≈ now and
 * spark[len-2] is the close an hour ago). Null when the spark is too short
 * or the base is degenerate — no data never becomes a fake 0%.
 */
export function change1hPct(snap: MarketSnapshot): number | null {
  const spark = snap.spark
  if (!Array.isArray(spark) || spark.length < 2) return null
  const base = spark[spark.length - 2]
  if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) return null
  if (typeof snap.last !== 'number' || !Number.isFinite(snap.last)) return null
  return ((snap.last - base) / base) * 100
}

/** "−4.2%" / "+1.3%" — signed, one decimal, typographic minus (matches
 * market-data's formatSignedPct; duplicated because that module is another
 * service's internals, and this string ships to traders verbatim). */
export function formatSignedPct(pct: number): string {
  return `${pct < 0 ? MINUS : '+'}${Math.abs(pct).toFixed(1)}%`
}

/** SERVER-authored pill tag, e.g. "BTC +4.2% 1H". Rendered verbatim. */
export function pulseTag(symbol: string, pct: number): string {
  const base = symbol.split('/')[0] ?? symbol
  return `${base} ${formatSignedPct(pct)} 1H`
}

export type PulseWatcherDeps = {
  /** Abs 1h move (percent) that trips a pulse. Env PULSE_THRESHOLD_PCT. */
  thresholdPct?: number
  /** Minimum quiet time between pulses per session. Env PULSE_COOLDOWN_MS. */
  cooldownMs?: number
  /** Clock override (tests). */
  now?: () => number
}

export type PulseWatcher = {
  /**
   * The tag to emit for this session given the fresh snapshot, or null.
   * Null means: move below threshold, degenerate data, or this session was
   * pulsed within the cooldown window. Stateful per session — keyed by the
   * session OBJECT (WeakMap), so evicted sessions never leak an entry.
   */
  maybeTag(session: object, snap: MarketSnapshot): string | null
}

export function createPulseWatcher(deps: PulseWatcherDeps = {}): PulseWatcher {
  const thresholdPct =
    deps.thresholdPct ?? Number(process.env.PULSE_THRESHOLD_PCT ?? DEFAULT_PULSE_THRESHOLD_PCT)
  const cooldownMs =
    deps.cooldownMs ?? Number(process.env.PULSE_COOLDOWN_MS ?? DEFAULT_PULSE_COOLDOWN_MS)
  const now = deps.now ?? Date.now
  const lastPulse = new WeakMap<object, number>()
  return {
    maybeTag(session, snap) {
      const pct = change1hPct(snap)
      if (pct === null || Math.abs(pct) < thresholdPct) return null
      const prev = lastPulse.get(session)
      if (prev !== undefined && now() - prev < cooldownMs) return null
      lastPulse.set(session, now())
      return pulseTag(snap.symbol, pct)
    },
  }
}
