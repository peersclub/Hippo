import { createHmac } from 'node:crypto'
import { InMemoryHostVenueStateStore } from '@hippo/stores'
import { describe, expect, it } from 'vitest'
import type { ApiKeyRecord } from '../src/hmac.js'
import { SnapshotPersister } from '../src/persistence.js'
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

const spot = (o = {}) => ({
  market: 'spot' as const,
  pairName: 'BTC-USDT',
  side: 'buy' as const,
  kind: 'market' as const,
  qty: 0.1,
  rate: 60_000,
  ...o,
})

describe('venue snapshot/restore round-trip', () => {
  it('resting order, open position, wallet and counter all survive into a fresh store', async () => {
    const cfg: AdminConfig = { ...BASE_CONFIG, feeRate: 0 }
    const first = new VenueStore(async () => 60_000, cfg)

    // A resting limit buy (below market → stays ACTIVE)…
    const resting = first.place(USER, spot({ kind: 'limit' as const, rate: 50_000 }))
    // …an open perp long…
    first.place(USER, {
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
    await first.sweep()
    // …and a settled spot trade that moved the wallet.
    first.place(USER, spot({ qty: 0.2 }))
    await first.sweep()

    const second = new VenueStore(async () => 60_000, { ...BASE_CONFIG })
    second.restore(JSON.parse(JSON.stringify(first.snapshot())))

    // Open orders, positions and balances are identical.
    expect(second.openOrders(USER)).toEqual(first.openOrders(USER))
    expect(await second.openPositions(USER)).toEqual(await first.openPositions(USER))
    expect(second.balances(USER)).toEqual(first.balances(USER))
    // Terminal orders are retained too (the reconciler's filled-vs-cancelled read).
    expect(second.allOrders(USER)).toHaveLength(first.allOrders(USER).length)
    // Restored config wins over the fresh instance's boot config.
    expect(second.config.feeRate).toBe(0)

    // The id counter continues — no duplicate ids across the restart.
    const next = second.place(USER, spot({ kind: 'limit' as const, rate: 50_500 }))
    const ids = second.allOrders(USER).map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(next.id).toBeGreaterThan(Math.max(...first.allOrders(USER).map((o) => o.id)))
    void resting
  })

  it('re-arms an in-flight ACTIVE market order with a fresh working window', async () => {
    const cfg: AdminConfig = { ...BASE_CONFIG, workingWindowMs: 60_000 }
    const first = new VenueStore(async () => 60_000, cfg)
    const o = first.place(USER, spot())

    // Simulate the restart landing AFTER the original window elapsed: the
    // persisted settleAfter is in the past.
    const snap = first.snapshot()
    const persisted = snap.orders.find((x) => x.id === o.id)
    if (persisted) persisted.settleAfter = Date.now() - 10_000

    const second = new VenueStore(async () => 60_000, { ...BASE_CONFIG })
    second.restore(snap)
    // Fresh window → the first sweep after boot must NOT settle it, so the
    // parasite reconciler still observes it open before it fills.
    await second.sweep()
    expect(second.order(o.id)?.status).toBe(10) // still ACTIVE
    expect(second.order(o.id)?.settleAfter).toBeGreaterThan(Date.now() + 30_000)
  })

  it('a restored resting order is still cancellable and fillable', async () => {
    const first = new VenueStore(async () => 60_000, { ...BASE_CONFIG, feeRate: 0 })
    const toCancel = first.place(USER, spot({ kind: 'limit' as const, rate: 50_000 }))
    const toFill = first.place(USER, spot({ kind: 'limit' as const, rate: 49_000 }))

    const second = new VenueStore(async () => 48_000, { ...BASE_CONFIG, feeRate: 0 })
    second.restore(first.snapshot())

    expect(second.cancel(toCancel.id)).toBe(true)
    expect(second.order(toCancel.id)?.status).toBe(50) // CANCELED
    // Price (48k) crossed the 49k limit buy → normal sweep path fills it.
    await second.sweep()
    expect(second.order(toFill.id)?.status).toBe(20) // SETTLED
  })

  it('rejects an unrecognized snapshot shape', () => {
    const store = new VenueStore(async () => 60_000, { ...BASE_CONFIG })
    expect(() => store.restore({ v: 999 })).toThrow(/snapshot/i)
    expect(() => store.restore(null)).toThrow(/snapshot/i)
  })
})

describe('restart durability across service instances (shared state store)', () => {
  const keys = new Map<string, ApiKeyRecord>([[KEY, { secret: SECRET, userId: USER }]])
  const build = (stateStore: InMemoryHostVenueStateStore, cfg: Partial<AdminConfig> = {}) =>
    buildService({
      store: new VenueStore(async () => 60_000, { ...BASE_CONFIG, ...cfg }),
      keys,
      uiUserId: USER,
      stateStore,
      persistDebounceMs: 5,
      // The admin surface is fail-closed without a token — these tests flip
      // drawer settings, so they run with one.
      adminToken: 'op-secret',
    })

  it('instance 2 boots from instance 1 state and serves it over the trade routes', async () => {
    const shared = new InMemoryHostVenueStateStore()

    // "Pod 1": human ticket rests a limit order, admin flips a drawer setting…
    const first = build(shared)
    const placed = await first.inject({
      method: 'POST',
      url: '/ui/orders',
      payload: {
        pairName: 'BTC-USDT',
        orderType: 0,
        tradeType: 10,
        qty: 0.1,
        rate: 50_000,
        clientOrderId: 't_persist',
      },
    })
    expect(placed.statusCode).toBe(200)
    const orderId = placed.json().orderId as number
    await first.inject({
      method: 'POST',
      url: '/admin/config',
      headers: { 'x-admin-token': 'op-secret' },
      payload: { slippagePct: 0.01 },
    })
    await first.close() // onClose flushes the pending debounced save

    // …"pod 2" (fresh store) restores the row before serving.
    const second = build(shared)
    const { payload, headers } = sign({ pairName: 'BTC-USDT' })
    const open = await second.inject({
      method: 'POST',
      url: '/api/v1/trade/orders/open',
      headers,
      payload,
    })
    expect(open.statusCode).toBe(200)
    const rows = open.json().data.orders as Array<{ id: number; clientOrderId?: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: orderId, clientOrderId: 't_persist' })

    // The admin drawer setting survived the restart too.
    const cfg = await second.inject({ method: 'GET', url: '/admin/config' })
    expect(cfg.json().slippagePct).toBe(0.01)

    // Still cancellable on the new instance, and the cancel persists onward.
    const cancel = await second.inject({ method: 'POST', url: `/ui/orders/${orderId}/cancel` })
    expect(cancel.json().ok).toBe(true)
    await second.close()

    const third = build(shared)
    const again = sign({ pairName: 'BTC-USDT' })
    const openAgain = await third.inject({
      method: 'POST',
      url: '/api/v1/trade/orders/open',
      headers: again.headers,
      payload: again.payload,
    })
    expect(openAgain.json().data.orders).toHaveLength(0)
    await third.close()
  })

  it('resetWallet persists — the clean slate survives a restart', async () => {
    const shared = new InMemoryHostVenueStateStore()
    const first = build(shared, { feeRate: 0, workingWindowMs: 0 })
    await first.ready()
    // Dirty the wallet with a settled market buy, then reset.
    await first.inject({
      method: 'POST',
      url: '/ui/orders',
      payload: { pairName: 'BTC-USDT', orderType: 0, tradeType: 20, qty: 0.5, rate: 60_000 },
    })
    await first.inject({ method: 'POST', url: '/ui/wallet/reset', payload: {} })
    await first.close()

    const second = build(shared)
    await second.ready()
    const { payload, headers } = sign({})
    const bal = await second.inject({
      method: 'POST',
      url: '/api/v1/trade/balance',
      headers,
      payload,
    })
    const byCcy = new Map(
      (bal.json().data as Array<{ currencyName: string; amount: number }>).map((b) => [
        b.currencyName,
        b.amount,
      ]),
    )
    expect(byCcy.get('USDT')).toBe(100_000)
    expect(byCcy.get('BTC')).toBe(2)
    await second.close()
  })
})

describe('debounced snapshot saves', () => {
  it('rapid mutations coalesce into a single save (snapshot taken at fire time)', async () => {
    const saves: Array<{ orders: number }> = []
    const store = new VenueStore(async () => 60_000, { ...BASE_CONFIG })
    const persister = new SnapshotPersister(
      async () => {
        saves.push({ orders: store.snapshot().orders.length })
      },
      () => {},
      1_000, // long window — nothing fires on its own during this test
    )
    store.subscribe(() => persister.schedule())

    for (let i = 0; i < 5; i++)
      store.place(USER, spot({ kind: 'limit' as const, rate: 50_000 + i }))
    expect(saves).toHaveLength(0) // still inside the window
    await persister.flush()
    expect(saves).toHaveLength(1) // 5 mutations → 1 write…
    expect(saves[0]?.orders).toBe(5) // …carrying ALL 5 orders (fire-time snapshot)
    await persister.flush()
    expect(saves).toHaveLength(1) // idle flush does not re-save
  })

  it('a failing save never throws into the trade path — it lands in onError', async () => {
    const errors: unknown[] = []
    const persister = new SnapshotPersister(
      async () => {
        throw new Error('pg down')
      },
      (err) => errors.push(err),
      1_000,
    )
    persister.schedule()
    await expect(persister.flush()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/pg down/)
  })
})
