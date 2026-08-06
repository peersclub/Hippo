import { describe, expect, it, vi } from 'vitest'
import { AssetworksVenueAdapter } from '../src/assetworks-venue.js'
import type { FuturesPerpPlan, LifecycleEvent, PrepareRequest } from '../src/types.js'

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
  /** Terminal status returned by /orders/status once the order leaves the book
   *  (50 = CANCELED, 20 = SETTLED). Default 20 keeps the historical fill path. */
  terminalStatus?: number
  /** When set, the host serves /v1/capabilities advertising this perp leverage
   *  bound. Omit it and the endpoint 404s, so the adapter's OFFLINE fallback
   *  capabilities are what get exercised. */
  advertisedMaxLeverage?: number
}) {
  const openSequence = [...(opts.openSequence ?? [])]
  const handoffStates = [...(opts.handoffStates ?? ['placed'])]
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/v1/snapshot'))
      return new Response(JSON.stringify({ last: 61_240 }), { status: 200 })
    if (u.endsWith('/api/v1/trade/orders/status'))
      return new Response(
        JSON.stringify({ status: true, data: { orderStatus: opts.terminalStatus ?? 20 } }),
        { status: 200 },
      )
    if (u.endsWith('/admin/config'))
      return new Response(JSON.stringify({ confirmSurface: opts.surface ?? 'api' }), {
        status: 200,
      })
    if (u.endsWith('/v1/capabilities')) {
      if (opts.advertisedMaxLeverage === undefined)
        return new Response('not found', { status: 404 })
      return new Response(
        JSON.stringify({
          capabilities: {
            spot: { protectiveExits: true },
            futures_perp: {
              maxLeverage: opts.advertisedMaxLeverage,
              marginModes: ['isolated', 'cross'],
              protectiveExits: true,
            },
          },
        }),
        { status: 200 },
      )
    }
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

const filled = (adapter: AssetworksVenueAdapter) => terminal(adapter, 'filled')

const terminal = (adapter: AssetworksVenueAdapter, phase: string) =>
  new Promise<LifecycleEvent>((resolve, reject) => {
    adapter.onEvent((e) => e.phase === phase && resolve(e))
    setTimeout(() => reject(new Error(`no ${phase}`)), 1_500)
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

  it('api surface: a host CANCEL (order gone + terminal CANCELED) reconciles as CANCELLED, not filled', async () => {
    const fetchImpl = makeFetch({
      surface: 'api',
      openSequence: [[ACTIVE], []], // seen open, then gone
      terminalStatus: 50, // CANCELED
    }) as unknown as typeof fetch
    const adapter = new AssetworksVenueAdapter({ ...CREDS, fetchImpl })
    const ticket = await adapter.prepare(req)
    const done = terminal(adapter, 'cancelled')
    await adapter.confirm(ticket.ticketId)
    const ev = await done
    expect(ev.phase).toBe('cancelled')
    expect(ev.statusLine).toMatch(/cancel/i)
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

  it('api surface: emits a working placement ack (with venueOrderId) before the fill', async () => {
    const fetchImpl = makeFetch({
      surface: 'api',
      openSequence: [[ACTIVE], []],
    }) as unknown as typeof fetch
    const adapter = new AssetworksVenueAdapter({ ...CREDS, fetchImpl })
    const events: LifecycleEvent[] = []
    // onEvent is single-handler — one registration records AND resolves.
    const done = new Promise<void>((resolve, reject) => {
      adapter.onEvent((e) => {
        events.push(e)
        if (e.phase === 'filled') resolve()
      })
      setTimeout(() => reject(new Error('no fill')), 1_500)
    })
    const ticket = await adapter.prepare(req)
    await adapter.confirm(ticket.ticketId)
    await done
    expect(events[0]).toMatchObject({
      phase: 'awaiting_confirm',
      stage: 'working',
      venueOrderId: '999',
      cancellable: true,
    })
    expect(events.at(-1)?.phase).toBe('filled')
  })

  it('js_callback surface: waiting copy first, working ack once the host places', async () => {
    const fetchImpl = makeFetch({
      surface: 'js_callback',
      handoffStates: ['pending', 'placed'],
      openSequence: [[ACTIVE], []],
    }) as unknown as typeof fetch
    const adapter = new AssetworksVenueAdapter({ ...CREDS, fetchImpl })
    const events: LifecycleEvent[] = []
    // onEvent is single-handler — one registration records AND resolves.
    const done = new Promise<void>((resolve, reject) => {
      adapter.onEvent((e) => {
        events.push(e)
        if (e.phase === 'filled') resolve()
      })
      setTimeout(() => reject(new Error('no fill')), 1_500)
    })
    const ticket = await adapter.prepare(req)
    await adapter.confirm(ticket.ticketId)
    await done
    // The one surface where "waiting for your confirm" is true — then placed.
    expect(events[0]).toMatchObject({
      phase: 'awaiting_confirm',
      statusLine: 'WAITING FOR YOUR CONFIRM ON THE VENUE',
    })
    expect(events[0]?.stage).toBeUndefined()
    const working = events.find((e) => e.stage === 'working')
    expect(working).toMatchObject({ phase: 'awaiting_confirm', cancellable: true })
  })

  it('partial fills dedupe on filledQty — a poll tick is not news, a changed fill is', async () => {
    const partial = (filledQty: number) => ({ ...ACTIVE, status: 30, filledQty }) // 30 = PARTIAL
    const fetchImpl = makeFetch({
      surface: 'api',
      // same partial state observed twice, then progress, then gone (filled)
      openSequence: [[partial(0.01)], [partial(0.01)], [partial(0.02)], []],
    }) as unknown as typeof fetch
    const adapter = new AssetworksVenueAdapter({ ...CREDS, fetchImpl })
    const events: LifecycleEvent[] = []
    // onEvent is single-handler — one registration records AND resolves.
    const done = new Promise<void>((resolve, reject) => {
      adapter.onEvent((e) => {
        events.push(e)
        if (e.phase === 'filled') resolve()
      })
      setTimeout(() => reject(new Error('no fill')), 1_500)
    })
    const ticket = await adapter.prepare(req)
    await adapter.confirm(ticket.ticketId)
    await done
    const partials = events.filter((e) => e.phase === 'partial')
    expect(partials).toHaveLength(2) // 0.01 once (not twice), then 0.02
    expect(partials[0]).toMatchObject({ stage: 'working', fillPct: 20 })
    expect(partials[1]?.fillPct).toBe(40)
  })

  it('portfolio returns open perp positions + orders only — NOT spot balances', async () => {
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
    // Only the actual (perp) position — spot balances are holdings, not
    // positions, so a fresh wallet's cash/seed BTC must NOT appear here.
    expect(pf.positions).toHaveLength(1)
    expect(pf.positions[0].instrument).toContain('10x LONG')
    expect(pf.positions.some((p) => p.instrument === 'BTC')).toBe(false)
    expect(pf.openOrders).toHaveLength(1)
  })

  it('listOrders maps the host book of record (all statuses) to canonical records', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/api/v1/trade/orders/all')) {
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers['x-signature']).toBeTruthy() // signed read
        return new Response(
          JSON.stringify({
            status: true,
            data: {
              orders: [
                {
                  id: 999,
                  clientOrderId: 't_a',
                  pairName: 'BTC-USDT',
                  qty: 0.05,
                  filledQty: 0.05,
                  rate: 61_240,
                  status: 20, // SETTLED
                  orderType: 0, // buy
                  tradeTypeLabel: 'market',
                  createdAt: 1_753_000_000_000,
                },
                {
                  id: 1000,
                  clientOrderId: 't_b',
                  pairName: 'ETH-USDT',
                  qty: 2,
                  filledQty: 0,
                  rate: 3_100,
                  status: 50, // CANCELED
                  orderType: 1, // sell
                  tradeTypeLabel: 'limit',
                  createdAt: 1_753_000_100_000,
                },
              ],
            },
          }),
          { status: 200 },
        )
      }
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch
    const adapter = new AssetworksVenueAdapter({ ...CREDS, fetchImpl })
    const orders = await adapter.listOrders('p', 'u1')
    expect(orders).toHaveLength(2)
    expect(orders[0]).toMatchObject({
      orderId: 't_a', // clientOrderId (the seam ticketId) is the session-scope key
      symbol: 'BTC/USDT',
      side: 'buy',
      kind: 'MKT',
      status: 'FILLED',
      statusClass: 'filled',
      filledPct: 100,
    })
    expect(orders[1]).toMatchObject({
      orderId: 't_b',
      symbol: 'ETH/USDT',
      side: 'sell',
      kind: 'LMT 3,100',
      price: '3,100',
      statusClass: 'cancelled',
    })
  })

  it('protective exits: validated at prepare (rows), passed on the wire body at confirm', async () => {
    const placedBodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/v1/snapshot'))
        return new Response(JSON.stringify({ last: 61_240 }), { status: 200 })
      if (u.endsWith('/admin/config'))
        return new Response(JSON.stringify({ confirmSurface: 'api' }), { status: 200 })
      if (u.endsWith('/api/v1/trade/orders')) {
        placedBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(
          JSON.stringify({ status: true, data: { orderId: 7, qty: 0.5, rate: 61_240 } }),
          { status: 200 },
        )
      }
      if (u.endsWith('/api/v1/trade/orders/open'))
        return new Response(JSON.stringify({ status: true, data: { orders: [] } }), {
          status: 200,
        })
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch
    const adapter = new AssetworksVenueAdapter({ ...CREDS, fetchImpl })

    const ticket = await adapter.prepareOrder({
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
      stopLossPrice: '55000',
      takeProfitPrice: '70000',
    })
    // Server-authored rows the SDK renders verbatim.
    const rows = new Map(ticket.rows.map((r) => [r.label, r.value]))
    expect(rows.get('Stop loss')).toBe('55,000')
    expect(rows.get('Take profit')).toBe('70,000')

    await adapter.confirm(ticket.ticketId)
    // The placement body carried BOTH protective prices as wire numerics —
    // the host spawns the OCO children from exactly these.
    expect(placedBodies).toHaveLength(1)
    expect(placedBodies[0]).toMatchObject({
      market: 'perp',
      direction: 'long',
      stopLossPrice: 55_000,
      takeProfitPrice: 70_000,
    })
    await adapter.cancel(ticket.ticketId) // stop the reconciler timer
  })

  it('protective exits: nonsense levels are rejected at prepare — nothing reaches the venue', async () => {
    const fetchImpl = makeFetch({ surface: 'api', openSequence: [[]] }) as unknown as typeof fetch
    const adapter = new AssetworksVenueAdapter({ ...CREDS, fetchImpl })
    await expect(
      adapter.prepareOrder({
        capability: 'futures_perp',
        partnerId: 'p',
        userId: 'u1',
        instrument: 'BTC/USDT',
        direction: 'short',
        action: 'open',
        leverage: 5,
        marginMode: 'isolated',
        size: '0.5',
        reduceOnly: false,
        orderType: 'market',
        stopLossPrice: '50000', // below a short's entry — must be ABOVE
      }),
    ).rejects.toThrow(/stop-loss.*above the entry/i)
    // Spot sell can't carry protection.
    await expect(
      adapter.prepare({
        partnerId: 'p',
        userId: 'u1',
        side: 'sell',
        size: '0.1',
        instrument: 'BTC/USDT',
        orderType: 'market',
        takeProfitPrice: '70000',
      }),
    ).rejects.toThrow(/buy orders only/i)
  })
})

