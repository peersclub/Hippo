/**
 * Capability framework — venue capability discovery, the plan-tagged prepare
 * path (spot/futures_perp/options), and capability gating on the HTTP surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildService } from '../src/service.js'
import { SimVenueAdapter } from '../src/sim-venue.js'
import type {
  FuturesPerpPlan,
  Portfolio,
  PreparedTicket,
  PrepareRequest,
  VenueAdapter,
  VenueCapabilitiesShape,
} from '../src/types.js'

/** Minimal spot-only venue — the gating counterpart to the all-caps sim. */
class SpotOnlyAdapter implements VenueAdapter {
  async capabilities(): Promise<VenueCapabilitiesShape> {
    return { spot: {} }
  }
  async prepare(_req: PrepareRequest): Promise<PreparedTicket> {
    return {
      ticketId: 't_x',
      side: 'buy',
      instrument: 'BTC/USDT',
      orderType: 'market',
      rows: [],
      sideLabel: 'BUY · MKT',
    }
  }
  async confirm(): Promise<void> {}
  async cancel(): Promise<boolean> {
    return true
  }
  async portfolio(): Promise<Portfolio> {
    return { positions: [], openOrders: [] }
  }
  onEvent(): void {}
}

/**
 * Minimal perp-only venue — the counterpart that proves BOTH prepare wires gate
 * on capabilities. prepare()/prepareOrder() deliberately SUCCEED, so a route
 * that skipped the gate answers 200 and the test fails loudly instead of
 * passing for the wrong reason.
 */
