import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ApiKeyRecord } from '../src/hmac.js'
import { buildService } from '../src/service.js'
import { VenueStore } from '../src/store.js'
import type { AdminConfig } from '../src/types.js'

const KEY = 'ak_test'
const SECRET = 'sk_test_secret'
const USER = 'trader-1'

/** Sign exactly as the parasite adapter does: hex(HMAC(body+ts, secret)). */
function sign(body: object) {
  const payload = JSON.stringify(body)
  const timestamp = new Date().toISOString()
  const signature = createHmac('sha256', SECRET)
    .update(payload + timestamp)
    .digest('hex')
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'x-timestamp': timestamp,
      'x-signature': signature,
    },
  }
}

const BASE_CONFIG: AdminConfig = {
  confirmSurface: 'api',
  workingWindowMs: 0,
  feeRate: 0.001,
  makerFee: 0.0002,
  partialFills: false,
  fillMode: 'working',
  slippagePct: 0,
  latencyMs: 0,
  rejectRate: 0,
  maintenance: false,
  capsSpot: true,
  capsPerp: true,
  capsOptions: false,
  maxLeverage: 50,
  marginModes: ['isolated', 'cross'],
  instruments: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
  minOrderSize: 0,
  maxOrderSize: 0,
}

function makeApp(cfg: Partial<AdminConfig> = {}) {
  const config: AdminConfig = { ...BASE_CONFIG, ...cfg }
  const store = new VenueStore(async () => 60_000, config)
  const keys = new Map<string, ApiKeyRecord>([[KEY, { secret: SECRET, userId: USER }]])
  return { app: buildService({ store, keys, uiUserId: USER }), store }
}

describe('host-venue signed trade wire', () => {
  it('rejects an unsigned / bad-signature order', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trade/orders',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'x-timestamp': new Date().toISOString(),
        'x-signature': 'deadbeef',
      },
      payload: JSON.stringify({
        pairName: 'BTC-USDT',
        orderType: 0,
        tradeType: 20,
        qty: 0.1,
        rate: 60_000,
      }),
    })
    expect(res.statusCode).toBe(401)
  })

  it('places a market buy, fills it, and drops it out of open-orders (reconciler contract)', async () => {
    const { app, store } = makeApp()
    const { payload, headers } = sign({
      pairName: 'BTC-USDT',
      orderType: 0,
      tradeType: 20,
      qty: 0.1,
      rate: 60_000,
      clientOrderId: 't_abc',
    })
    const placed = await app.inject({
      method: 'POST',
      url: '/api/v1/trade/orders',
      headers,
      payload,
    })
    expect(placed.statusCode).toBe(200)
    const orderId = placed.json().data.orderId
    expect(placed.json().status).toBe(true)

    // Before the sweep it is open.
    expect(store.openOrders(USER)).toHaveLength(1)
    await store.sweep()
    // After the sweep it settled → gone from open-orders (== FILLED to the reconciler).
    expect(store.openOrders(USER)).toHaveLength(0)

    // Balances moved: -0.1*60000*(1.001) USDT, +0.1 BTC.
    const bal = new Map(store.balances(USER).map((b) => [b.currencyName, b.amount]))
    expect(bal.get('BTC')).toBeCloseTo(2.1, 6)
    expect(bal.get('USDT')).toBeCloseTo(100_000 - 0.1 * 60_000 * 1.001, 2)
    expect(orderId).toBeGreaterThan(0)
  })

  it('rejects an order that exceeds available balance', async () => {
    const { app } = makeApp()
    const { payload, headers } = sign({
      pairName: 'BTC-USDT',
      orderType: 0,
      tradeType: 20,
      qty: 1_000,
      rate: 60_000,
    })
    const res = await app.inject({ method: 'POST', url: '/api/v1/trade/orders', headers, payload })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/insufficient/i)
  })

  it('rests a limit buy until price crosses, then fills', async () => {
    const config: AdminConfig = { ...BASE_CONFIG, feeRate: 0 }
    const store = new VenueStore(async () => 60_000, config)
    // Limit buy well below market → should rest, not fill.
    const o = store.place(USER, {
      market: 'spot',
      pairName: 'BTC-USDT',
      side: 'buy',
      kind: 'limit',
      qty: 0.1,
      rate: 50_000,
    })
    await store.sweep()
    expect(store.order(o.id)?.status).toBe(10) // still ACTIVE
    // Limit buy above market → crosses immediately.
    const o2 = store.place(USER, {
      market: 'spot',
      pairName: 'BTC-USDT',
      side: 'buy',
      kind: 'limit',
      qty: 0.1,
      rate: 61_000,
    })
    await store.sweep()
    expect(store.order(o2.id)?.status).toBe(20) // SETTLED
  })

  it('opens and closes a perp position with realized PnL', async () => {
    let price = 60_000
    const config: AdminConfig = { ...BASE_CONFIG, feeRate: 0 }
    const store = new VenueStore(async () => price, config)
    store.place(USER, {
      market: 'perp',
      pairName: 'BTC-USDT',
      side: 'buy',
      kind: 'market',
      qty: 1,
      rate: 60_000,
      direction: 'long',
      leverage: 10,
      marginMode: 'isolated',
    })
    await store.sweep()
    const pos = await store.openPositions(USER)
    expect(pos).toHaveLength(1)
    expect(pos[0]?.entry).toBeCloseTo(60_000, 0)

    // Price rises 10%; close the long → +6000 USDT realized.
    price = 66_000
    const before =
      new Map(store.balances(USER).map((b) => [b.currencyName, b.amount])).get('USDT') ?? 0
    store.place(USER, {
      market: 'perp',
      pairName: 'BTC-USDT',
      side: 'sell',
      kind: 'market',
      qty: 1,
      rate: 66_000,
      direction: 'long',
      leverage: 10,
      marginMode: 'isolated',
      reduceOnly: true,
    })
    await store.sweep()
    expect(await store.openPositions(USER)).toHaveLength(0)
    const after =
      new Map(store.balances(USER).map((b) => [b.currencyName, b.amount])).get('USDT') ?? 0
    expect(after - before).toBeCloseTo(6_000, 0)
  })

  it('js_callback: handoff is pending until approved, then places', async () => {
    const { store } = makeApp({ confirmSurface: 'js_callback' })
    const h = store.createHandoff({
      clientOrderId: 't_hand',
      userId: USER,
      place: {
        market: 'spot',
        pairName: 'BTC-USDT',
        side: 'buy',
        kind: 'market',
        qty: 0.1,
        rate: 60_000,
        clientOrderId: 't_hand',
      },
      displayRows: [],
    })
    expect(h.state).toBe('pending')
    expect(store.openOrders(USER)).toHaveLength(0) // nothing placed yet
    const order = store.approveHandoff('t_hand')
    expect(store.getHandoff('t_hand')?.state).toBe('placed')
    expect(store.order(order.id)?.status).toBe(10)
  })
})

