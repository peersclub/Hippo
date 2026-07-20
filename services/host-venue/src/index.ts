/**
 * Assetworks Exchange boot.
 *
 * Prices come from the shared market-data service (CCXT → Binance PUBLIC, no
 * keys — the same open-source feed the rest of the stack uses), so the price
 * the parasite QUOTES at prepare-time is the price the host FILLS at. Offline,
 * market-data degrades to its recorded fixture and the host keeps working.
 */
import type { ApiKeyRecord } from './hmac.js'
import { buildService } from './service.js'
import { type PriceProvider, VenueStore } from './store.js'
import type { AdminConfig } from './types.js'

const PORT = Number(process.env.PORT ?? 8796)
const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? 'http://localhost:8790'
const UI_USER = process.env.ASSETWORKS_UI_USER ?? 'trader-1'

// The parasite's key resolves to the SAME user the UI trades as → one book.
const API_KEY = process.env.ASSETWORKS_API_KEY ?? 'ak_assetworks_demo'
const SECRET = process.env.ASSETWORKS_SECRET ?? 'sk_assetworks_demo_secret'

const keys = new Map<string, ApiKeyRecord>([[API_KEY, { secret: SECRET, userId: UI_USER }]])

const config: AdminConfig = {
  confirmSurface:
    (process.env.ASSETWORKS_CONFIRM_SURFACE as AdminConfig['confirmSurface']) ?? 'api',
  // Must be >= the parasite reconciler poll interval (2000ms) so a fast fill
  // is observed open→absent rather than timing out to "expired".
  workingWindowMs: Number(process.env.ASSETWORKS_WORKING_WINDOW_MS ?? 2_500),
  feeRate: Number(process.env.ASSETWORKS_FEE_RATE ?? 0.001),
  partialFills: process.env.ASSETWORKS_PARTIAL_FILLS === '1',
}

/** Live price per pair, cached 1s to avoid hammering market-data on each sweep. */
function makePriceProvider(): PriceProvider {
  const cache = new Map<string, { at: number; price: number }>()
  return async (pairName: string) => {
    const hit = cache.get(pairName)
    if (hit && Date.now() - hit.at < 1_000) return hit.price
    const symbol = pairName.replace('-', '/')
    const res = await fetch(`${MARKET_DATA_URL}/v1/snapshot?symbol=${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) throw new Error(`quote unavailable for ${pairName}: ${res.status}`)
    const snap = (await res.json()) as { last: number }
    if (typeof snap.last !== 'number') throw new Error('malformed snapshot')
    cache.set(pairName, { at: Date.now(), price: snap.last })
    return snap.last
  }
}

const store = new VenueStore(makePriceProvider(), config)
const app = buildService({
  store,
  keys,
  adminToken: process.env.ASSETWORKS_ADMIN_TOKEN,
  uiUserId: UI_USER,
  instruments: (process.env.ASSETWORKS_INSTRUMENTS ?? 'BTC/USDT,ETH/USDT,SOL/USDT').split(','),
})

const sweep = setInterval(() => void store.sweep(), 500)
if (typeof sweep.unref === 'function') sweep.unref()

app
  .listen({ port: PORT, host: '::' })
  .then(() =>
    console.log(
      `host-venue (Assetworks Exchange) on :${PORT} — confirm surface: ${config.confirmSurface}`,
    ),
  )
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
