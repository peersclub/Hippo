/**
 * Market-data service — normalized snapshot API with as-of stamps.
 * Dev data source: CCXT against Binance public endpoints (no keys);
 * FIXTURES=1 serves recorded fixtures for tests and offline work.
 * See Build Plan/10 BE Architecture — market-data service.
 */
import Fastify from 'fastify'
import { getSnapshot } from './service.js'

const PORT = Number(process.env.PORT ?? 8790)
const FIXTURES = process.env.FIXTURES === '1'

/** Spot "BTC/USDT" or perp "BTC/USDT:USDT" — everything callers send.
 * Rejecting the rest keeps arbitrary strings out of the snapshot cache and
 * off the CCXT rate-limit queue. */
const SYMBOL_RE = /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}(:[A-Z0-9]{2,10})?$/

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })

app.get('/v1/snapshot', async (req, reply) => {
  const { symbol = 'BTC/USDT' } = req.query as { symbol?: string }
  if (!SYMBOL_RE.test(symbol)) {
    reply.code(400)
    return { error: 'invalid symbol', symbol }
  }
  try {
    return await getSnapshot(symbol, { fixtures: FIXTURES, log: req.log })
  } catch (err) {
    req.log.error({ err, symbol }, 'snapshot unavailable')
    reply.code(502)
    return { error: 'snapshot unavailable', symbol }
  }
})

app.get('/health', async () => ({
  ok: true,
  service: 'market-data',
  mode: FIXTURES ? 'fixtures' : 'live',
}))

await app.listen({ port: PORT, host: '::' })
console.log(`market-data on :${PORT} — ${FIXTURES ? 'fixture' : 'live (CCXT binance)'} mode`)
