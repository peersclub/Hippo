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

  it('lists ALL orders (settled + cancelled), unlike open-orders', async () => {
    const { app, store } = makeApp()
    // One order that settles, one that is cancelled.
    const filled = sign({
      pairName: 'BTC-USDT',
      orderType: 0,
      tradeType: 20,
      qty: 0.1,
      rate: 60_000,
      clientOrderId: 't_filled',
    })
    await app.inject({ method: 'POST', url: '/api/v1/trade/orders', ...filled })
    await store.sweep() // → SETTLED
    const resting = store.place(USER, {
      market: 'spot',
      pairName: 'ETH-USDT',
      side: 'buy',
      kind: 'limit',
      qty: 1,
      rate: 100, // far below market → rests
      clientOrderId: 't_rest',
    })
    store.cancel(resting.id) // → CANCELED

    // open-orders is empty (settled dropped out, cancelled dropped out)…
    const open = sign({})
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/v1/trade/orders/open',
      ...open,
    })
    expect(openRes.json().data.orders).toHaveLength(0)

    // …but orders/all retains both, newest first, with terminal statuses.
    const all = sign({})
    const allRes = await app.inject({ method: 'POST', url: '/api/v1/trade/orders/all', ...all })
    expect(allRes.statusCode).toBe(200)
    const rows = allRes.json().data.orders as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    const byClient = new Map(rows.map((r) => [r.clientOrderId, r]))
    expect(byClient.get('t_filled')).toMatchObject({ status: 20 }) // SETTLED
    expect(byClient.get('t_rest')).toMatchObject({ status: 50 }) // CANCELED
    expect(rows[0]).toHaveProperty('createdAt')
  })

  it('rejects the orders/all listing without a valid signature', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trade/orders/all',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'x-timestamp': new Date().toISOString(),
        'x-signature': 'deadbeef',
      },
      payload: '{}',
    })
    expect(res.statusCode).toBe(401)
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

  it('rests perp limit orders until price crosses (both directions)', async () => {
    const config: AdminConfig = { ...BASE_CONFIG, feeRate: 0 }
    const store = new VenueStore(async () => 60_000, config)
    // Long entry below market → must rest.
    const long = store.place(USER, {
      market: 'perp',
      pairName: 'BTC-USDT',
      side: 'buy',
      kind: 'limit',
      qty: 0.1,
      rate: 55_000,
      direction: 'long',
      leverage: 10,
      marginMode: 'isolated',
    })
    // Short entry above market → must rest.
    const short = store.place(USER, {
      market: 'perp',
      pairName: 'BTC-USDT',
      side: 'sell',
      kind: 'limit',
      qty: 0.1,
      rate: 65_000,
      direction: 'short',
      leverage: 10,
      marginMode: 'isolated',
    })
    await store.sweep()
    expect(store.order(long.id)?.status).toBe(10) // ACTIVE — resting
    expect(store.order(short.id)?.status).toBe(10) // ACTIVE — resting
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
  const spot = (o = {}) => ({
    market: 'spot' as const,
    pairName: 'BTC-USDT',
    side: 'buy' as const,
    kind: 'market' as const,
    qty: 0.1,
    rate: 60_000,
    ...o,
  })

  it('maintenance mode rejects every placement', () => {
    const store = new VenueStore(async () => 60_000, { ...BASE_CONFIG, maintenance: true })
    expect(() => store.place(USER, spot())).toThrow(/maintenance/i)
  })

  it('rejectRate=1 always rejects (simulated failure)', () => {
    const store = new VenueStore(async () => 60_000, { ...BASE_CONFIG, rejectRate: 1 })
    expect(() => store.place(USER, spot())).toThrow(/rejected/i)
  })

  it('enforces min/max order size and disabled capabilities', () => {
    const store = new VenueStore(async () => 60_000, {
      ...BASE_CONFIG,
      minOrderSize: 0.5,
      maxOrderSize: 2,
      capsPerp: false,
    })
    expect(() => store.place(USER, spot({ qty: 0.1 }))).toThrow(/minimum/i)
    expect(() => store.place(USER, spot({ qty: 5 }))).toThrow(/maximum/i)
    expect(() =>
      store.place(
        USER,
        spot({ market: 'perp', qty: 1, direction: 'long', leverage: 5, marginMode: 'isolated' }),
      ),
    ).toThrow(/perp trading is disabled/i)
  })

  it('applies market slippage against the taker', async () => {
    const store = new VenueStore(async () => 60_000, {
      ...BASE_CONFIG,
      feeRate: 0,
      slippagePct: 0.01,
    })
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

describe('protective exits — attached stop-loss / take-profit with OCO', () => {
  /** Fee-free venue with a mutable price so tests can walk the market. */
  function priceStore(cfg: Partial<AdminConfig> = {}) {
    const px = { value: 60_000 }
    const store = new VenueStore(async () => px.value, {
      ...BASE_CONFIG,
      feeRate: 0,
      makerFee: 0,
      ...cfg,
    })
    return { store, px }
  }

  const perpEntry = (o = {}) => ({
    market: 'perp' as const,
    pairName: 'BTC-USDT',
    side: 'buy' as const,
    kind: 'market' as const,
    qty: 1,
    rate: 60_000,
    direction: 'long' as const,
    leverage: 10,
    marginMode: 'isolated' as const,
    stopLossPrice: 55_000,
    takeProfitPrice: 70_000,
    ...o,
  })

  const usdt = (store: VenueStore) =>
    new Map(store.balances(USER).map((b) => [b.currencyName, b.amount])).get('USDT') ?? 0

  it('rejects nonsense protection at placement (long: stop must be below entry, tp above)', () => {
    const { store } = priceStore()
    expect(() => store.place(USER, perpEntry({ stopLossPrice: 61_000 }))).toThrow(/stop-loss/i)
    expect(() => store.place(USER, perpEntry({ takeProfitPrice: 59_000 }))).toThrow(/take-profit/i)
    // Short direction flips the matrix.
    expect(() =>
      store.place(
        USER,
        perpEntry({
          side: 'sell',
          direction: 'short',
          stopLossPrice: 59_000,
          takeProfitPrice: 55_000,
        }),
      ),
    ).toThrow(/stop-loss.*above/i)
    // Closing orders can't carry protection — the close IS the exit.
    expect(() => store.place(USER, perpEntry({ reduceOnly: true }))).toThrow(/reduce-only/i)
    // Spot sells can't carry protection — a "protective" child would open exposure.
    expect(() =>
      store.place(USER, {
        market: 'spot',
        pairName: 'BTC-USDT',
        side: 'sell',
        kind: 'market',
        qty: 0.1,
        rate: 60_000,
        stopLossPrice: 55_000,
      }),
    ).toThrow(/buy orders only/i)
  })

  it('entry fill spawns the OCO pair; the stop rests until price crosses ADVERSELY, then closes at market', async () => {
    const { store, px } = priceStore()
    const entry = store.place(USER, { ...perpEntry(), clientOrderId: 't_prot' })
    await store.sweep()
    expect(store.order(entry.id)?.status).toBe(20) // entry SETTLED

    // Children exist: a reduce-only TP limit and an SL stop, OCO-linked.
    const children = store.openOrders(USER)
    expect(children).toHaveLength(2)
    const tp = children.find((o) => o.kind === 'limit')
    const sl = children.find((o) => o.kind === 'stop')
    expect(tp).toMatchObject({
      side: 'sell',
      rate: 70_000,
      reduceOnly: true,
      parentId: entry.id,
      clientOrderId: 't_prot:tp',
    })
    expect(sl).toMatchObject({
      side: 'sell',
      rate: 55_000,
      reduceOnly: true,
      parentId: entry.id,
      clientOrderId: 't_prot:sl',
    })
    expect(tp?.ocoSiblingId).toBe(sl?.id)
    expect(sl?.ocoSiblingId).toBe(tp?.id)

    // Price above the trigger (favourable side): the stop must NOT fire —
    // a limit-sell at 55k would have crossed here; the stop rule is inverted.
    px.value = 56_000
    await store.sweep()
    expect(store.order(sl?.id ?? 0)?.status).toBe(10) // still resting
    expect(store.order(tp?.id ?? 0)?.status).toBe(10)

    // Adverse cross: last ≤ stop → close at market, position gone, OCO fires.
    px.value = 54_000
    const before = usdt(store)
    await store.sweep()
    expect(store.order(sl?.id ?? 0)?.status).toBe(20) // stop filled
    expect(store.order(sl?.id ?? 0)?.avgFillPrice).toBeCloseTo(54_000, 0) // taker at market
    expect(store.order(tp?.id ?? 0)?.status).toBe(50) // sibling CANCELED
    expect(await store.openPositions(USER)).toHaveLength(0)
    // Realized PnL hits TOTAL: (54k − 60k) × 1 = −6,000. The margin release
    // frees RESERVED (asserted via the snapshot), it doesn't change total.
    expect(usdt(store) - before).toBeCloseTo(-6_000, 0)
    expect(store.snapshot().wallets[USER]?.USDT?.reserved ?? -1).toBe(0)
  })

  it('take-profit fills as a MAKER at its resting rate and cancels the stop', async () => {
    const { store, px } = priceStore({ makerFee: 0.0002 })
    const entry = store.place(USER, perpEntry())
    await store.sweep()
    const tp = store.openOrders(USER).find((o) => o.kind === 'limit')
    const sl = store.openOrders(USER).find((o) => o.kind === 'stop')

    px.value = 71_000
    await store.sweep()
    const tpDone = store.order(tp?.id ?? 0)
    expect(tpDone?.status).toBe(20)
    expect(tpDone?.avgFillPrice).toBe(70_000) // the resting rate, not 71k — maker
    expect(store.order(sl?.id ?? 0)?.status).toBe(50) // OCO sibling cancelled
    expect(await store.openPositions(USER)).toHaveLength(0)
    void entry
  })

  it('applies taker slippage to a triggered stop (market close semantics)', async () => {
    const { store, px } = priceStore({ slippagePct: 0.01 })
    store.place(USER, perpEntry({ takeProfitPrice: undefined }))
    await store.sweep()
    const sl = store.openOrders(USER).find((o) => o.kind === 'stop')
    px.value = 54_000
    await store.sweep()
    // Sell stop fills 1% BELOW the live price — moved against the taker.
    expect(store.order(sl?.id ?? 0)?.avgFillPrice).toBeCloseTo(54_000 * 0.99, 0)
  })

  it('closing the position by other means cancels the surviving children', async () => {
    const { store } = priceStore()
    store.place(USER, perpEntry())
    await store.sweep()
    expect(store.openOrders(USER)).toHaveLength(2)

    // Manual full close (reduce-only market sell) — not a protective child.
    store.place(USER, {
      market: 'perp',
      pairName: 'BTC-USDT',
      side: 'sell',
      kind: 'market',
      qty: 1,
      rate: 60_000,
      direction: 'long',
      leverage: 10,
      marginMode: 'isolated',
      reduceOnly: true,
    })
    await store.sweep()
    expect(await store.openPositions(USER)).toHaveLength(0)
    // Both children were cancelled — no orphan could reopen exposure.
    expect(store.openOrders(USER)).toHaveLength(0)
    const statuses = store
      .allOrders(USER)
      .filter((o) => o.parentId !== undefined)
      .map((o) => o.status)
    expect(statuses.sort()).toEqual([50, 50])
  })

  it('spot buy with protection: children never double-reserve; OCO resolution leaves reserves clean', async () => {
    const { store, px } = priceStore()
    store.place(USER, {
      market: 'spot',
      pairName: 'BTC-USDT',
      side: 'buy',
      kind: 'market',
      qty: 0.1,
      rate: 60_000,
      stopLossPrice: 55_000,
      takeProfitPrice: 70_000,
    })
    await store.sweep()
    const children = store.openOrders(USER)
    expect(children).toHaveLength(2)
    // Neither child reserved the base — 2.1 BTC total, 2.1 available.
    const snap = store.snapshot()
    expect(snap.wallets[USER]?.BTC?.reserved ?? 0).toBe(0)

    px.value = 70_500
    await store.sweep()
    const bal = new Map(store.balances(USER).map((b) => [b.currencyName, b.amount]))
    expect(bal.get('BTC')).toBeCloseTo(2, 6) // 2 + 0.1 − 0.1
    expect(bal.get('USDT')).toBeCloseTo(100_000 - 6_000 + 7_000, 0) // sold at the 70k limit
    const snap2 = store.snapshot()
    expect(snap2.wallets[USER]?.BTC?.reserved ?? 0).toBe(0)
    expect(store.openOrders(USER)).toHaveLength(0) // stop cancelled by OCO
  })

  it('accepts the wire fields end-to-end and rejects invalid ones with an honest error', async () => {
    const { app, store } = makeApp({ feeRate: 0, makerFee: 0 })
    const good = sign({
      pairName: 'BTC-USDT',
      orderType: 0,
      tradeType: 20,
      qty: 0.1,
      rate: 60_000,
      market: 'perp',
      direction: 'long',
      leverage: 10,
      marginMode: 'isolated',
      stopLossPrice: 55_000,
      takeProfitPrice: '70000', // numeric strings accepted like every wire number
      clientOrderId: 't_wire',
    })
    const placed = await app.inject({ method: 'POST', url: '/api/v1/trade/orders', ...good })
    expect(placed.statusCode).toBe(200)
    await store.sweep()
    const open = store.openOrders(USER)
    expect(open.map((o) => o.kind).sort()).toEqual(['limit', 'stop'])

    const bad = sign({
      pairName: 'BTC-USDT',
      orderType: 0,
      tradeType: 20,
      qty: 0.1,
      rate: 60_000,
      stopLossPrice: -5,
    })
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/trade/orders', ...bad })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error).toMatch(/stopLossPrice/i)

    const nonsense = sign({
      pairName: 'BTC-USDT',
      orderType: 0,
      tradeType: 20,
      qty: 0.1,
      rate: 60_000,
      market: 'perp',
      direction: 'long',
      leverage: 10,
      stopLossPrice: 65_000, // above a long's entry — would trigger immediately
    })
    const res = await app.inject({ method: 'POST', url: '/api/v1/trade/orders', ...nonsense })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/stop-loss.*below/i)
  })

  it('advertises protectiveExits per capability, derived from live admin config', async () => {
    const { app } = makeApp()
    const caps = (await app.inject({ method: 'GET', url: '/v1/capabilities' })).json()
    expect(caps.capabilities.spot.protectiveExits).toBe(true)
    expect(caps.capabilities.futures_perp.protectiveExits).toBe(true)

    const { app: spotOff } = makeApp({ capsSpot: false })
    const caps2 = (await spotOff.inject({ method: 'GET', url: '/v1/capabilities' })).json()
    expect(caps2.capabilities.spot).toBeUndefined()
    expect(caps2.capabilities.futures_perp.protectiveExits).toBe(true)
  })
})

describe('discovery surface (hippo scan target)', () => {
  it('serves the OpenAPI doc with the signed trade wire + capabilities', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/openapi.json' })
    expect(res.statusCode).toBe(200)
    const doc = res.json()
    expect(doc.openapi).toBe('3.0.3')
    expect(Object.keys(doc.paths)).toContain('/api/v1/trade/orders')
    expect(Object.keys(doc.paths)).toContain('/v1/capabilities')
    expect(doc.components.securitySchemes.signature.name).toBe('x-signature')
  })

  it('serves a homepage with the brand accent for theming extraction', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('theme-color')
    expect(res.body).toContain('#3b82f6')
    expect(res.body).toContain('/openapi.json')
  })
})

describe('build provenance', () => {
  it('/health reports sha + builtAt ("unknown" when the image is unstamped)', async () => {
    const { app } = makeApp()
    const body = (await app.inject({ method: 'GET', url: '/health' })).json()
    expect(body).toMatchObject({
      ok: true,
      service: 'host-venue',
      sha: expect.any(String),
      builtAt: expect.any(String),
    })
  })
})
