/**
 * Capability framework — venue capability discovery, the plan-tagged prepare
 * path (spot/futures_perp/options), and capability gating on the HTTP surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KoinbxVenueAdapter } from '../src/koinbx-venue.js'
import { buildService } from '../src/service.js'
import { SimVenueAdapter } from '../src/sim-venue.js'
import type { FuturesPerpPlan } from '../src/types.js'

const TOKEN = 'tok'
const HDR = { 'x-hippo-internal-token': TOKEN, 'content-type': 'application/json' }

const perpPlan: FuturesPerpPlan = {
  capability: 'futures_perp',
  partnerId: 'p',
  userId: 'u1',
  instrument: 'BTC/USDT',
  direction: 'long',
  action: 'open',
  leverage: 10,
  marginMode: 'isolated',
  size: '0.5',
  reduceOnly: false,
  orderType: 'market',
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url).includes('/v1/snapshot'))
        return new Response(JSON.stringify({ last: 60_000 }), { status: 200 })
      return new Response('not found', { status: 404 })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('capability framework', () => {
  it('sim advertises all three capabilities; koinbx only spot', async () => {
    expect(Object.keys(await new SimVenueAdapter().capabilities()).sort()).toEqual([
      'futures_perp',
      'options',
      'spot',
    ])
    const kbx = new KoinbxVenueAdapter({ apiKey: 'k', secret: 's', baseUrl: 'https://kbx.test' })
    expect(await kbx.capabilities()).toEqual({ spot: {} })
  })

  it('sim prepareOrder builds a perp ticket with a liquidation row', async () => {
    const ticket = await new SimVenueAdapter().prepareOrder(perpPlan)
    expect(ticket.capability).toBe('futures_perp')
    expect(ticket.sideLabel).toContain('OPEN LONG 10×')
    const labels = ticket.rows.map((r) => r.label)
    expect(labels).toContain('Est. liquidation price')
    // long @60000, 10× → liq ≈ 60000×(1−1/10) = 54,000
    expect(ticket.rows.find((r) => r.label === 'Est. liquidation price')?.value).toBe('54,000')
  })

  it('HTTP: /v1/capabilities and a gated /v1/prepare-order', async () => {
    const app = buildService(new SimVenueAdapter(), { internalToken: TOKEN })
    const caps = await app.inject({ method: 'GET', url: '/v1/capabilities', headers: HDR })
    expect(caps.json().futures_perp.maxLeverage).toBe(100)

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/prepare-order',
      headers: HDR,
      payload: JSON.stringify(perpPlan),
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().capability).toBe('futures_perp')
  })

  it('HTTP: a perp plan is rejected (422) on a spot-only venue', async () => {
    const kbx = new KoinbxVenueAdapter({ apiKey: 'k', secret: 's', baseUrl: 'https://kbx.test' })
    const app = buildService(kbx, { internalToken: TOKEN })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prepare-order',
      headers: HDR,
      payload: JSON.stringify(perpPlan),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toMatch(/not supported/i)
  })
})
