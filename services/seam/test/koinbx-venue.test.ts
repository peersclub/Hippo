import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { KoinbxVenueAdapter } from '../src/koinbx-venue.js'
import type { LifecycleEvent, PrepareRequest } from '../src/types.js'

const CREDS = {
  apiKey: 'kbx-key',
  secret: 'kbx-secret',
  baseUrl: 'https://api.koinbx.test',
  marketDataUrl: 'http://market.test',
  pollIntervalMs: 5,
}

const prepareReq: PrepareRequest = {
  partnerId: 'koinbx-dev',
  userId: 'u1',
  side: 'buy',
  size: '0.05',
  instrument: 'BTC/USDT',
  orderType: 'market',
}

type Captured = { url: string; init?: RequestInit }

/**
 * Programmable KoinBX + market-data double. `openSequence` is consumed one
 * entry per open-orders poll so a test can script active → absent transitions.
 */
function makeFetch(opts: {
  openSequence?: Array<Array<Record<string, unknown>>>
  createOk?: boolean
  captured?: Captured[]
}) {
  const openSequence = [...(opts.openSequence ?? [])]
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    opts.captured?.push({ url: u, init })
    if (u.includes('/v1/snapshot'))
      return new Response(JSON.stringify({ last: 61_240 }), { status: 200 })
    if (u.endsWith('/api/v1/trade/orders'))
      return new Response(
        JSON.stringify(
          opts.createOk === false
            ? { status: false }
            : { status: true, data: { orderId: 999, qty: 0.05, rate: 61_240 } },
        ),
        { status: 200 },
      )
    if (u.endsWith('/api/v1/trade/orders/cancel'))
      return new Response(JSON.stringify({ status: true }), { status: 200 })
    if (u.endsWith('/api/v1/trade/orders/open')) {
      const orders = openSequence.length > 1 ? openSequence.shift() : (openSequence[0] ?? [])
      return new Response(JSON.stringify({ status: true, data: { orders } }), { status: 200 })
    }
    if (u.endsWith('/api/v1/trade/balance'))
      return new Response(
        JSON.stringify({
          status: true,
          data: [
            { currencyName: 'BTC', amount: '0.31' },
            { currencyName: 'USDT', amount: '5000' },
            { currencyName: 'ETH', amount: '0' },
          ],
        }),
        { status: 200 },
      )
    return new Response('not found', { status: 404 })
  })
}

describe('KoinbxVenueAdapter — prepare', () => {
  it('builds a market ticket from a live quote, no order placed', async () => {
    const captured: Captured[] = []
    const fetchImpl = makeFetch({ captured })
    const a = new KoinbxVenueAdapter({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch })
    const ticket = await a.prepare(prepareReq)

    expect(ticket.ticketId).toMatch(/^t_/)
    expect(ticket.sideLabel).toBe('BUY · MKT')
    expect(ticket.rows.map((r) => r.label)).toEqual([
      'Instrument',
      'Size',
      'Est. price',
      'Est. value',
    ])
    expect(ticket.rows[3]?.value).toBe('3,062.00 USDT') // 0.05 × 61,240
    // prepare must not touch the order endpoint
    expect(captured.some((c) => c.url.endsWith('/api/v1/trade/orders'))).toBe(false)
  })

  it('limit orders use the limit price and skip the quote call', async () => {
    const captured: Captured[] = []
    const fetchImpl = makeFetch({ captured })
    const a = new KoinbxVenueAdapter({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch })
    const ticket = await a.prepare({ ...prepareReq, orderType: 'limit', limitPrice: '60000' })

    expect(ticket.sideLabel).toBe('BUY · LMT')
    expect(ticket.rows[2]).toEqual({ label: 'Limit price', value: '60,000' })
    expect(captured.some((c) => c.url.includes('/v1/snapshot'))).toBe(false)
  })

  it('rejects nonsense sizes before any network call', async () => {
    const a = new KoinbxVenueAdapter({
      ...CREDS,
      fetchImpl: makeFetch({}) as unknown as typeof fetch,
    })
    await expect(a.prepare({ ...prepareReq, size: '-3' })).rejects.toThrow('invalid order size')
  })
})