class PerpOnlyAdapter implements VenueAdapter {
  async capabilities(): Promise<VenueCapabilitiesShape> {
    return { futures_perp: { maxLeverage: 20, marginModes: ['isolated'] } }
  }
  async prepare(_req: PrepareRequest): Promise<PreparedTicket> {
    return {
      ticketId: 't_ungated',
      side: 'buy',
      instrument: 'BTC/USDT',
      orderType: 'market',
      rows: [],
      sideLabel: 'BUY · MKT',
    }
  }
  async prepareOrder(): Promise<PreparedTicket> {
    return this.prepare({} as PrepareRequest)
  }
  async confirm(): Promise<void> {}
  async cancel(): Promise<boolean> {
    return true
  }
  async portfolio(): Promise<Portfolio> {
    return { positions: [], openOrders: [] }
  }
  onEvent(): void {}
}

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
  it('sim advertises all three capabilities; a spot-only venue advertises just spot', async () => {
    expect(Object.keys(await new SimVenueAdapter().capabilities()).sort()).toEqual([
      'futures_perp',
      'options',
      'spot',
    ])
    expect(await new SpotOnlyAdapter().capabilities()).toEqual({ spot: {} })
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
    const app = buildService(new SpotOnlyAdapter(), { internalToken: TOKEN })
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

describe('protective exits (attached stop-loss / take-profit)', () => {
  const protectedPlan = (o: Partial<FuturesPerpPlan> = {}): FuturesPerpPlan => ({
    ...perpPlan,
    stopLossPrice: '55000',
    takeProfitPrice: '70000',
    ...o,
  })

  it('sim + spot-only venues advertise protectiveExits truthfully', async () => {
    const simCaps = await new SimVenueAdapter().capabilities()
    expect(simCaps.spot?.protectiveExits).toBe(true)
    expect(simCaps.futures_perp?.protectiveExits).toBe(true)
    // The bare spot-only adapter never advertises it — the gate below relies on that.
    expect((await new SpotOnlyAdapter().capabilities()).spot?.protectiveExits).toBeUndefined()
  })

  it('perp ticket carries server-authored "Stop loss" / "Take profit" rows', async () => {
    const ticket = await new SimVenueAdapter().prepareOrder(protectedPlan())
    const rows = new Map(ticket.rows.map((r) => [r.label, r.value]))
    expect(rows.get('Stop loss')).toBe('55,000')
    expect(rows.get('Take profit')).toBe('70,000')
  })

  it('spot BUY ticket carries the rows too; spot SELL rejects protection outright', async () => {
    const sim = new SimVenueAdapter()
    const ticket = await sim.prepareOrder({
      capability: 'spot',
      partnerId: 'p',
      userId: 'u1',
      side: 'buy',
      size: '0.1',
      instrument: 'BTC/USDT',
      orderType: 'market',
      stopLossPrice: '55000',
      takeProfitPrice: '70000',
    })
    const labels = ticket.rows.map((r) => r.label)
    expect(labels).toContain('Stop loss')
    expect(labels).toContain('Take profit')

    await expect(
      sim.prepareOrder({
        capability: 'spot',
        partnerId: 'p',
        userId: 'u1',
        side: 'sell',
        size: '0.1',
        instrument: 'BTC/USDT',
        orderType: 'market',
        stopLossPrice: '55000',
      }),
    ).rejects.toThrow(/buy orders only/i)
  })

  it('validation matrix — long: stop < entry < tp; short: tp < entry < stop (quote 60,000)', async () => {
    const sim = new SimVenueAdapter()
    // long, stop above entry → reject
    await expect(sim.prepareOrder(protectedPlan({ stopLossPrice: '61000' }))).rejects.toThrow(
      /stop-loss.*below the entry/i,
    )
    // long, tp below entry → reject
    await expect(sim.prepareOrder(protectedPlan({ takeProfitPrice: '59000' }))).rejects.toThrow(
      /take-profit.*above the entry/i,
    )
    // short: the matrix flips
    const short = (o: Partial<FuturesPerpPlan>) =>
      protectedPlan({
        direction: 'short',
        stopLossPrice: undefined,
        takeProfitPrice: undefined,
        ...o,
      })
    await expect(sim.prepareOrder(short({ stopLossPrice: '59000' }))).rejects.toThrow(
      /stop-loss.*above the entry/i,
    )
    await expect(sim.prepareOrder(short({ takeProfitPrice: '61000' }))).rejects.toThrow(
      /take-profit.*below the entry/i,
    )
    // happy paths both directions
    await expect(sim.prepareOrder(protectedPlan())).resolves.toBeTruthy()
    await expect(
      sim.prepareOrder(short({ stopLossPrice: '65000', takeProfitPrice: '50000' })),
    ).resolves.toBeTruthy()
    // non-numeric junk is an honest reject, never a silent drop
    await expect(sim.prepareOrder(protectedPlan({ stopLossPrice: 'abc' }))).rejects.toThrow(
      /invalid stop-loss/i,
    )
    // a close can't carry protection — the close IS the exit
    await expect(
      sim.prepareOrder(protectedPlan({ action: 'close', reduceOnly: true })),
    ).rejects.toThrow(/opening orders only/i)
  })

  it('validates against the LIMIT entry when given (not the live quote)', async () => {
    // Limit entry 50,000 with stop 55,000: fine vs the 60k quote, nonsense vs
    // the actual entry — the seam must validate against the trader's price.
    await expect(
      new SimVenueAdapter().prepareOrder(
        protectedPlan({ orderType: 'limit', limitPrice: '50000', stopLossPrice: '55000' }),
      ),
    ).rejects.toThrow(/stop-loss.*below the entry/i)
  })

  it('HTTP: parse accepts the plan fields; a venue without protectiveExits 422s instead of dropping them', async () => {
    // Sim advertises protectiveExits → accepted, rows present.
    const simApp = buildService(new SimVenueAdapter(), { internalToken: TOKEN })
    const ok = await simApp.inject({
      method: 'POST',
      url: '/v1/prepare-order',
      headers: HDR,
      payload: JSON.stringify(protectedPlan()),
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().rows.map((r: { label: string }) => r.label)).toContain('Stop loss')

    // Spot-only venue without the flag: the SAME plan (spot-shaped) must be
    // rejected loudly — silently stripping a stop-loss is the one
    // unacceptable outcome.
    const bareApp = buildService(new SpotOnlyAdapter(), { internalToken: TOKEN })
    const res = await bareApp.inject({
      method: 'POST',
      url: '/v1/prepare-order',
      headers: HDR,
      payload: JSON.stringify({
        capability: 'spot',
        partnerId: 'p',
        userId: 'u1',
        side: 'buy',
        size: '0.1',
        instrument: 'BTC/USDT',
        orderType: 'market',
        stopLossPrice: '55000',
      }),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toMatch(/stop-loss\/take-profit is not supported/i)

    // Wrong TYPE on the wire (number, not money-string) → 400 invalid plan.
    const badType = await simApp.inject({
      method: 'POST',
      url: '/v1/prepare-order',
      headers: HDR,
      payload: JSON.stringify(protectedPlan({ stopLossPrice: 55000 as unknown as string })),
    })
    expect(badType.statusCode).toBe(400)
  })
})

/**
 * The legacy /v1/prepare wire. It shipped with NO capability gate while its
 * sibling /v1/prepare-order had one — and the gateway routes every plain spot
 * order to the ungated wire, so a venue that never advertised spot would still
 * get spot orders placed against it. Every gate case that exists for
 * /v1/prepare-order is mirrored here.
 */
describe('legacy /v1/prepare carries the same gates as /v1/prepare-order', () => {
  /** A spot request both wires parse: plain PrepareRequest fields plus the
   *  `capability` tag /v1/prepare-order needs (which /v1/prepare ignores). */
  const SPOT_PROBE = {
    capability: 'spot',
    partnerId: 'p',
    userId: 'u1',
    side: 'buy',
    size: '0.1',
    instrument: 'BTC/USDT',
    orderType: 'market',
  }

  it('mirror — happy path: a venue that advertises spot still prepares (200)', async () => {
    const app = buildService(new SimVenueAdapter(), { internalToken: TOKEN })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: JSON.stringify(SPOT_PROBE),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ticketId).toMatch(/^t_/)
  })

  it('mirror — capability gate: a spot order is rejected (422) on a venue without spot', async () => {
    const app = buildService(new PerpOnlyAdapter(), { internalToken: TOKEN })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: JSON.stringify(SPOT_PROBE),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toMatch(/not supported/i)
    // The adapter would have HAPPILY prepared it — only the gate stopped it.
    expect(res.json().ticketId).toBeUndefined()
  })

  it('mirror — protective exits: refused loudly rather than silently stripped', async () => {
    // /v1/prepare has no protective-exit fields in its parse, so accepting a
    // request that carries them would drop the trader's stop-loss on the floor.
    // Both a money-string and a wrong-typed number are a hard 400 that names
    // the wire which does carry protection.
    const app = buildService(new SimVenueAdapter(), { internalToken: TOKEN })
    for (const stopLossPrice of ['55000', 55_000 as unknown as string]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/prepare',
        headers: HDR,
        payload: JSON.stringify({ ...SPOT_PROBE, stopLossPrice }),
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/prepare-order/)
    }
    const tp = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: JSON.stringify({ ...SPOT_PROBE, takeProfitPrice: '70000' }),
    })
    expect(tp.statusCode).toBe(400)
  })

  it('mirror — a malformed body is still a 400, checked before the gate', async () => {
    const app = buildService(new PerpOnlyAdapter(), { internalToken: TOKEN })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: HDR,
      payload: JSON.stringify({ ...SPOT_PROBE, instrument: 'nonsense' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('mirror — the internal-token guard runs before anything else', async () => {
    const app = buildService(new SimVenueAdapter(), { internalToken: TOKEN })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prepare',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(SPOT_PROBE),
    })
    expect(res.statusCode).toBe(401)
  })

  /**
   * ROUTE PARITY. The defect was not "this one route forgot the gate" — it was
   * "nothing forces a NEW prepare wire to have one". So rather than name the
   * two routes we know about, read every prepare route back out of Fastify's
   * own router and require the gate from each. A third prepare wire lands in
   * this list the moment it is registered, and ships red until it gates.
   */
  it('route parity: EVERY registered prepare route runs the capability gate', async () => {
    const app = buildService(new PerpOnlyAdapter(), { internalToken: TOKEN })
    await app.ready()

    const routes = registeredPrepareRoutes(app)
    // Sanity: the enumeration really walked the router (a parser that silently
    // found nothing would make the loop below vacuously green).
    expect(routes).toEqual(expect.arrayContaining(['/v1/prepare', '/v1/prepare-order']))

    for (const url of routes) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: HDR,
        payload: JSON.stringify(SPOT_PROBE),
      })
      expect(res.statusCode, `${url} did not gate a spot order on a venue without spot`).toBe(422)
      expect(res.json().error, url).toMatch(/not supported/i)
    }
  })
})

/**
 * Every POST route whose path contains "prepare", read out of Fastify's router
 * via printRoutes(). The printout is a radix tree — `/v1/prepare` with a
 * `-order` child — so segments are re-joined by indentation depth to recover
 * full paths.
 */
function registeredPrepareRoutes(app: ReturnType<typeof buildService>): string[] {
  const stack: string[] = []
  const found: string[] = []
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const branch = /^((?:[│ ] {3})*)(?:├── |└── )(.*)$/.exec(line)
    if (!branch) continue
    const depth = branch[1].length / 4
    const methods = / \(([A-Z, ]+)\)$/.exec(branch[2])
    stack[depth] = methods ? branch[2].slice(0, -methods[0].length) : branch[2]
    stack.length = depth + 1
    const path = stack.join('')
    if (methods?.[1].split(', ').includes('POST') && path.includes('prepare')) found.push(path)
  }
  return found
}