describe('host-venue realism & policy levers', () => {
  const spot = (o = {}) => ({ market: 'spot' as const, pairName: 'BTC-USDT', side: 'buy' as const, kind: 'market' as const, qty: 0.1, rate: 60_000, ...o })

  it('maintenance mode rejects every placement', () => {
    const store = new VenueStore(async () => 60_000, { ...BASE_CONFIG, maintenance: true })
    expect(() => store.place(USER, spot())).toThrow(/maintenance/i)
  })

  it('rejectRate=1 always rejects (simulated failure)', () => {
    const store = new VenueStore(async () => 60_000, { ...BASE_CONFIG, rejectRate: 1 })
    expect(() => store.place(USER, spot())).toThrow(/rejected/i)
  })

  it('enforces min/max order size and disabled capabilities', () => {
    const store = new VenueStore(async () => 60_000, { ...BASE_CONFIG, minOrderSize: 0.5, maxOrderSize: 2, capsPerp: false })
    expect(() => store.place(USER, spot({ qty: 0.1 }))).toThrow(/minimum/i)
    expect(() => store.place(USER, spot({ qty: 5 }))).toThrow(/maximum/i)
    expect(() => store.place(USER, spot({ market: 'perp', qty: 1, direction: 'long', leverage: 5, marginMode: 'isolated' }))).toThrow(/perp trading is disabled/i)
  })

  it('applies market slippage against the taker', async () => {
    const store = new VenueStore(async () => 60_000, { ...BASE_CONFIG, feeRate: 0, slippagePct: 0.01 })
    const o = store.place(USER, spot({ qty: 0.1 }))
    await store.sweep()
    // buy fills 1% above 60000 = 60600
    expect(store.order(o.id)?.avgFillPrice).toBeCloseTo(60_600, 0)
  })

  it('manual fill mode holds orders WORKING until manualFill()', async () => {
    const store = new VenueStore(async () => 60_000, { ...BASE_CONFIG, fillMode: 'manual' })
    const o = store.place(USER, spot({ qty: 0.1 }))
    await store.sweep()
    expect(store.order(o.id)?.status).toBe(10) // still ACTIVE — auto-fill suppressed
    expect(await store.manualFill(o.id)).toBe(true)
    expect(store.order(o.id)?.status).toBe(20) // SETTLED on host approval
  })

  it('resetWallet restores seed balances', () => {
    const store = new VenueStore(async () => 60_000, { ...BASE_CONFIG, feeRate: 0 })
    const o = store.place(USER, spot({ qty: 0.1 }))
    void o
    store.resetWallet(USER)
    const bal = new Map(store.balances(USER).map((b) => [b.currencyName, b.amount]))
    expect(bal.get('USDT')).toBe(100_000)
    expect(bal.get('BTC')).toBe(2)
  })
})
