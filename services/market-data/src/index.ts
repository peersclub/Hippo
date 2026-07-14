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

const app = Fastify({ logger: { level: 'info' } })

app.get('/v1/snapshot', async (req, reply) => {
  const { symbol = 'BTC/USDT' } = req.query as { symbol?: string }
  try {
    return await getSnapshot(symbol, { fixtures: FIXTURES })
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

await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`market-data on :${PORT} — ${FIXTURES ? 'fixture' : 'live (CCXT binance)'} mode`)
