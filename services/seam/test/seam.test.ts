import { InMemorySeamAuditStore } from '@hippo/stores'
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
        // The gateway's internal guard requires the shared token on every
        // delivery — a missing header 401s and fills silently vanish.
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers['x-hippo-internal-token']).toBe(TOKEN)
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

  it('a limit order rests until the quote crosses its price, then fills', async () => {
    // Quote starts ABOVE the buy limit → must rest; dropping it below → fills.
    let last = 61_240
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/v1/snapshot'))
          return new Response(JSON.stringify({ last }), { status: 200 })
        return new Response('not found', { status: 404 })
      }),
    )
    const adapter = new SimVenueAdapter({ fillDelayMs: 10 })
    const events: LifecycleEvent[] = []
    adapter.onEvent((e) => events.push(e))
    const t = await adapter.prepare({
      ...(prepareBody as unknown as PrepareRequest),
      orderType: 'limit',
      limitPrice: '60000',
    })
    await adapter.confirm(t.ticketId)
    await new Promise((r) => setTimeout(r, 60))
    // Several fill windows later it is still only PLACED — WORKING.
    expect(events.map((e) => e.phase)).toEqual(['awaiting_confirm'])
    expect((await adapter.listOrders('koinbx-dev', 'u1'))[0]?.status).toBe('WORKING')
    // Market drops through the limit → next window fills at the limit price.
    last = 59_900
    await new Promise((r) => setTimeout(r, 40))
    expect(events.at(-1)?.phase).toBe('filled')
    expect(events.at(-1)?.rows?.[0]).toEqual({ label: 'Avg fill', value: '60,000' })
  })

  it('a resting limit can still be cancelled between polls', async () => {
    const adapter = new SimVenueAdapter({ fillDelayMs: 10 })
    const events: LifecycleEvent[] = []
    adapter.onEvent((e) => events.push(e))
    const t = await adapter.prepare({
      ...(prepareBody as unknown as PrepareRequest),
      orderType: 'limit',
      limitPrice: '60000', // below the stubbed 61,240 quote → rests
    })
    await adapter.confirm(t.ticketId)
    await new Promise((r) => setTimeout(r, 35))
    expect(await adapter.cancel(t.ticketId)).toBe(true)
    await new Promise((r) => setTimeout(r, 35))
    expect(events.some((e) => e.phase === 'filled')).toBe(false)
  })

  it('confirm emits placement (working) then a filled event with fill actuals; cancel prevents the fill', async () => {
    const adapter = new SimVenueAdapter({ fillDelayMs: 10 })
    const events: LifecycleEvent[] = []
    adapter.onEvent((e) => events.push(e))

    const t1 = await adapter.prepare(prepareBody as unknown as PrepareRequest)
    await adapter.confirm(t1.ticketId)
    await new Promise((r) => setTimeout(r, 40))
    expect(events.map((e) => e.phase)).toEqual(['awaiting_confirm', 'filled'])
    // The placement ack: the order IS on the venue before any fill news.
    expect(events[0]?.stage).toBe('working')
    expect(events[0]?.cancellable).toBe(true)
    expect(events[1]?.venueOrderId).toMatch(/^SIM-/)
    expect(events[1]?.rows?.map((r) => r.label)).toContain('Fees (actual)')

    const t2 = await adapter.prepare(prepareBody as unknown as PrepareRequest)
    await adapter.confirm(t2.ticketId)
    expect(await adapter.cancel(t2.ticketId)).toBe(true)
    await new Promise((r) => setTimeout(r, 40))
    // The second ticket got its working ack but never a fill.
    expect(events.filter((e) => e.phase === 'filled')).toHaveLength(1)
    expect(events).toHaveLength(3)
  })

  it('rejects nonsense sizes', async () => {
    const adapter = new SimVenueAdapter({ fillDelayMs: 10 })
    await expect(
      adapter.prepare({ ...(prepareBody as unknown as PrepareRequest), size: '-3' }),
    ).rejects.toThrow('invalid order size')
  })
})

// Shared secret + trusted callback origin for the guarded HTTP surface.
const TOKEN = 'seam-secret'
const CALLBACK = 'http://gateway.test/callback'
const HDR = { 'x-hippo-internal-token': TOKEN }
/** App with the trust boundary configured (token + callback allowlist). */
const guarded = (adapter = new SimVenueAdapter({ fillDelayMs: 10 })) =>
  buildService(adapter, { internalToken: TOKEN, callbackAllowedOrigins: 'http://gateway.test' })

