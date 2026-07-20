import { describe, expect, it, vi } from 'vitest'
import { AssetworksVenueAdapter } from '../src/assetworks-venue.js'
import type { LifecycleEvent, PrepareRequest } from '../src/types.js'

const CREDS = {
  apiKey: 'aw-key',
  secret: 'aw-secret',
  baseUrl: 'https://aw.test',
  marketDataUrl: 'http://market.test',
  pollIntervalMs: 5,
  pollTimeoutMs: 2_000,
}
const req: PrepareRequest = {
  partnerId: 'p',
  userId: 'u1',
  side: 'buy',
  size: '0.05',
  instrument: 'BTC/USDT',
  orderType: 'market',
}

/** Programmable Assetworks host + market-data double. `openSequence` is consumed
 *  one entry per open-orders poll to script the active→absent transition. */
function makeFetch(opts: {
  surface?: 'api' | 'js_callback'
  openSequence?: Array<Array<Record<string, unknown>>>
  handoffStates?: string[]
}) {
  const openSequence = [...(opts.openSequence ?? [])]
  const handoffStates = [...(opts.handoffStates ?? ['placed'])]
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/v1/snapshot'))
      return new Response(JSON.stringify({ last: 61_240 }), { status: 200 })
    if (u.endsWith('/admin/config'))
      return new Response(JSON.stringify({ confirmSurface: opts.surface ?? 'api' }), {
        status: 200,
      })
    if (u.endsWith('/api/v1/trade/orders')) {
      // The signature must be present and the body byte-identical to what was signed.
      const headers = (init?.headers ?? {}) as Record<string, string>
      expect(headers['x-signature']).toBeTruthy()
      return new Response(
        JSON.stringify({ status: true, data: { orderId: 999, qty: 0.05, rate: 61_240 } }),
        { status: 200 },
      )
    }
    if (u.endsWith('/api/v1/trade/handoff'))
      return new Response(JSON.stringify({ status: true, data: { state: 'pending' } }), {
        status: 200,
      })
    if (u.endsWith('/api/v1/trade/handoff/status')) {
      const state = handoffStates.length > 1 ? handoffStates.shift() : handoffStates[0]
      return new Response(JSON.stringify({ status: true, data: { state, venueOrderId: 999 } }), {
        status: 200,
      })
    }
    if (u.endsWith('/api/v1/trade/orders/open')) {
      const orders = openSequence.length > 1 ? openSequence.shift() : (openSequence[0] ?? [])
      return new Response(JSON.stringify({ status: true, data: { orders } }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

const filled = (adapter: AssetworksVenueAdapter) =>
  new Promise<LifecycleEvent>((resolve, reject) => {
    adapter.onEvent((e) => e.phase === 'filled' && resolve(e))
    setTimeout(() => reject(new Error('no fill')), 1_500)
  })

const ACTIVE = {
  id: 999,
  pairName: 'BTC-USDT',
  qty: 0.05,
  filledQty: 0,
  remainingQty: 0.05,
  rate: 61_240,
  status: 10,
  orderType: 0,
}

describe('AssetworksVenueAdapter', () => {
  it('api surface: signs, places, reconciles open→absent as FILLED', async () => {
    const fetchImpl = makeFetch({
      surface: 'api',
      openSequence: [[ACTIVE], []],
    }) as unknown as typeof fetch
    const adapter = new AssetworksVenueAdapter({ ...CREDS, fetchImpl })
    const ticket = await adapter.prepare(req)
    const done = filled(adapter)
    await adapter.confirm(ticket.ticketId)
    const ev = await done
    expect(ev.phase).toBe('filled')
    expect(ev.venueOrderId).toBe('999')
  })

  it('js_callback surface: hands off (no direct place), then reconciles once host places', async () => {
    const fetchImpl = makeFetch({
      surface: 'js_callback',
      handoffStates: ['pending', 'placed'],
      openSequence: [[ACTIVE], []],
    }) as unknown as typeof fetch
    const calls: string[] = []
    const wrapped = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url))
      return fetchImpl(url as never, init as never)
    }) as unknown as typeof fetch
    const adapter = new AssetworksVenueAdapter({ ...CREDS, fetchImpl: wrapped })
    const ticket = await adapter.prepare(req)
    const done = filled(adapter)
    await adapter.confirm(ticket.ticketId)
    await done
    // The direct place endpoint must NOT have been hit — the host placed it.
    expect(calls.some((u) => u.endsWith('/api/v1/trade/handoff'))).toBe(true)
    expect(calls.some((u) => u.endsWith('/api/v1/trade/orders'))).toBe(false)
  })

  it('portfolio merges spot balances, perp positions and open orders', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/balance'))
        return new Response(
          JSON.stringify({ status: true, data: [{ currencyName: 'BTC', amount: 0.3 }] }),
          { status: 200 },
        )
      if (u.endsWith('/positions'))
        return new Response(
          JSON.stringify({
            status: true,
            data: [
              {
                pairName: 'BTC-USDT',
                direction: 'long',
                size: 1,
                entry: 60000,
                leverage: 10,
                liquidation: 54000,
              },
            ],
          }),
          { status: 200 },
        )
      if (u.endsWith('/open'))
        return new Response(JSON.stringify({ status: true, data: { orders: [ACTIVE] } }), {
          status: 200,
        })
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch
    const adapter = new AssetworksVenueAdapter({ ...CREDS, fetchImpl })
    const pf = await adapter.portfolio('p', 'u1')
    expect(pf.positions.some((p) => p.instrument.includes('10x LONG'))).toBe(true)
    expect(pf.positions.some((p) => p.instrument === 'BTC')).toBe(true)
    expect(pf.openOrders).toHaveLength(1)
  })
})