/**
 * The leverage bound must be the one capabilities() ADVERTISES, never a second
 * hardcoded number. The adapter used to reject `leverage > 50` outright while
 * capabilities() served the host's live maxLeverage: raise the host to 100, ask
 * for 75, and the adapter threw → seam 502 → the gateway offered the trader a
 * "Try again" that could never succeed.
 *
 * Why the existing suite never caught it: every other perp case here uses
 * leverage 5 or 10, both comfortably under the hardcoded 50, so the advertised
 * and enforced bounds were never asked to disagree.
 */
describe('AssetworksVenueAdapter — leverage bound follows the advertised capability', () => {
  const perpPlan = (leverage: number): FuturesPerpPlan => ({
    capability: 'futures_perp',
    partnerId: 'p',
    userId: 'u1',
    instrument: 'BTC/USDT',
    direction: 'long',
    action: 'open',
    leverage,
    marginMode: 'isolated',
    size: '0.5',
    reduceOnly: false,
    orderType: 'market',
  })

  const adapterFor = (advertisedMaxLeverage?: number) =>
    new AssetworksVenueAdapter({
      ...CREDS,
      fetchImpl: makeFetch({
        surface: 'api',
        openSequence: [[]],
        ...(advertisedMaxLeverage !== undefined ? { advertisedMaxLeverage } : {}),
      }) as unknown as typeof fetch,
    })

  it('host advertising 100× accepts 75× and rejects 101× with the real bound in the message', async () => {
    const adapter = adapterFor(100)
    expect((await adapter.capabilities()).futures_perp?.maxLeverage).toBe(100)

    // 75× is inside what the host advertises — the old hardcoded `> 50` threw here.
    const ticket = await adapter.prepareOrder(perpPlan(75))
    expect(ticket.sideLabel).toContain('75×')
    expect(ticket.rows.find((r) => r.label === 'Leverage')?.value).toBe('75×')

    // Over the advertised bound: rejected, and the copy names the number the
    // trader can actually use rather than a stale 50.
    await expect(adapter.prepareOrder(perpPlan(101))).rejects.toThrow(/100/)
    await expect(adapter.prepareOrder(perpPlan(101))).rejects.toThrow('venue max 100×')
  })

  it('host advertising 10× rejects 40× — the bound follows the host DOWN as well as up', async () => {
    const adapter = adapterFor(10)
    expect((await adapter.capabilities()).futures_perp?.maxLeverage).toBe(10)
    await expect(adapter.prepareOrder(perpPlan(40))).rejects.toThrow('venue max 10×')
    await expect(adapter.prepareOrder(perpPlan(10))).resolves.toBeTruthy()
  })

  it('offline: the enforced bound IS the fallback capabilities constant — one number, not two', async () => {
    // /v1/capabilities 404s, so capabilities() serves the offline fallback and
    // prepareFutures must enforce exactly that value.
    const adapter = adapterFor()
    const fallback = (await adapter.capabilities()).futures_perp?.maxLeverage
    expect(fallback).toBe(50)
    if (fallback === undefined) throw new Error('fallback capabilities must advertise maxLeverage')
    await expect(adapter.prepareOrder(perpPlan(fallback))).resolves.toBeTruthy()
    await expect(adapter.prepareOrder(perpPlan(fallback + 1))).rejects.toThrow(
      `venue max ${fallback}×`,
    )
  })
})
