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
/** Negative TTL while live is failing: an outage costs one failed upstream
 * attempt per window, not one per request (the fixture fallback is local). */
const FIXTURE_TTL_MS = 5_000
/** Cache/in-flight maps are keyed by caller-supplied strings — cap them so
 * arbitrary ?symbol= values can't grow memory without bound. */
const MAX_CACHE_ENTRIES = 500

const cache = new Map<string, { expiresAt: number; snapshot: Snapshot }>()
/** Single-flight: concurrent misses for one symbol share one upstream fetch
 * (the correlated "why is BTC down" spike is the load pattern this exists
 * for — without it every queued CCXT call compounds past callers' budgets). */
const inflight = new Map<string, Promise<Snapshot>>()

/** True while the last live fetch for the symbol failed — the transition into
 * and out of fixture-serving is logged exactly once per episode. */
const servingFixture = new Set<string>()

type Log = {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
}

export type GetSnapshotOptions = {
  /** Serve recorded fixtures instead of hitting the exchange (FIXTURES=1). */
  fixtures?: boolean
  /** Operator visibility for live→fixture degradation; silent when absent. */
  log?: Log
}

function remember(symbol: string, snapshot: Snapshot, ttlMs: number): void {
  if (!cache.has(symbol) && cache.size >= MAX_CACHE_ENTRIES) {
    // Drop the oldest entry (Map preserves insertion order) — plain FIFO is
    // enough: real traffic concentrates on a handful of listed symbols.
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(symbol, { expiresAt: Date.now() + ttlMs, snapshot })
}

async function fetchAndCache(symbol: string, log?: Log): Promise<Snapshot> {
  let snapshot: Snapshot
  try {
    snapshot = buildSnapshot(await fetchLiveInputs(symbol))
  } catch (err) {
    // Offline / exchange hiccup: fall back to the recorded fixture so dev
    // flows keep working, labelled honestly as FIXTURE data.
    const inputs = loadFixtureInputs(symbol)
    if (!inputs) throw err
    if (!servingFixture.has(symbol)) {
      servingFixture.add(symbol)
      log?.warn({ err, symbol }, 'live fetch failed — serving FIXTURE data')
    }
    const fixture = buildSnapshot(inputs)
    remember(symbol, fixture, FIXTURE_TTL_MS)
    return fixture
  }

  if (servingFixture.delete(symbol)) {
    log?.info({ symbol }, 'live fetch recovered — FIXTURE fallback over')
  }
  remember(symbol, snapshot, CACHE_TTL_MS)
  return snapshot
}

export async function getSnapshot(
  symbol: string,
  { fixtures = false, log }: GetSnapshotOptions = {},
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

  const pending = inflight.get(symbol)
  if (pending) return pending

  const fetching = fetchAndCache(symbol, log).finally(() => inflight.delete(symbol))
  inflight.set(symbol, fetching)
  return fetching
}
