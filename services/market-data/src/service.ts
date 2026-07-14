/**
 * Snapshot orchestration: cache → fixtures mode → live CCXT → fixture
 * fallback. Offline dev must always work — a dead network serves the
 * recorded fixture with sources: ["FIXTURE"] instead of failing.
 */
import { fetchLiveInputs } from './live.js'
import { buildSnapshot, loadFixtureInputs, type Snapshot } from './snapshot.js'

/**
 * In-memory cache, 10s TTL per symbol. This mirrors the production
 * answer-cache concept (Redis, TTL scaled by volatility) — one upstream
 * fetch serves every session asking about the same symbol inside the window.
 */
const CACHE_TTL_MS = 10_000
const cache = new Map<string, { expiresAt: number; snapshot: Snapshot }>()

export type GetSnapshotOptions = {
  /** Serve recorded fixtures instead of hitting the exchange (FIXTURES=1). */
  fixtures?: boolean
}

export async function getSnapshot(
  symbol: string,
  { fixtures = false }: GetSnapshotOptions = {},
): Promise<Snapshot> {
  // Fixture mode is uncached: rebuilding is free and asOfIso must be stamped
  // at request time.
  if (fixtures) {
    const inputs = loadFixtureInputs(symbol)
    if (!inputs) throw new Error(`no fixture recorded for ${symbol}`)
    return buildSnapshot(inputs)
  }

  const hit = cache.get(symbol)
  if (hit && hit.expiresAt > Date.now()) return hit.snapshot

  let snapshot: Snapshot
  try {
    snapshot = buildSnapshot(await fetchLiveInputs(symbol))
  } catch (err) {
    // Offline / exchange hiccup: fall back to the recorded fixture so dev
    // flows keep working, labelled honestly as FIXTURE data.
    const inputs = loadFixtureInputs(symbol)
    if (!inputs) throw err
    return buildSnapshot(inputs)
  }

  cache.set(symbol, { expiresAt: Date.now() + CACHE_TTL_MS, snapshot })
  return snapshot
}