describe('seam service HTTP surface', () => {
  it('prepare → confirm → filled event delivered to the callbackUrl, all audited', async () => {
    const app = guarded()
    const prep = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: prepareBody,
    })
    expect(prep.statusCode).toBe(200)
    const { ticketId } = prep.json() as { ticketId: string }

    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/confirm`,
      headers: HDR,
      payload: { callbackUrl: CALLBACK },
    })
    expect(confirm.statusCode).toBe(202)

    await new Promise((r) => setTimeout(r, 60))
    // Two honest deliveries now: placement ack (working), then the fill.
    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]).toMatchObject({ ticketId, phase: 'awaiting_confirm', stage: 'working' })
    expect(deliveries[1]).toMatchObject({ ticketId, phase: 'filled' })

    // The working ack's delivery races the confirm audit row on the microtask
    // queue — assert content, not interleaving.
    const kinds = app.audit.map((a) => a.kind)
    expect(kinds[0]).toBe('prepare')
    expect(kinds.filter((k) => k === 'confirm')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'event_delivered')).toHaveLength(2)
    expect(app.audit.every((a) => a.idempotencyKey.startsWith('idem_'))).toBe(true)

    // GET /internal/audit serves the same trail from the store, in the same
    // backward-compatible shape: an array of entries, oldest first.
    const served = await app.inject({ method: 'GET', url: '/internal/audit', headers: HDR })
    expect(served.statusCode).toBe(200)
    const rows = served.json() as Array<{ kind: string; idempotencyKey: string }>
    expect(rows.map((r) => r.kind)).toEqual(kinds)
    expect(rows.every((r) => r.idempotencyKey.startsWith('idem_'))).toBe(true)
    await app.close()
  })

  it('rejects malformed prepare requests with 400', async () => {
    const app = guarded()
    for (const bad of [
      { ...prepareBody, side: 'yolo' },
      { ...prepareBody, instrument: 'BTCUSDT' },
      { ...prepareBody, orderType: 'limit' }, // limit without limitPrice
      { partnerId: 'p' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/prepare',
        headers: HDR,
        payload: bad,
      })
      expect(res.statusCode).toBe(400)
    }
    await app.close()
  })

  it('confirm of an unknown ticket is a 404, not a silent accept', async () => {
    const app = guarded()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tickets/t_nope/confirm',
      headers: HDR,
      payload: { callbackUrl: CALLBACK },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('cancel stops the lifecycle and audits it', async () => {
    // Fill far in the future: the test cancels immediately after confirm, and a
    // 10ms fill window raced the cancel on loaded CI runners (order filled first).
    const app = guarded(new SimVenueAdapter({ fillDelayMs: 5_000 }))
    const prep = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: prepareBody,
    })
    const { ticketId } = prep.json() as { ticketId: string }
    await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/confirm`,
      headers: HDR,
      payload: { callbackUrl: CALLBACK },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/cancel`,
      headers: HDR,
      payload: {},
    })
    expect(res.json()).toEqual({ cancelled: true })
    await new Promise((r) => setTimeout(r, 40))
    // Only the placement ack was delivered — the cancel prevented the fill.
    expect(deliveries.map((d) => d.phase)).toEqual(['awaiting_confirm'])
    expect(deliveries[0]?.stage).toBe('working')
    await app.close()
  })

  it('portfolio is REAL state: empty for a fresh user, built only from actual fills', async () => {
    const app = guarded(new SimVenueAdapter({ fillDelayMs: 20 }))

    // Fresh user: nothing fabricated.
    let res = await app.inject({
      method: 'GET',
      url: '/v1/portfolio/koinbx-dev/u1',
      headers: HDR,
    })
    expect(res.json()).toEqual({ positions: [], openOrders: [] })

    // Prepare + confirm → the ticket shows as a real open order while filling.
    const prep = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: prepareBody,
    })
    const { ticketId } = prep.json() as { ticketId: string }
    await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/confirm`,
      headers: HDR,
      payload: { callbackUrl: CALLBACK },
    })
    res = await app.inject({ method: 'GET', url: '/v1/portfolio/koinbx-dev/u1', headers: HDR })
    let body = res.json() as { positions: unknown[]; openOrders: Record<string, string>[] }
    expect(body.openOrders).toHaveLength(1)
    expect(body.openOrders[0]).toMatchObject({
      orderId: ticketId,
      summary: 'BUY 0.05 BTC · MKT',
      status: 'FILLING',
    })

    // After the fill: open order gone, position materialized from the fill
    // actuals and marked to the live quote (stubbed at 61,240 = entry → flat).
    await new Promise((r) => setTimeout(r, 60))
    res = await app.inject({ method: 'GET', url: '/v1/portfolio/koinbx-dev/u1', headers: HDR })
    body = res.json() as { positions: Record<string, string>[]; openOrders: unknown[] }
    expect(body.openOrders).toHaveLength(0)
    expect(body.positions).toHaveLength(1)
    expect(body.positions[0]).toMatchObject({
      instrument: 'BTC/USDT',
      size: '0.05 BTC',
      entry: '61,240',
      mark: '61,240',
    })

    // Tenancy: another user's portfolio stays empty.
    res = await app.inject({ method: 'GET', url: '/v1/portfolio/koinbx-dev/u2', headers: HDR })
    expect(res.json()).toEqual({ positions: [], openOrders: [] })
    await app.close()
  })
})

