import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildService } from '../src/service.js'
import { SimVenueAdapter } from '../src/sim-venue.js'
import type { LifecycleEvent, PrepareRequest } from '../src/types.js'

const prepareBody: Record<string, unknown> = {
  partnerId: 'koinbx-dev',
  userId: 'u1',
  side: 'buy',
  size: '0.05',
  instrument: 'BTC/USDT',
  orderType: 'market',
}

// SimVenueAdapter fetches quotes over HTTP; stub fetch for market quotes and
// capture callback deliveries.
let deliveries: LifecycleEvent[]
beforeEach(() => {
  deliveries = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/v1/snapshot')) {
        return new Response(JSON.stringify({ last: 61_240 }), { status: 200 })
      }
      if (u.includes('/callback')) {
        deliveries.push(JSON.parse(String(init?.body)) as LifecycleEvent)
        return new Response('{}', { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('sim venue adapter', () => {
  it('prepares a ticket with display rows the SDK renders verbatim', async () => {
    const adapter = new SimVenueAdapter({ fillDelayMs: 10 })
    const ticket = await adapter.prepare(prepareBody as unknown as PrepareRequest)
    expect(ticket.ticketId).toMatch(/^t_/)
    expect(ticket.sideLabel).toBe('BUY · MKT')
    const labels = ticket.rows.map((r) => r.label)
    expect(labels).toEqual(['Instrument', 'Size', 'Est. price', 'Est. cost incl. fees'])
    expect(ticket.rows[3]?.value).toBe('3,065.06 USDT') // 0.05×61240×1.001
  })

  it('limit orders use the limit price, no quote call', async () => {
    const adapter = new SimVenueAdapter({ fillDelayMs: 10 })
    const ticket = await adapter.prepare({
      ...(prepareBody as unknown as PrepareRequest),
      orderType: 'limit',
      limitPrice: '60000',
    })
    expect(ticket.sideLabel).toBe('BUY · LMT')
    expect(ticket.rows[2]).toEqual({ label: 'Limit price', value: '60,000' })
  })

  it('confirm emits a filled event with fill actuals; cancel prevents it', async () => {
    const adapter = new SimVenueAdapter({ fillDelayMs: 10 })
    const events: LifecycleEvent[] = []
    adapter.onEvent((e) => events.push(e))

    const t1 = await adapter.prepare(prepareBody as unknown as PrepareRequest)
    await adapter.confirm(t1.ticketId)
    await new Promise((r) => setTimeout(r, 40))
    expect(events).toHaveLength(1)
    expect(events[0]?.phase).toBe('filled')
    expect(events[0]?.venueOrderId).toMatch(/^SIM-/)
    expect(events[0]?.rows?.map((r) => r.label)).toContain('Fees (actual)')

    const t2 = await adapter.prepare(prepareBody as unknown as PrepareRequest)
    await adapter.confirm(t2.ticketId)
    expect(await adapter.cancel(t2.ticketId)).toBe(true)
    await new Promise((r) => setTimeout(r, 40))
    expect(events).toHaveLength(1) // no fill for the cancelled ticket
  })

  it('rejects nonsense sizes', async () => {
    const adapter = new SimVenueAdapter({ fillDelayMs: 10 })
    await expect(
      adapter.prepare({ ...(prepareBody as unknown as PrepareRequest), size: '-3' }),
    ).rejects.toThrow('invalid order size')
  })
})

describe('seam service HTTP surface', () => {
  it('prepare → confirm → filled event delivered to the callbackUrl, all audited', async () => {
    const app = buildService(new SimVenueAdapter({ fillDelayMs: 10 }))
    const prep = await app.inject({ method: 'POST', url: '/v1/prepare', payload: prepareBody })
    expect(prep.statusCode).toBe(200)
    const { ticketId } = prep.json() as { ticketId: string }

    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/confirm`,
      payload: { callbackUrl: 'http://gateway.test/callback' },
    })
    expect(confirm.statusCode).toBe(202)

    await new Promise((r) => setTimeout(r, 60))
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ ticketId, phase: 'filled' })

    const kinds = app.audit.map((a) => a.kind)
    expect(kinds).toEqual(['prepare', 'confirm', 'event_delivered'])
    expect(app.audit.every((a) => a.idempotencyKey.startsWith('idem_'))).toBe(true)
    await app.close()
  })

  it('rejects malformed prepare requests with 400', async () => {
    const app = buildService(new SimVenueAdapter({ fillDelayMs: 10 }))
    for (const bad of [
      { ...prepareBody, side: 'yolo' },
      { ...prepareBody, instrument: 'BTCUSDT' },
      { ...prepareBody, orderType: 'limit' }, // limit without limitPrice
      { partnerId: 'p' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/v1/prepare', payload: bad })
      expect(res.statusCode).toBe(400)
    }
    await app.close()
  })

  it('confirm of an unknown ticket is a 404, not a silent accept', async () => {
    const app = buildService(new SimVenueAdapter({ fillDelayMs: 10 }))
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tickets/t_nope/confirm',
      payload: { callbackUrl: 'http://gateway.test/callback' },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('cancel stops the lifecycle and audits it', async () => {
    // Fill far in the future: the test cancels immediately after confirm, and a
    // 10ms fill window raced the cancel on loaded CI runners (order filled first).
    const app = buildService(new SimVenueAdapter({ fillDelayMs: 5_000 }))
    const prep = await app.inject({ method: 'POST', url: '/v1/prepare', payload: prepareBody })
    const { ticketId } = prep.json() as { ticketId: string }
    await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/confirm`,
      payload: { callbackUrl: 'http://gateway.test/callback' },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/cancel`,
      payload: {},
    })
    expect(res.json()).toEqual({ cancelled: true })
    await new Promise((r) => setTimeout(r, 40))
    expect(deliveries).toHaveLength(0)
    await app.close()
  })

  it('serves the portfolio (never cached)', async () => {
    const app = buildService(new SimVenueAdapter({ fillDelayMs: 10 }))
    const res = await app.inject({ method: 'GET', url: '/v1/portfolio/koinbx-dev/u1' })
    const body = res.json() as { positions: unknown[]; openOrders: unknown[] }
    expect(body.positions).toHaveLength(3)
    expect(body.openOrders).toHaveLength(3)
    await app.close()
  })
})
