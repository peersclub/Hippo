/**
 * Live inputs via CCXT against Binance PUBLIC endpoints — no API keys, read
 * only (dev data-source decision, see Build Plan/10 BE Architecture).
 */
import { binance } from 'ccxt'
import type { SnapshotInputs } from './snapshot.js'

/** 13 hourly candles = the 12h window (first close is "12 hours ago"). */
const SPARK_CANDLES = 13

// timeout: CCXT's default is 10s, but our slowest caller aborts at 2.5s
// (gateway) / 3s (intelligence) — a slower Binance answer would burn sockets
// for a response nobody is still waiting for.
const exchange = new binance({ enableRateLimit: true, timeout: 2_000 })

/** "BTC/USDT" → "BTC/USDT:USDT" — funding only exists on the perp market. */
function futuresSymbol(spot: string): string {
  if (spot.includes(':')) return spot
  const quote = spot.split('/')[1]
  return quote ? `${spot}:${quote}` : spot
}

export async function fetchLiveInputs(symbol: string): Promise<SnapshotInputs> {
  const [ticker, ohlcv] = await Promise.all([
    exchange.fetchTicker(symbol), // last price + 24h stats
    exchange.fetchOHLCV(symbol, '1h', undefined, SPARK_CANDLES),
  ])

  const last = ticker.last ?? ticker.close
  if (typeof last !== 'number' || !Number.isFinite(last)) {
    throw new Error(`no last price for ${symbol}`)
  }
  const closes = ohlcv.map((candle) => Number(candle[4])).filter((close) => Number.isFinite(close))
  if (closes.length < 2) throw new Error(`not enough OHLCV closes for ${symbol}`)

  // Funding is best-effort: spot-only symbols or venues without perps just
  // report null and the snapshot degrades gracefully.
  let fundingRate: number | null = null
  const sources = ['BINANCE PUBLIC']
  if (exchange.has.fetchFundingRate) {
    try {
      const funding = await exchange.fetchFundingRate(futuresSymbol(symbol))
      if (typeof funding.fundingRate === 'number' && Number.isFinite(funding.fundingRate)) {
        fundingRate = funding.fundingRate
        sources.push('FUNDING')
      }
    } catch {
      // No perp market for this symbol — funding stays null.
    }
  }

  return { symbol, last, closes, fundingRate, sources }
}