describe('KoinbxVenueAdapter — confirm & HMAC', () => {
  it('places a signed order with correct headers, body and pair mapping', async () => {
    const captured: Captured[] = []
    const fetchImpl = makeFetch({ captured, openSequence: [[]] })
    const a = new KoinbxVenueAdapter({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch })
    const ticket = await a.prepare(prepareReq)
    await a.confirm(ticket.ticketId)

    const create = captured.find((c) => c.url.endsWith('/api/v1/trade/orders'))
    expect(create).toBeDefined()
    const headers = create?.init?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('kbx-key')
    expect(typeof headers['x-timestamp']).toBe('string')

    // Signature contract: hex(HMAC-SHA256(bodyJSON + timestamp, secret)).
    const bodyJson = String(create?.init?.body)
    const expected = createHmac('sha256', 'kbx-secret')
      .update(bodyJson + headers['x-timestamp'])
      .digest('hex')
    expect(headers['x-signature']).toBe(expected)

    const body = JSON.parse(bodyJson) as Record<string, unknown>
    expect(body).toMatchObject({
      pairName: 'BTC-USDT', // canonical BTC/USDT → dash form
      orderType: 0, // buy
      tradeType: 20, // MarketValue
      qty: 0.05,
      rate: 61_240,
    })
    expect(body.marketOrderAmount).toBeCloseTo(0.05 * 61_240)
  })

  it('throws for confirm surfaces that are Open Decision #6', async () => {
    const a = new KoinbxVenueAdapter({
      ...CREDS,
      confirmSurface: 'deep_link',
      fetchImpl: makeFetch({}) as unknown as typeof fetch,
    })
    const ticket = await a.prepare(prepareReq)
    await expect(a.confirm(ticket.ticketId)).rejects.toThrow(/Open Decision #6/)
  })

  it('surfaces a venue placement rejection', async () => {
    const a = new KoinbxVenueAdapter({
      ...CREDS,
      fetchImpl: makeFetch({ createOk: false }) as unknown as typeof fetch,
    })
    const ticket = await a.prepare(prepareReq)
    await expect(a.confirm(ticket.ticketId)).rejects.toThrow('rejected the order')
  })
})

describe('KoinbxVenueAdapter — poll reconciler', () => {
  it('emits partial while open, then filled once the order drops out', async () => {
    const events: LifecycleEvent[] = []
    const order = {
      id: 999,
      pairName: 'BTC-USDT',
      qty: 0.05,
      filledQty: 0.02,
      remainingQty: 0.03,
      rate: 61_240,
      status: 'Partial',
      orderType: 0,
    }
    // poll #1 partial, poll #2 still partial, poll #3 gone → filled
    const fetchImpl = makeFetch({ openSequence: [[order], [order], []] })
    const a = new KoinbxVenueAdapter({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch })
    a.onEvent((e) => events.push(e))

    const ticket = await a.prepare(prepareReq)
    await a.confirm(ticket.ticketId)
    await vi.waitFor(() => expect(events.some((e) => e.phase === 'filled')).toBe(true), {
      timeout: 500,
    })

    expect(events.some((e) => e.phase === 'partial')).toBe(true)
    const filled = events.find((e) => e.phase === 'filled')
    expect(filled?.venueOrderId).toBe('999')
    expect(filled?.statusLine).toBe('FILLED')
  })
})

describe('KoinbxVenueAdapter — cancel & portfolio', () => {
  it('cancels venue-side after confirm and locally before it', async () => {
    const captured: Captured[] = []
    const fetchImpl = makeFetch({
      captured,
      openSequence: [
        [
          {
            id: 999,
            pairName: 'BTC-USDT',
            qty: 0.05,
            filledQty: 0,
            remainingQty: 0.05,
            rate: 61_240,
            status: 'Active',
            orderType: 0,
          },
        ],
      ],
    })
    const a = new KoinbxVenueAdapter({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch })

    // pre-confirm: local drop, no venue cancel call
    const t1 = await a.prepare(prepareReq)
    expect(await a.cancel(t1.ticketId)).toBe(true)
    expect(captured.some((c) => c.url.endsWith('/orders/cancel'))).toBe(false)

    // post-confirm: hits the venue cancel endpoint
    const t2 = await a.prepare(prepareReq)
    await a.confirm(t2.ticketId)
    expect(await a.cancel(t2.ticketId)).toBe(true)
    expect(captured.some((c) => c.url.endsWith('/api/v1/trade/orders/cancel'))).toBe(true)
  })

  it('maps balances to positions and open orders across', async () => {
    const fetchImpl = makeFetch({
      openSequence: [
        [
          {
            id: 42,
            pairName: 'SOL-USDT',
            qty: 12,
            filledQty: 0,
            remainingQty: 12,
            rate: 168,
            status: 'Active',
            orderType: 1,
          },
        ],
      ],
    })
    const a = new KoinbxVenueAdapter({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch })
    const pf = await a.portfolio('koinbx-dev', 'u1')

    // zero-balance ETH filtered out
    expect(pf.positions.map((p) => p.instrument)).toEqual(['BTC', 'USDT'])
    expect(pf.positions[0]).toMatchObject({ size: '0.31 BTC', pnl: '—', tone: 'neutral' })
    expect(pf.openOrders).toHaveLength(1)
    expect(pf.openOrders[0]).toMatchObject({ orderId: '42', side: 'sell' })
    expect(pf.openOrders[0]?.summary).toContain('SELL 12 SOL-USDT')
  })
})