describe('seam consolidated orders — GET /v1/orders', () => {
  it('401s without the internal token', async () => {
    const app = guarded()
    const res = await app.inject({ method: 'GET', url: '/v1/orders/koinbx-dev/u1' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('is empty for a fresh user, then lists the order across its lifecycle', async () => {
    const app = guarded(new SimVenueAdapter({ fillDelayMs: 20 }))

    // Fresh user: real state only, nothing fabricated.
    let res = await app.inject({ method: 'GET', url: '/v1/orders/koinbx-dev/u1', headers: HDR })
    expect(res.json()).toEqual({ orders: [] })

    // Prepare + confirm → the order is retained as WORKING.
    const prep = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: prepareBody,
    })
    const { ticketId } = prep.json() as { ticketId: string }
    await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/confirm`,
      headers: HDR,
      payload: { callbackUrl: CALLBACK },
    })
    res = await app.inject({ method: 'GET', url: '/v1/orders/koinbx-dev/u1', headers: HDR })
    let orders = (res.json() as { orders: Record<string, unknown>[] }).orders
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      orderId: ticketId,
      symbol: 'BTC/USDT',
      side: 'buy',
      kind: 'MKT',
      status: 'WORKING',
      statusClass: 'open',
    })

    // After the fill: the SAME order is retained, now FILLED (unlike the
    // open-orders view, which drops it). This is the whole point of listOrders.
    await new Promise((r) => setTimeout(r, 60))
    res = await app.inject({ method: 'GET', url: '/v1/orders/koinbx-dev/u1', headers: HDR })
    orders = (res.json() as { orders: Record<string, unknown>[] }).orders
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      orderId: ticketId,
      status: 'FILLED',
      statusClass: 'filled',
      filledPct: 100,
    })

    // Tenancy: another user's blotter stays empty.
    res = await app.inject({ method: 'GET', url: '/v1/orders/koinbx-dev/u2', headers: HDR })
    expect(res.json()).toEqual({ orders: [] })
    await app.close()
  })

  it('retains a cancelled order as CANCELLED', async () => {
    const app = guarded(new SimVenueAdapter({ fillDelayMs: 10_000 }))
    const prep = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: prepareBody,
    })
    const { ticketId } = prep.json() as { ticketId: string }
    await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/confirm`,
      headers: HDR,
      payload: { callbackUrl: CALLBACK },
    })
    await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/cancel`,
      headers: HDR,
      payload: {},
    })
    const res = await app.inject({ method: 'GET', url: '/v1/orders/koinbx-dev/u1', headers: HDR })
    const orders = (res.json() as { orders: Record<string, unknown>[] }).orders
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({ orderId: ticketId, statusClass: 'cancelled' })
    await app.close()
  })
})

describe('seam trust boundary — INTERNAL_API_TOKEN guard', () => {
  // Every mutating/reading trading route + /internal/audit is guarded.
  const routes: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown }> = [
    { method: 'POST', url: '/v1/prepare', payload: prepareBody },
    { method: 'POST', url: '/v1/tickets/t_x/confirm', payload: { callbackUrl: CALLBACK } },
    { method: 'POST', url: '/v1/tickets/t_x/cancel', payload: {} },
    { method: 'GET', url: '/v1/portfolio/koinbx-dev/u1' },
    { method: 'GET', url: '/v1/orders/koinbx-dev/u1' },
    { method: 'GET', url: '/internal/audit' },
  ]

  it('is fail-closed: every guarded route is 503 when INTERNAL_API_TOKEN is unset', async () => {
    const app = buildService(new SimVenueAdapter({ fillDelayMs: 10 }), {
      internalToken: '',
      callbackAllowedOrigins: 'http://gateway.test',
    })
    for (const r of routes) {
      const res = await app.inject({ method: r.method, url: r.url, payload: r.payload })
      expect(res.statusCode).toBe(503)
    }
    await app.close()
  })

  it('rejects a missing or wrong token with 401 on every guarded route', async () => {
    const app = guarded()
    for (const r of routes) {
      const noTok = await app.inject({ method: r.method, url: r.url, payload: r.payload })
      expect(noTok.statusCode).toBe(401)
      const wrongTok = await app.inject({
        method: r.method,
        url: r.url,
        headers: { 'x-hippo-internal-token': 'wrong' },
        payload: r.payload,
      })
      expect(wrongTok.statusCode).toBe(401)
    }
    await app.close()
  })

  it('accepts the correct token (timing-safe) — audit + portfolio return 200', async () => {
    const app = guarded()
    const audit = await app.inject({ method: 'GET', url: '/internal/audit', headers: HDR })
    expect(audit.statusCode).toBe(200)
    const portfolio = await app.inject({
      method: 'GET',
      url: '/v1/portfolio/koinbx-dev/u1',
      headers: HDR,
    })
    expect(portfolio.statusCode).toBe(200)
    await app.close()
  })
})

describe('durable seam audit store', () => {
  it('two instances sharing one injected store: entries recorded by the first are listable by the second (pod-swap durability)', async () => {
    const store = new InMemorySeamAuditStore()
    const build = () =>
      buildService(new SimVenueAdapter({ fillDelayMs: 10 }), {
        internalToken: TOKEN,
        callbackAllowedOrigins: 'http://gateway.test',
        auditStore: store,
      })

    // "Pod 1" records a prepare + confirm through the shared store…
    const first = build()
    const prep = await first.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: prepareBody,
    })
    const { ticketId } = prep.json() as { ticketId: string }
    await first.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/confirm`,
      headers: HDR,
      payload: { callbackUrl: CALLBACK },
    })
    await new Promise((r) => setTimeout(r, 60))
    await first.close()

    // …and "pod 2" (fresh process state, empty in-process tail) still serves
    // the full trail — the audit record survived the restart.
    const second = build()
    expect(second.audit).toHaveLength(0)
    const res = await second.inject({ method: 'GET', url: '/internal/audit', headers: HDR })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ kind: string; ticketId: string; idempotencyKey: string }>
    expect(rows.map((r) => r.kind)).toContain('prepare')
    expect(rows.map((r) => r.kind)).toContain('confirm')
    expect(rows.every((r) => r.ticketId === ticketId)).toBe(true)
    expect(rows.every((r) => r.idempotencyKey.startsWith('idem_'))).toBe(true)
    // Oldest-first: the prepare precedes its confirm.
    expect(rows.findIndex((r) => r.kind === 'prepare')).toBeLessThan(
      rows.findIndex((r) => r.kind === 'confirm'),
    )
    await second.close()
  })
})

describe('seam confirm callbackUrl SSRF allowlist', () => {
  it('rejects a foreign callback origin with 400 (no order confirmed)', async () => {
    const app = guarded()
    const prep = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: prepareBody,
    })
    const { ticketId } = prep.json() as { ticketId: string }
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/confirm`,
      headers: HDR,
      payload: { callbackUrl: 'http://169.254.169.254/latest/meta-data' },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/origin not allowed/)
    // The order was never confirmed, so no venue events are delivered.
    await new Promise((r) => setTimeout(r, 40))
    expect(deliveries).toHaveLength(0)
    expect(app.audit.some((a) => a.kind === 'confirm')).toBe(false)
    await app.close()
  })

  it('accepts a callback whose origin is on the allowlist', async () => {
    const app = guarded()
    const prep = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: prepareBody,
    })
    const { ticketId } = prep.json() as { ticketId: string }
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/confirm`,
      headers: HDR,
      payload: { callbackUrl: CALLBACK },
    })
    expect(res.statusCode).toBe(202)
    await app.close()
  })
})
