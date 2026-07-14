/**
 * Live market data for the research brief. Best-effort by design: the golden
 * conversation must never break, so any failure (service down, slow, bad
 * payload) silently falls back to the scripted hard-coded brief.
 */
import type { FrameDraft } from './golden.js'

const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? 'http://localhost:8790'
const FETCH_TIMEOUT_MS = 1500

type Snapshot = {
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

/** "AS OF 14:32:05 IST" — wall-clock formatted in Asia/Kolkata. */
function asOfDisplay(iso: string): string {
  const hms = new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
  })
  return `AS OF ${hms} IST`
}

function isSnapshot(x: unknown): x is Snapshot {
  const s = x as Snapshot
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.last === 'number' &&
    typeof s.lastDisplay === 'string' &&
    typeof s.change12hPct === 'number' &&
    typeof s.change12hDisplay === 'string' &&
    Array.isArray(s.spark) &&
    typeof s.asOfIso === 'string' &&
    Array.isArray(s.sources)
  )
}

/** Template live numbers into a scripted research_brief draft. */
function templateBrief(base: FrameDraft, snap: Snapshot): FrameDraft {
  const direction = snap.change12hPct < 0 ? 'down' : 'up'
  // Reuse the service-formatted display (sign stripped) so the headline and
  // the 12H stat cell can never disagree on rounding.
  const magnitude = snap.change12hDisplay.replace(/^[+−-]/, '')

  const stats: Array<{ k: string; v: string; tone: string }> = [
    { k: 'LAST', v: snap.lastDisplay, tone: 'neutral' },
    { k: '12H', v: snap.change12hDisplay, tone: snap.change12hPct < 0 ? 'neg' : 'pos' },
  ]
  if (snap.fundingDisplay !== null && snap.fundingRate !== null) {
    stats.push({ k: 'FUNDING', v: snap.fundingDisplay, tone: snap.fundingRate < 0 ? 'neg' : 'pos' })
  }

  const baseLiveBar = (base.liveBar ?? {}) as Record<string, unknown>

  return {
    ...base,
    headline: `BTC is ${direction} ${magnitude} over 12 hours`,
    stats,
    spark: {
      points: snap.spark,
      captionLeft: `${snap.symbol} · 12H`,
      captionRight: `$${snap.lastDisplay}`,
    },
    sources: snap.sources,
    liveBar: {
      ...baseLiveBar,
      asOf: asOfDisplay(snap.asOfIso),
      asOfIso: snap.asOfIso,
      cached: false,
    },
  }
}

/**
 * Fetch a live snapshot and template it into the brief. Resolves to the
 * untouched base draft on any failure — never rejects.
 */
export async function withLiveMarket(base: FrameDraft): Promise<FrameDraft> {
  try {
    const url = `${MARKET_DATA_URL}/v1/snapshot?symbol=${encodeURIComponent('BTC/USDT')}`
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return base
    const snap: unknown = await res.json()
    if (!isSnapshot(snap)) return base
    return templateBrief(base, snap)
  } catch {
    return base
  }
}
