/**
 * Snapshot builder — a pure module. Everything here is deterministic given its
 * inputs, so tests exercise the full shaping/formatting path without a server
 * or a network. Display strings are formatted here, server-side: the SDK
 * draws, it never computes money.
 */
import { readFileSync } from 'node:fs'

/** Typographic minus (U+2212) — matches the prototype's stat cells. */
const MINUS = '−'

export type SnapshotInputs = {
  symbol: string
  /** Last traded price. */
  last: number
  /** Hourly closes, oldest → newest. 13 candles span the 12h window. */
  closes: number[]
  /** Perp funding rate as a fraction (e.g. -0.00008), null where unsupported. */
  fundingRate: number | null
  /** Provenance labels, e.g. ["BINANCE PUBLIC", "FUNDING"] or ["FIXTURE"]. */
  sources: string[]
}

export type Snapshot = {
  symbol: string
  last: number
  lastDisplay: string
  change12hPct: number
  change12hDisplay: string
  fundingRate: number | null
  fundingDisplay: string | null
  spark: number[]
  asOfIso: string
  sources: string[]
}

/** "61,240" for large prices, more precision for sub-dollar assets. */
export function formatPrice(n: number): string {
  const maximumFractionDigits = n >= 1000 ? 0 : n >= 1 ? 2 : 4
  return n.toLocaleString('en-US', { maximumFractionDigits })
}

/** "−4.2%" / "+1.3%" — signed, one decimal, typographic minus. */
export function formatSignedPct(pct: number, decimals = 1): string {
  const abs = Math.abs(pct).toFixed(decimals)
  return `${pct < 0 ? MINUS : '+'}${abs}%`
}

/** Funding rates are tiny fractions; show as signed percent to 3 decimals. */
export function formatFunding(rate: number): string {
  return formatSignedPct(rate * 100, 3)
}

export function buildSnapshot(inputs: SnapshotInputs, asOf: Date = new Date()): Snapshot {
  const { symbol, last, closes, fundingRate, sources } = inputs
  if (closes.length < 2)
    throw new Error(`need at least 2 closes for ${symbol}, got ${closes.length}`)

  // 12h change: last price vs the close 12 hours ago (first of the 13 candles).
  const base = closes[0] as number
  const change12hPct = ((last - base) / base) * 100

  return {
    symbol,
    last,
    lastDisplay: formatPrice(last),
    change12hPct: Math.round(change12hPct * 100) / 100,
    change12hDisplay: formatSignedPct(change12hPct),
    fundingRate,
    fundingDisplay: fundingRate === null ? null : formatFunding(fundingRate),
    spark: closes,
    asOfIso: asOf.toISOString(),
    sources,
  }
}

/** "BTC/USDT" → "btc-usdt" (futures "BTC/USDT:USDT" → "btc-usdt-usdt"). */
function fixtureSlug(symbol: string): string {
  return symbol.toLowerCase().replace(/[/:]/g, '-')
}

/**
 * Load recorded inputs for a symbol from fixtures/. Returns null when no
 * fixture exists. Sources are stamped ["FIXTURE"] so downstream consumers can
 * label the provenance honestly.
 */
export function loadFixtureInputs(symbol: string): SnapshotInputs | null {
  const url = new URL(`../fixtures/${fixtureSlug(symbol)}.json`, import.meta.url)
  let raw: string
  try {
    raw = readFileSync(url, 'utf8')
  } catch {
    return null
  }
  const data = JSON.parse(raw) as Omit<SnapshotInputs, 'sources'>
  return { ...data, sources: ['FIXTURE'] }
}
