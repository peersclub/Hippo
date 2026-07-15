/**
 * Client for the market-data service (services/market-data) + display
 * formatting shared by briefs and tickets. Display strings are formatted
 * server-side: the SDK draws, it never computes money.
 */

const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? 'http://localhost:8790'
const SNAPSHOT_TIMEOUT_MS = 2_500

/** Shape served by GET /v1/snapshot (services/market-data/src/snapshot.ts). */
export type MarketSnapshot = {
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

export interface MarketClient {
  /** Rejects on timeout, network error or non-2xx. */
  snapshot(symbol: string): Promise<MarketSnapshot>
}

function isSnapshot(x: unknown): x is MarketSnapshot {
  const s = x as MarketSnapshot
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.last === 'number' &&
    typeof s.lastDisplay === 'string' &&
    typeof s.change12hPct === 'number' &&
    typeof s.change12hDisplay === 'string' &&
    Array.isArray(s.spark) &&
    s.spark.length >= 2 &&
    typeof s.asOfIso === 'string'
  )
}

export function createMarketClient(baseUrl = MARKET_DATA_URL): MarketClient {
  return {
    async snapshot(symbol) {
      const url = `${baseUrl}/v1/snapshot?symbol=${encodeURIComponent(symbol)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`market-data ${res.status} for ${symbol}`)
      const snap: unknown = await res.json()
      if (!isSnapshot(snap)) throw new Error(`market-data returned a malformed snapshot`)
      return snap
    },
  }
}

/** "AS OF 14:32:05 IST" — wall clock formatted in Asia/Kolkata. */
export function asOfDisplay(iso: string): string {
  const hms = new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
  })
  return `AS OF ${hms} IST`
}

/** "updated 6 min ago" for the CACHED badge's age line. */
export function cacheAgeDisplay(iso: string, now = Date.now()): string {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'updated just now'
  if (mins < 60) return `updated ${mins} min ago`
  return `updated ${Math.floor(mins / 60)} h ago`
}

/** "61,240" for large prices, more precision for sub-dollar assets. */
export function formatPrice(n: number): string {
  const maximumFractionDigits = n >= 1000 ? 0 : n >= 1 ? 2 : 4
  return n.toLocaleString('en-US', { maximumFractionDigits })
}

/** Fixed 2-decimal amount for quote-currency costs/fees, e.g. "3,068.78". */
export function formatAmount(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Asset mentions we resolve to a tradable symbol when the intelligence
// service didn't hand us one. Order matters only for full names → tickers.
const ASSET_ALIASES: ReadonlyArray<[RegExp, string]> = [
  [/\bbitcoin\b/, 'BTC'],
  [/\bethereum\b/, 'ETH'],
  [/\bsolana\b/, 'SOL'],
  [/\bcardano\b/, 'ADA'],
  [/\bdogecoin\b/, 'DOGE'],
  [/\bripple\b/, 'XRP'],
  [
    /\b(btc|eth|sol|ada|xrp|doge|bnb|dot|ltc|link|avax|shib|trx|uni|atom|near|apt|arb|op|pepe|sui|ton|matic)\b/,
    '',
  ],
]

/** Best-effort symbol from free text; BTC/USDT when nothing matches. */
export function symbolFromText(text: string): string {
  const t = text.toLowerCase()
  for (const [re, ticker] of ASSET_ALIASES) {
    const m = t.match(re)
    if (m) return `${(ticker || (m[1] ?? m[0])).toUpperCase()}/USDT`
  }
  return 'BTC/USDT'
}
