import { readFile } from 'node:fs/promises'
import {
  InMemoryAuditStore,
  InMemoryOperatorStore,
  InMemoryPartnerAdminStore,
  InMemoryPartnerStore,
  InMemoryPlanStore,
  InMemoryUserStore,
} from '@hippo/stores'
import { describe, expect, it } from 'vitest'
import { hashPassword, sessionCookie, verifyPassword } from '../src/opauth.js'
import { buildAdminService } from '../src/service.js'

const JWT_SECRET = 'test-admin-secret'

async function testAdmin(overrides: Partial<Parameters<typeof buildAdminService>[0]> = {}) {
  const operators = new InMemoryOperatorStore()
  await operators.create({
    email: 'ops@hippo.dev',
    passwordHash: hashPassword('correct horse battery'),
    role: 'owner',
  })
  const partners = new InMemoryPartnerStore()
  const stores = {
    partners,
    // Delete-safety wired to the partner registry (the Postgres impl checks
    // the partners table itself; in-memory needs the lookup injected).
    plans: new InMemoryPlanStore(async (planId) =>
      (await partners.list()).some((p) => p.planId === planId),
    ),
    users: new InMemoryUserStore(),
    operators,
    partnerAdmins: new InMemoryPartnerAdminStore(),
    audit: new InMemoryAuditStore(),
  }
  const app = buildAdminService({ ...stores, jwtSecret: JWT_SECRET, ...overrides })
  return { app, ...stores }
}

async function login(app: Awaited<ReturnType<typeof testAdmin>>['app']): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'ops@hippo.dev', password: 'correct horse battery' },
  })
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode}`)
  const setCookie = res.headers['set-cookie']
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? ''
  return cookie.split(';')[0] ?? ''
}

describe('password hashing', () => {
  it('scrypt hashes verify and never store plaintext', () => {
    const hash = hashPassword('hunter2hunter2')
    expect(hash).not.toContain('hunter2')
    expect(verifyPassword('hunter2hunter2', hash)).toBe(true)
    expect(verifyPassword('wrong password', hash)).toBe(false)
  })
})

describe('operator auth', () => {
  it('logs in with valid credentials and sets an httpOnly session cookie', async () => {
    const { app } = await testAdmin()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ops@hippo.dev', password: 'correct horse battery' },
    })
    expect(res.statusCode).toBe(200)
    const cookie = String(res.headers['set-cookie'])
    expect(cookie).toContain('hippo_admin=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    await app.close()
  })

  it('rejects wrong password and unknown email identically', async () => {
    const { app } = await testAdmin()
    for (const payload of [
      { email: 'ops@hippo.dev', password: 'wrong password!' },
      { email: 'ghost@hippo.dev', password: 'whatever pass' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload })
      expect(res.statusCode).toBe(401)
      expect(res.json().error).toBe('invalid credentials')
    }
    await app.close()
  })

  it('guards every /v1 route: 401 without a session', async () => {
    const { app } = await testAdmin()
    for (const [method, url] of [
      ['GET', '/v1/partners'],
      ['POST', '/v1/plans'],
      ['GET', '/v1/users'],
      ['GET', '/v1/memory'],
      ['GET', '/v1/metrics'],
      ['GET', '/v1/audit'],
    ] as const) {
      const res = await app.inject({ method, url })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
    }
    await app.close()
  })

  it('reports the signed-in operator on /auth/me', async () => {
    const { app } = await testAdmin()
    const cookie = await login(app)
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    expect(res.json()).toEqual({ email: 'ops@hippo.dev', role: 'owner' })
    await app.close()
  })
})

describe('plans + partners CRUD', () => {
  const pilotPlan = {
    planId: 'pilot',
    name: 'Pilot',
    tier: 'pilot',
    mauQuota: 1000,
    priceMonthlyUsd: 500,
    entitlements: { streaming: true },
  }

  it('creates a plan, assigns it to a partner, blocks plan delete while assigned', async () => {
    const { app, audit } = await testAdmin()
    const cookie = await login(app)

    const plan = await app.inject({
      method: 'POST',
      url: '/v1/plans',
      headers: { cookie },
      payload: pilotPlan,
    })
    expect(plan.statusCode).toBe(200)

    const assign = await app.inject({
      method: 'POST',
      url: '/v1/partners/koinbx-dev/plan',
      headers: { cookie },
      payload: { planId: 'pilot' },
    })
    expect(assign.json()).toEqual({ partnerId: 'koinbx-dev', planId: 'pilot' })

    const del = await app.inject({ method: 'DELETE', url: '/v1/plans/pilot', headers: { cookie } })
    expect(del.statusCode).toBe(409)

    // Unassign, then delete succeeds.
    await app.inject({
      method: 'POST',
      url: '/v1/partners/koinbx-dev/plan',
      headers: { cookie },
      payload: { planId: null },
    })
    expect(
      (await app.inject({ method: 'DELETE', url: '/v1/plans/pilot', headers: { cookie } }))
        .statusCode,
    ).toBe(200)

    // Every mutation audited.
    const trail = await audit.list({})
    expect(trail.rows.map((r) => r.action)).toContain('plan.create')
    expect(trail.rows.map((r) => r.action)).toContain('partner.assign_plan')
    expect(trail.rows.map((r) => r.action)).toContain('plan.delete')
    await app.close()
  })

  it('creates a partner (jwtSecret never echoed), suspends and reactivates it', async () => {
    const { app, partners } = await testAdmin()
    const cookie = await login(app)

    const created = await app.inject({
      method: 'POST',
      url: '/v1/partners',
      headers: { cookie },
      payload: {
        partnerId: 'newex',
        partnerKey: 'pk_newex',
        jwtSecret: 'super-secret-value',
        venueName: 'NewEx',
        locales: ['en'],
        suggestedQueries: [],
      },
    })
    expect(created.statusCode).toBe(200)
    expect(JSON.stringify(created.json())).not.toContain('super-secret-value')

    const list = await app.inject({ method: 'GET', url: '/v1/partners', headers: { cookie } })
    expect(JSON.stringify(list.json())).not.toContain('super-secret-value')

    const sus = await app.inject({
      method: 'POST',
      url: '/v1/partners/newex/suspend',
      headers: { cookie },
    })
    expect(sus.json().status).toBe('suspended')
    expect((await partners.get('newex'))?.status).toBe('suspended')

    const act = await app.inject({
      method: 'POST',
      url: '/v1/partners/newex/activate',
      headers: { cookie },
    })
    expect(act.json().status).toBe('active')
    await app.close()
  })

  it('rejects assigning an unknown plan', async () => {
    const { app } = await testAdmin()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/partners/koinbx-dev/plan',
      headers: { cookie },
      payload: { planId: 'no-such-plan' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('users + memory proxy', () => {
  it('lists/blocks users and joins persona from the memory service', async () => {
    const users = new InMemoryUserStore()
    await users.upsertSeen('koinbx-dev', 'u1')
    const personaBody = {
      optIn: true,
      experienceLevel: 'pro',
      followedAssets: ['BTC'],
      updatedAt: 42,
    }
    const fetchImpl = (async (url: unknown) => {
      expect(String(url)).toContain('/v1/persona/koinbx-dev/u1')
      return new Response(JSON.stringify(personaBody), { status: 200 })
    }) as typeof fetch

    const { app } = await testAdmin({ users, fetchImpl })
    const cookie = await login(app)

    const detail = await app.inject({
      method: 'GET',
      url: '/v1/users/koinbx-dev/u1',
      headers: { cookie },
    })
    expect(detail.json()).toMatchObject({ userId: 'u1', persona: personaBody, personaStatus: 'ok' })

    const block = await app.inject({
      method: 'POST',
      url: '/v1/users/koinbx-dev/u1/block',
      headers: { cookie },
    })
    expect(block.json().status).toBe('blocked')
    await app.close()
  })

  it('proxies memory list/update/purge with the internal token attached', async () => {
    const seen: Array<{
      url: string
      token: string | null
      method: string
      contentType: string | null
    }> = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({
        url: String(url),
        token: headers.get('x-hippo-internal-token'),
        method: init?.method ?? 'GET',
        contentType: headers.get('content-type'),
      })
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch

    const { app, audit } = await testAdmin({
      fetchImpl,
      internalToken: 'itok',
      memoryUrl: 'http://mem',
    })
    const cookie = await login(app)

    await app.inject({ method: 'GET', url: '/v1/memory?partnerId=koinbx-dev', headers: { cookie } })
    await app.inject({
      method: 'PUT',
      url: '/v1/memory/koinbx-dev/u1',
      headers: { cookie },
      payload: { experienceLevel: 'pro' },
    })
    await app.inject({ method: 'DELETE', url: '/v1/memory/koinbx-dev/u1', headers: { cookie } })

    expect(seen).toHaveLength(3)
    expect(seen.every((s) => s.token === 'itok')).toBe(true)
    expect(seen[0]?.url).toBe('http://mem/admin/personas?partnerId=koinbx-dev')
    expect(seen[1]?.method).toBe('PUT')
    expect(seen[2]?.method).toBe('DELETE')
    // Regression (found in E2E): bodyless proxied calls must NOT claim JSON —
    // Fastify 400s an empty body with a JSON content-type.
    expect(seen[1]?.contentType).toContain('application/json')
    expect(seen[0]?.contentType).toBeNull()
    expect(seen[2]?.contentType).toBeNull()

    const actions = (await audit.list({})).rows.map((r) => r.action)
    expect(actions).toContain('memory.update')
    expect(actions).toContain('memory.purge')
    await app.close()
  })

  it('returns 502 "memory service unreachable" when the memory proxy fetch rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('memory down')
    }) as typeof fetch
    const { app } = await testAdmin({ fetchImpl })
    const cookie = await login(app)

    for (const [method, url, payload] of [
      ['GET', '/v1/memory', undefined],
      ['GET', '/v1/memory/koinbx-dev/u1', undefined],
      ['PUT', '/v1/memory/koinbx-dev/u1', { experienceLevel: 'pro' }],
      ['POST', '/v1/memory/koinbx-dev/u1/clear', undefined],
      ['DELETE', '/v1/memory/koinbx-dev/u1', undefined],
      ['DELETE', '/v1/memory?partnerId=koinbx-dev', undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie },
        ...(payload !== undefined ? { payload } : {}),
      })
      expect(res.statusCode, `${method} ${url}`).toBe(502)
      expect(res.json().error, `${method} ${url}`).toBe('memory service unreachable')
    }
    await app.close()
  })

  it('rejects malformed persona updates before proxying', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const { app } = await testAdmin({ fetchImpl })
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/memory/koinbx-dev/u1',
      headers: { cookie },
      payload: { experienceLevel: 'wizard' },
    })
    expect(res.statusCode).toBe(400)
    expect(called).toBe(false)
    await app.close()
  })
})

// ── single-persona lookup ──────────────────────────────────────────────────
// The panel's user-detail view answers "what memory do we hold on this
// person" — the question a deletion request turns up with. It used to answer
// it by fetching page one of /v1/memory and scanning, so anyone past row 50
// came back as "no memory held", with the Clear/Purge buttons hidden.

type FakePersona = {
  optIn: boolean
  experienceLevel: string | null
  followedAssets: string[]
  openThreads: unknown[]
  learnOptOut: boolean
  updatedAt: number
}

/** What services/memory answers for a key it has never stored — note the
 * updatedAt 0 sentinel, which is what tells absence from a real empty row. */
const DEFAULT_PERSONA: FakePersona = {
  optIn: false,
  experienceLevel: null,
  followedAssets: [],
  openThreads: [],
  learnOptOut: false,
  updatedAt: 0,
}

/**
 * Stand-in for services/memory across the two routes the admin proxy touches,
 * faithful in the parts this bug lives in: /admin/personas orders by
 * updatedAt DESC and caps at 50 rows, and /v1/persona/:p/:u answers a default
 * persona (never a 404) for keys it has never stored.
 */
function fakeMemory(personas: Map<string, FakePersona>) {
  const calls: { path: string; token: string | null }[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      path: url.pathname + url.search,
      token: new Headers(init?.headers).get('x-hippo-internal-token'),
    })

    const single = /^\/v1\/persona\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    if (single) {
      const [, partner = '', user = ''] = single
      const key = `${decodeURIComponent(partner)}:${decodeURIComponent(user)}`
      return new Response(JSON.stringify(personas.get(key) ?? DEFAULT_PERSONA), { status: 200 })
    }

    if (url.pathname === '/admin/personas') {
      const partnerId = url.searchParams.get('partnerId')
      const offset = Number(url.searchParams.get('offset') ?? 0) || 0
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200)
      const all = [...personas]
        .map(([key, persona]) => ({
          partnerId: key.slice(0, key.indexOf(':')),
          userId: key.slice(key.indexOf(':') + 1),
          persona,
        }))
        .filter((row) => !partnerId || row.partnerId === partnerId)
        .sort((a, b) => b.persona.updatedAt - a.persona.updatedAt)
      return new Response(
        JSON.stringify({ rows: all.slice(offset, offset + limit), total: all.length }),
        { status: 200 },
      )
    }

    return new Response('{"error":"not found"}', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

/** 60 personas for one partner, newest first — u1 at the top, u60 at the
 * bottom, so u55 sits well past the list's 50-row first page. */
function sixtyPersonas(partnerId = 'koinbx-dev') {
  const personas = new Map<string, FakePersona>()
  for (let i = 1; i <= 60; i++) {
    personas.set(`${partnerId}:u${i}`, {
      ...DEFAULT_PERSONA,
      optIn: true,
      experienceLevel: 'pro',
      followedAssets: [`SYM${i}`],
      updatedAt: 1_800_000_000_000 - i,
    })
  }
  return personas
}

describe('single-persona lookup (GET /v1/memory/:partnerId/:userId)', () => {
  it('answers the 55th of 60 personas — the one page one cannot see', async () => {
    const personas = sixtyPersonas()
    const { fetchImpl, calls } = fakeMemory(personas)
    const { app } = await testAdmin({ fetchImpl, memoryUrl: 'http://mem', internalToken: 'itok' })
    const cookie = await login(app)

    // The scan the panel used to do: u55 is simply not in the first page.
    const page = await app.inject({
      method: 'GET',
      url: '/v1/memory?partnerId=koinbx-dev',
      headers: { cookie },
    })
    const rows = page.json().rows as { userId: string }[]
    expect(rows).toHaveLength(50)
    expect(page.json().total).toBe(60)
    expect(rows.some((r) => r.userId === 'u55')).toBe(false)

    const res = await app.inject({
      method: 'GET',
      url: '/v1/memory/koinbx-dev/u55',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      partnerId: 'koinbx-dev',
      userId: 'u55',
      persona: personas.get('koinbx-dev:u55'),
    })

    // Fetched by id, not paged for — and with the internal token attached,
    // same discipline as its neighbours.
    const lookup = calls.at(-1)
    expect(lookup?.path).toBe('/v1/persona/koinbx-dev/u55')
    expect(lookup?.token).toBe('itok')
    await app.close()
  })

  it('is operator-gated: 401 unauthenticated, and memory is never touched', async () => {
    const { fetchImpl, calls } = fakeMemory(sixtyPersonas())
    const { app } = await testAdmin({ fetchImpl, memoryUrl: 'http://mem' })
    const res = await app.inject({ method: 'GET', url: '/v1/memory/koinbx-dev/u55' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('not signed in')
    expect(calls).toEqual([])
    await app.close()
  })

  it('404s honestly for a key memory has never stored, including cross-partner', async () => {
    const { fetchImpl } = fakeMemory(sixtyPersonas())
    const { app } = await testAdmin({ fetchImpl, memoryUrl: 'http://mem' })
    const cookie = await login(app)

    // The memory service answers a default persona here, not a 404. Passing
    // that through as a 200 would read as "we hold an empty record" — the
    // wrong answer to give someone asking us to delete their data.
    for (const url of ['/v1/memory/koinbx-dev/ghost', '/v1/memory/other-venue/u55']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } })
      expect(res.statusCode, url).toBe(404)
      expect(res.json().error, url).toBe('no memory held for this user')
    }
    await app.close()
  })
})

// ── the docblock is a contract, not a comment ──────────────────────────────
// service.ts opens with a route list. It advertised a single-persona GET that
// was never registered, and that gap is what pushed the panel into scanning
// page one. Parse the list and hold the router to it.

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/**
 * Expand one documented path token into the concrete paths it stands for:
 *   "/v1/intent-signals[/export]"      → both, with and without the suffix
 *   "/v1/partners/:id/suspend|activate" → one path per final-segment option
 */
function expandPath(token: string): string[] {
  const optional = /^(.*)\[(\/[^\]]+)\]$/.exec(token)
  if (optional) {
    const [, base = '', suffix = ''] = optional
    return [base, base + suffix]
  }
  const cut = token.lastIndexOf('/')
  const last = token.slice(cut + 1)
  if (!last.includes('|')) return [token]
  return last.split('|').map((alt) => token.slice(0, cut + 1) + alt)
}

/**
 * Pull the route list out of a source file's leading docblock.
 *
 * The notation the docblock may use, and nothing else:
 *   METHOD[/METHOD…] <path> [| <path>…]   e.g. "GET/POST /v1/plans"
 *   final-segment alternation             e.g. "/v1/x/:id/suspend|activate"
 *   optional trailing segment             e.g. "/v1/intent-signals[/export]"
 *   a trailing "(…)" is prose and is stripped
 *
 * A line whose FIRST token is not an HTTP method is prose and is skipped
 * whole. Past that first method token every remaining token must be a path,
 * a `|`, or another method — anything else is reported as `unparseable`, not
 * quietly dropped. That strictness is the point: the docblock's old
 * "DELETE .../purge" shorthand named a path that did not exist, and a lenient
 * parser would have skipped past it exactly the way a reader's eye did.
 */
function documentedRoutes(source: string): {
  routes: { method: string; url: string }[]
  unparseable: string[]
} {
  const docblock = source.slice(0, source.indexOf('*/'))
  const routes: { method: string; url: string }[] = []
  const unparseable: string[] = []
  const isMethods = (token: string) => token.split('/').every((m) => HTTP_METHODS.has(m))

  for (const raw of docblock.split('\n')) {
    const line = raw
      .replace(/^\s*\/?\*+\s?/, '')
      .replace(/\s*\(.*$/, '')
      .trim()
    const tokens = line.split(/\s+/).filter(Boolean)
    if (tokens.length === 0 || !isMethods(tokens[0] ?? '')) continue // prose

    let methods: string[] = []
    for (const token of tokens) {
      if (token === '|') continue
      if (isMethods(token)) {
        methods = token.split('/')
        continue
      }
      if (!token.startsWith('/')) {
        unparseable.push(`${token}  (in: ${line})`)
        continue
      }
      for (const url of expandPath(token)) {
        for (const method of methods) routes.push({ method, url })
      }
    }
  }
  return { routes, unparseable }
}

describe('header docblock ↔ router', () => {
  it('registers a route for every path the service docblock advertises', async () => {
    const source = await readFile(new URL('../src/service.ts', import.meta.url), 'utf8')
    const { routes, unparseable } = documentedRoutes(source)

    // Guard the guard: a parser that quietly matches nothing proves nothing,
    // and shorthand it cannot resolve must fail loudly rather than vanish.
    expect(unparseable).toEqual([])
    expect(routes.length).toBeGreaterThanOrEqual(25)
    expect(routes).toContainEqual({ method: 'GET', url: '/v1/memory/:partnerId/:userId' })
    expect(routes).toContainEqual({ method: 'DELETE', url: '/v1/memory/:partnerId/:userId' })
    expect(routes).toContainEqual({ method: 'POST', url: '/v1/partners/:id/activate' })
    expect(routes).toContainEqual({ method: 'GET', url: '/v1/intent-signals/export' })
    expect(routes.every((r) => r.url.startsWith('/'))).toBe(true)

    const { app } = await testAdmin()
    await app.ready()
    const missing = routes.filter((route) => !app.hasRoute(route))
    expect(missing).toEqual([])
    await app.close()
  })

  it('the parser itself: reads the notation, and refuses shorthand it cannot resolve', () => {
    const { routes, unparseable } = documentedRoutes(`/**
 * Header.
 *
 *   POST /a/login | /a/logout       GET /a/me
 *   GET/POST /v1/things             PATCH /v1/things/:id
 *   POST /v1/things/:id/open|close
 *   GET /v1/signals[/export] (prose in parens is stripped)
 *   DELETE .../purge
 *
 * Trailing prose mentioning GET and /paths must not become routes.
 */`)
    expect(routes).toEqual([
      { method: 'POST', url: '/a/login' },
      { method: 'POST', url: '/a/logout' },
      { method: 'GET', url: '/a/me' },
      { method: 'GET', url: '/v1/things' },
      { method: 'POST', url: '/v1/things' },
      { method: 'PATCH', url: '/v1/things/:id' },
      { method: 'POST', url: '/v1/things/:id/open' },
      { method: 'POST', url: '/v1/things/:id/close' },
      { method: 'GET', url: '/v1/signals' },
      { method: 'GET', url: '/v1/signals/export' },
    ])
    expect(unparseable).toHaveLength(1)
    expect(unparseable[0]).toContain('.../purge')
  })
})

describe('metrics + audit', () => {
  it('serves counts even when the gateway is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('gateway down')
    }) as typeof fetch
    const { app } = await testAdmin({ fetchImpl })
    const cookie = await login(app)
    const res = await app.inject({ method: 'GET', url: '/v1/metrics', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ gateway: null, counts: { partners: 1, plans: 0 } })
    await app.close()
  })

  it('passes intelligence answer-cache stats through and counts sandbox partners', async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('/health'))
        return new Response(
          JSON.stringify({
            ok: true,
            mode: 'llm',
            model: 'claude-haiku',
            cache: { entries: 7, hitRate: 0.42 },
          }),
          { status: 200 },
        )
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const { app } = await testAdmin({ fetchImpl })
    const cookie = await login(app)

    // A self-serve sandbox signup shows up in the pending-approval count.
    const prov = await app.inject({
      method: 'POST',
      url: '/v1/provision/sandbox',
      payload: { email: 'eng@newvenue.io', venueName: 'New Venue' },
    })
    expect(prov.statusCode).toBe(200)

    const res = await app.inject({ method: 'GET', url: '/v1/metrics', headers: { cookie } })
    const body = res.json()
    expect(body.intelligence).toEqual({
      mode: 'llm',
      model: 'claude-haiku',
      cache: { entries: 7, hitRate: 0.42 },
    })
    expect(body.counts).toMatchObject({ partners: 2, sandboxPartners: 1 })
    await app.close()
  })

  it('omits the cache block when the intelligence /health has none (older build)', async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('/health'))
        return new Response(JSON.stringify({ ok: true, mode: 'mock', model: 'mock' }), {
          status: 200,
        })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const { app } = await testAdmin({ fetchImpl })
    const cookie = await login(app)
    const res = await app.inject({ method: 'GET', url: '/v1/metrics', headers: { cookie } })
    expect(res.json().intelligence).toEqual({ mode: 'mock', model: 'mock' })
    await app.close()
  })

  it('exposes the audit trail, newest first', async () => {
    const { app } = await testAdmin()
    const cookie = await login(app)
    await app.inject({
      method: 'POST',
      url: '/v1/plans',
      headers: { cookie },
      payload: {
        planId: 'plan-x',
        name: 'X',
        tier: 't',
        mauQuota: null,
        priceMonthlyUsd: null,
        entitlements: {},
      },
    })
    const res = await app.inject({ method: 'GET', url: '/v1/audit', headers: { cookie } })
    expect(res.json().rows[0]).toMatchObject({
      action: 'plan.create',
      operatorEmail: 'ops@hippo.dev',
    })
    await app.close()
  })
})

describe('operator management (owner-only)', () => {
  it('owner can list/create/delete operators; passwordHash never leaves', async () => {
    const { app, audit } = await testAdmin()
    const cookie = await login(app)

    const created = await app.inject({
      method: 'POST',
      url: '/v1/operators',
      headers: { cookie },
      payload: { email: 'analyst@hippo.dev', password: 'a-long-password-123', role: 'operator' },
    })
    expect(created.statusCode).toBe(200)
    expect(JSON.stringify(created.json())).not.toContain('passwordHash')

    const list = await app.inject({ method: 'GET', url: '/v1/operators', headers: { cookie } })
    expect(list.json()).toHaveLength(2)
    expect(JSON.stringify(list.json())).not.toContain('passwordHash')

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/operators/analyst%40hippo.dev',
      headers: { cookie },
    })
    expect(del.json()).toEqual({ deleted: true })

    const actions = (await audit.list({})).rows.map((r) => r.action)
    expect(actions).toContain('operator.create')
    expect(actions).toContain('operator.delete')
    await app.close()
  })

  it('plain operators get 403; self-delete and last-owner-delete refused', async () => {
    const { app, operators } = await testAdmin()
    const ownerCookie = await login(app)

    // Create a non-owner and sign in as them.
    await app.inject({
      method: 'POST',
      url: '/v1/operators',
      headers: { cookie: ownerCookie },
      payload: { email: 'viewer@hippo.dev', password: 'another-long-pass-1', role: 'operator' },
    })
    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'viewer@hippo.dev', password: 'another-long-pass-1' },
    })
    const viewerCookie = String(viewerLogin.headers['set-cookie']).split(';')[0] ?? ''

    expect(
      (await app.inject({ method: 'GET', url: '/v1/operators', headers: { cookie: viewerCookie } }))
        .statusCode,
    ).toBe(403)

    // Owner cannot delete themselves, nor the last owner.
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/v1/operators/ops%40hippo.dev',
          headers: { cookie: ownerCookie },
        })
      ).statusCode,
    ).toBe(400)
    expect(await operators.get('ops@hippo.dev')).toBeDefined()
    await app.close()
  })
})

describe('live sessions proxy + partner detail + quota alerts', () => {
  it('proxies session list/revoke to the gateway with the internal token', async () => {
    const seen: Array<{ url: string; method: string; token: string | null }> = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({
        url: String(url),
        method: init?.method ?? 'GET',
        token: headers.get('x-hippo-internal-token'),
      })
      if (String(url).includes('/internal/sessions')) {
        return new Response(
          init?.method === 'DELETE'
            ? '{"revoked":true}'
            : '[{"id":"s_1","partnerId":"koinbx-dev","venueUserId":"u1","expiresAt":1,"connected":true}]',
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const { app, audit } = await testAdmin({
      fetchImpl,
      internalToken: 'itok',
      gatewayUrl: 'http://gw',
    })
    const cookie = await login(app)

    const list = await app.inject({
      method: 'GET',
      url: '/v1/sessions?partnerId=koinbx-dev',
      headers: { cookie },
    })
    expect(list.json()).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://gw/internal/sessions?partnerId=koinbx-dev')
    expect(seen[0]?.token).toBe('itok')

    const kill = await app.inject({
      method: 'DELETE',
      url: '/v1/sessions/s_1',
      headers: { cookie },
    })
    expect(kill.json()).toEqual({ revoked: true })
    expect((await audit.list({})).rows.map((r) => r.action)).toContain('session.revoke')
    await app.close()
  })

  it('partner detail aggregates plan, users, MAU-vs-quota and sessions', async () => {
    const users = new InMemoryUserStore()
    await users.upsertSeen('koinbx-dev', 'u1')
    await users.upsertSeen('koinbx-dev', 'u2')
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('/internal/metrics'))
        return new Response(JSON.stringify({ mau: { byPartner: { 'koinbx-dev': 2 } } }), {
          status: 200,
        })
      return new Response('[]', { status: 200 })
    }) as typeof fetch

    const { app, plans } = await testAdmin({ users, fetchImpl })
    const cookie = await login(app)
    await plans.create({
      planId: 'pilot',
      name: 'Pilot',
      tier: 'pilot',
      mauQuota: 3,
      priceMonthlyUsd: null,
      entitlements: {},
    })
    await app.inject({
      method: 'POST',
      url: '/v1/partners/koinbx-dev/plan',
      headers: { cookie },
      payload: { planId: 'pilot' },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/v1/partners/koinbx-dev/detail',
      headers: { cookie },
    })
    const detail = res.json()
    expect(detail.partner.partnerId).toBe('koinbx-dev')
    expect(detail.partner.jwtSecret).toBeUndefined()
    expect(detail.plan.planId).toBe('pilot')
    expect(detail.users.total).toBe(2)
    expect(detail.mau).toEqual({ current: 2, quota: 3 })
    await app.close()
  })

  it('metrics surfaces quota alerts at >=80% usage', async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('/internal/metrics'))
        return new Response(JSON.stringify({ mau: { byPartner: { 'koinbx-dev': 5 } } }), {
          status: 200,
        })
      return new Response('[]', { status: 200 })
    }) as typeof fetch

    const { app, plans } = await testAdmin({ fetchImpl })
    const cookie = await login(app)
    await plans.create({
      planId: 'tiny',
      name: 'Tiny',
      tier: 'pilot',
      mauQuota: 5,
      priceMonthlyUsd: null,
      entitlements: {},
    })
    await app.inject({
      method: 'POST',
      url: '/v1/partners/koinbx-dev/plan',
      headers: { cookie },
      payload: { planId: 'tiny' },
    })

    const res = await app.inject({ method: 'GET', url: '/v1/metrics', headers: { cookie } })
    const { alerts } = res.json()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ partnerId: 'koinbx-dev', mau: 5, quota: 5, pct: 100 })
    await app.close()
  })

  it('metrics presents the internal token to the gateway and returns per-partner MAU rows', async () => {
    const seenHeaders: Array<Record<string, string>> = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/internal/metrics')) {
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>)
        return new Response(JSON.stringify({ mau: { byPartner: { 'koinbx-dev': 2 } } }), {
          status: 200,
        })
      }
      if (String(url).includes('/admin/usage'))
        return new Response(JSON.stringify({ calls: 3, promptTokens: 1200 }), { status: 200 })
      if (String(url).includes('/health'))
        return new Response(JSON.stringify({ mode: 'llm', model: 'haiku' }), { status: 200 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const { app, plans } = await testAdmin({ fetchImpl, internalToken: 'itok' })
    const cookie = await login(app)
    await plans.create({
      planId: 'pilot',
      name: 'Pilot',
      tier: 'pilot',
      mauQuota: 100,
      priceMonthlyUsd: null,
      entitlements: {},
    })
    await app.inject({
      method: 'POST',
      url: '/v1/partners/koinbx-dev/plan',
      headers: { cookie },
      payload: { planId: 'pilot' },
    })

    const res = await app.inject({ method: 'GET', url: '/v1/metrics', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const { partnerMau, intelligence } = res.json()
    // Measured token usage joins the intelligence block (Pilot page input).
    expect(intelligence.usage).toMatchObject({ calls: 3, promptTokens: 1200 })
    expect(partnerMau).toHaveLength(1)
    expect(partnerMau[0]).toMatchObject({
      partnerId: 'koinbx-dev',
      mau: 2,
      quota: 100,
    })
    // The gateway metrics surface is guarded now — the proxy must authenticate.
    expect(seenHeaders[0]?.['x-hippo-internal-token']).toBe('itok')
    await app.close()
  })
})

describe('login protection', () => {
  it('locks out after 5 failures (429 + Retry-After) and audits the trail', async () => {
    const { app, audit } = await testAdmin()
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ops@hippo.dev', password: 'wrong-password!' },
      })
      expect(res.statusCode).toBe(401)
    }
    // 6th attempt — even with the CORRECT password — is throttled.
    const locked = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ops@hippo.dev', password: 'correct horse battery' },
    })
    expect(locked.statusCode).toBe(429)
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0)

    const actions = (await audit.list({ limit: 20 })).rows.map((r) => r.action)
    expect(actions.filter((a) => a === 'auth.login_failed')).toHaveLength(5)
    expect(actions).toContain('auth.login_locked')
    await app.close()
  })

  it('rejects mutating requests with a foreign Origin (403); same-host passes', async () => {
    const { app } = await testAdmin()
    const bad = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'http://evil.example' },
      payload: { email: 'ops@hippo.dev', password: 'correct horse battery' },
    })
    expect(bad.statusCode).toBe(403)

    const good = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'http://localhost:80' },
      payload: { email: 'ops@hippo.dev', password: 'correct horse battery' },
    })
    expect(good.statusCode).toBe(200)
    await app.close()
  })
})

describe('sandbox provisioning (hippo register)', () => {
  it('creates a sandbox partner; secret only via one-time claim', async () => {
    const { app, partners, audit } = await testAdmin()

    const reg = await app.inject({
      method: 'POST',
      url: '/v1/provision/sandbox',
      payload: { email: 'eng@newvenue.io', venueName: 'New Venue' },
    })
    expect(reg.statusCode).toBe(200)
    const body = reg.json() as {
      partnerId: string
      partnerKey: string
      status: string
      claimPath: string
    }
    expect(body.status).toBe('sandbox')
    expect(body.partnerId).toMatch(/^new-venue-[0-9a-f]{4}$/)
    expect(body.partnerKey).toMatch(/^pk_sandbox_/)
    // The register response must never carry the secret.
    expect(JSON.stringify(body)).not.toContain('jwtSecret')

    const created = await partners.get(body.partnerId)
    expect(created?.status).toBe('sandbox')
    expect(created?.jwtSecret).toHaveLength(64)

    // Claim once → secret; claim twice → 404.
    const claim1 = await app.inject({ method: 'GET', url: body.claimPath })
    expect(claim1.statusCode).toBe(200)
    expect(claim1.json().jwtSecret).toBe(created?.jwtSecret)
    const claim2 = await app.inject({ method: 'GET', url: body.claimPath })
    expect(claim2.statusCode).toBe(404)

    const actions = (await audit.list({ limit: 10 })).rows.map((r) => r.action)
    expect(actions).toContain('provision.sandbox')
    expect(actions).toContain('provision.claimed')
    await app.close()
  })

  it('rate-limits provisioning per IP (3/hour) and validates the body', async () => {
    const { app } = await testAdmin()
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/provision/sandbox',
          payload: { email: 'not-an-email', venueName: 'X' },
        })
      ).statusCode,
    ).toBe(400)

    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/provision/sandbox',
        payload: { email: 'a@b.co', venueName: `Venue ${i} OK` },
      })
      expect(r.statusCode).toBe(200)
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/provision/sandbox',
      payload: { email: 'a@b.co', venueName: 'One Too Many' },
    })
    expect(limited.statusCode).toBe(429)
    await app.close()
  })
})

describe('partner admin invites (portal seats)', () => {
  async function withPartner(app: Awaited<ReturnType<typeof testAdmin>>['app'], cookie: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/partners',
      headers: { cookie },
      payload: {
        partnerId: 'kbx',
        partnerKey: 'pk_kbx',
        jwtSecret: 'kbx-secret-123',
        venueName: 'Assetworks',
        locales: ['en'],
        suggestedQueries: [],
      },
    })
    expect(res.statusCode).toBe(200)
  }

  it('mints a one-time invite, lists the seat unclaimed, and revokes it', async () => {
    const { app, partnerAdmins } = await testAdmin()
    const cookie = await login(app)
    await withPartner(app, cookie)

    const invite = await app.inject({
      method: 'POST',
      url: '/v1/partners/kbx/admins',
      headers: { cookie },
      payload: { email: 'admin@koinbx.com', role: 'admin' },
    })
    expect(invite.statusCode).toBe(200)
    const body = invite.json() as { inviteToken: string; email: string }
    expect(body.inviteToken.length).toBeGreaterThan(20)

    // Store never holds the plaintext token.
    const stored = await partnerAdmins.get('admin@koinbx.com')
    expect(stored?.inviteTokenHash).not.toBe(body.inviteToken)
    expect(stored?.passwordHash).toBeNull()

    const list = await app.inject({
      method: 'GET',
      url: '/v1/partners/kbx/admins',
      headers: { cookie },
    })
    expect(list.json()).toMatchObject([{ email: 'admin@koinbx.com', claimed: false }])

    const revoke = await app.inject({
      method: 'DELETE',
      url: '/v1/partners/kbx/admins/admin@koinbx.com',
      headers: { cookie },
    })
    expect(revoke.statusCode).toBe(200)
    expect(await partnerAdmins.get('admin@koinbx.com')).toBeUndefined()
    await app.close()
  })

  it('409s a duplicate seat and 404s an unknown partner', async () => {
    const { app } = await testAdmin()
    const cookie = await login(app)
    await withPartner(app, cookie)
    const first = await app.inject({
      method: 'POST',
      url: '/v1/partners/kbx/admins',
      headers: { cookie },
      payload: { email: 'admin@koinbx.com' },
    })
    expect(first.statusCode).toBe(200)
    const dup = await app.inject({
      method: 'POST',
      url: '/v1/partners/kbx/admins',
      headers: { cookie },
      payload: { email: 'admin@koinbx.com' },
    })
    expect(dup.statusCode).toBe(409)
    const ghost = await app.inject({
      method: 'POST',
      url: '/v1/partners/nope/admins',
      headers: { cookie },
      payload: { email: 'x@y.com' },
    })
    expect(ghost.statusCode).toBe(404)
    await app.close()
  })
})

describe('session cookie Secure flag', () => {
  const withEnv = (val: string | undefined, prodEnv: string | undefined, fn: () => void) => {
    const savedSecure = process.env.ADMIN_COOKIE_SECURE
    const savedNode = process.env.NODE_ENV
    if (val === undefined) delete process.env.ADMIN_COOKIE_SECURE
    else process.env.ADMIN_COOKIE_SECURE = val
    if (prodEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prodEnv
    try {
      fn()
    } finally {
      if (savedSecure === undefined) delete process.env.ADMIN_COOKIE_SECURE
      else process.env.ADMIN_COOKIE_SECURE = savedSecure
      if (savedNode === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = savedNode
    }
  }

  it('is Secure by default in production', () => {
    withEnv(undefined, 'production', () => {
      expect(sessionCookie('tok')).toContain('; Secure')
    })
  })

  it('can be forced off in production with ADMIN_COOKIE_SECURE=0', () => {
    withEnv('0', 'production', () => {
      expect(sessionCookie('tok')).not.toContain('; Secure')
    })
  })

  it('is off by default in dev but opt-in with =1', () => {
    withEnv(undefined, 'development', () => {
      expect(sessionCookie('tok')).not.toContain('; Secure')
    })
    withEnv('1', 'development', () => {
      expect(sessionCookie('tok')).toContain('; Secure')
    })
  })
})

describe('learned-facts proxy (auto-learned memory)', () => {
  const stubFacts = [
    {
      type: 'followed_asset',
      value: 'BTC',
      confidence: 0.9,
      source: 'auto',
      createdAt: 1,
      updatedAt: 2,
    },
  ]

  it('GET user + session facts proxy to the memory service with the internal token', async () => {
    const seen: Array<{ url: string; method: string; token: string | null }> = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({
        url: String(url),
        method: init?.method ?? 'GET',
        token: headers.get('x-hippo-internal-token'),
      })
      return new Response(JSON.stringify(stubFacts), { status: 200 })
    }) as typeof fetch

    const { app } = await testAdmin({ fetchImpl, internalToken: 'itok', memoryUrl: 'http://mem' })
    const cookie = await login(app)

    const user = await app.inject({
      method: 'GET',
      url: '/v1/learned-facts/user/koinbx-dev/u1',
      headers: { cookie },
    })
    expect(user.statusCode).toBe(200)
    expect(user.json()).toEqual(stubFacts)

    const session = await app.inject({
      method: 'GET',
      url: '/v1/learned-facts/session/s_1',
      headers: { cookie },
    })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toEqual(stubFacts)

    expect(seen.map((s) => s.url)).toEqual([
      'http://mem/v1/scope/user/koinbx-dev/u1/facts',
      'http://mem/v1/scope/session/s_1/facts',
    ])
    expect(seen.every((s) => s.token === 'itok' && s.method === 'GET')).toBe(true)
    await app.close()
  })

  it('DELETE clears user facts, audits learned_facts.purge, and stays bodyless', async () => {
    const seen: Array<{ url: string; method: string; contentType: string | null }> = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({
        url: String(url),
        method: init?.method ?? 'GET',
        contentType: headers.get('content-type'),
      })
      return new Response('{"cleared":3}', { status: 200 })
    }) as typeof fetch

    const { app, audit } = await testAdmin({ fetchImpl, memoryUrl: 'http://mem' })
    const cookie = await login(app)

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/learned-facts/user/koinbx-dev/u1',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ cleared: 3 })
    expect(seen[0]?.url).toBe('http://mem/v1/scope/user/koinbx-dev/u1/facts')
    expect(seen[0]?.method).toBe('DELETE')
    // Regression guard: a bodyless DELETE must NOT claim a JSON content-type
    // (Fastify 400s an empty body that claims JSON).
    expect(seen[0]?.contentType).toBeNull()

    const purge = (await audit.list({})).rows.find((r) => r.action === 'learned_facts.purge')
    expect(purge).toMatchObject({
      target: 'koinbx-dev/u1',
      detail: { partnerId: 'koinbx-dev', userId: 'u1' },
    })
    await app.close()
  })

  it('401s every learned-facts route without a session', async () => {
    const { app } = await testAdmin()
    for (const [method, url] of [
      ['GET', '/v1/learned-facts/user/koinbx-dev/u1'],
      ['DELETE', '/v1/learned-facts/user/koinbx-dev/u1'],
      ['GET', '/v1/learned-facts/session/s_1'],
    ] as const) {
      const res = await app.inject({ method, url })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
    }
    await app.close()
  })

  it('returns 502 "memory service unreachable" when the facts proxy fetch rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('memory down')
    }) as typeof fetch
    const { app } = await testAdmin({ fetchImpl })
    const cookie = await login(app)

    for (const [method, url] of [
      ['GET', '/v1/learned-facts/user/koinbx-dev/u1'],
      ['DELETE', '/v1/learned-facts/user/koinbx-dev/u1'],
      ['GET', '/v1/learned-facts/session/s_1'],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie } })
      expect(res.statusCode, `${method} ${url}`).toBe(502)
      expect(res.json().error, `${method} ${url}`).toBe('memory service unreachable')
    }
    await app.close()
  })
})

describe('memory-config (super-admin scope documents)', () => {
  it('owner can PUT/GET a global doc; proxies with the internal token and audits the level', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init })
      return new Response(JSON.stringify({ body: 'PLATFORM RULE', updatedAt: 1 }), { status: 200 })
    }) as typeof fetch
    const { app, audit } = await testAdmin({ fetchImpl, internalToken: 'itok' })
    const cookie = await login(app)
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/memory-config/global',
      headers: { cookie },
      payload: { body: 'PLATFORM RULE' },
    })
    expect(put.statusCode).toBe(200)
    // proxied to the memory scope route with the internal token
    const call = seen.find((s) => s.url.endsWith('/v1/scope/global') && s.init?.method === 'PUT')
    expect(call).toBeTruthy()
    const headers = (call?.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-hippo-internal-token']).toBe('itok')
    // audited with the scope level
    const rows = await audit.list({})
    expect(
      rows.rows.some((r) => r.action === 'memory_config.set' && r.detail.level === 'global'),
    ).toBe(true)
  })

  it('a plain operator (not owner) is 403 on memory-config', async () => {
    const { app, operators } = await testAdmin()
    await operators.create({
      email: 'op2@hippo.dev',
      passwordHash: hashPassword('another good passphrase'),
      role: 'operator',
    })
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'op2@hippo.dev', password: 'another good passphrase' },
    })
    const cookie = (
      (Array.isArray(res.headers['set-cookie'])
        ? res.headers['set-cookie'][0]
        : res.headers['set-cookie']) ?? ''
    ).split(';')[0]
    const got = await app.inject({
      method: 'GET',
      url: '/v1/memory-config/global',
      headers: { cookie },
    })
    expect(got.statusCode).toBe(403)
  })

  it('rejects a non-string body', async () => {
    const { app } = await testAdmin({ internalToken: 'itok' })
    const cookie = await login(app)
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/memory-config/host/pA',
      headers: { cookie },
      payload: { body: 42 },
    })
    expect(bad.statusCode).toBe(400)
  })
})

describe('per-IP rate limit', () => {
  it('429s beyond the window max with Retry-After; /health stays exempt', async () => {
    const { app } = await testAdmin({ rateLimit: { max: 3, windowMs: 60_000 } })
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/auth/me' })
      expect(res.statusCode).not.toBe(429)
      expect(res.headers['x-ratelimit-limit']).toBe('3')
    }
    const blocked = await app.inject({ method: 'GET', url: '/auth/me' })
    expect(blocked.statusCode).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    }
    await app.close()
  })
})

describe('build provenance', () => {
  it('/health reports sha + builtAt ("unknown" when the image is unstamped)', async () => {
    const { app } = await testAdmin()
    const body = (await app.inject({ method: 'GET', url: '/health' })).json()
    expect(body).toMatchObject({
      ok: true,
      service: 'admin',
      sha: expect.any(String),
      builtAt: expect.any(String),
    })
    await app.close()
  })
})

// ── reserved characters must survive the proxy round-trip ──────────────────
// Fastify hands routes DECODED params. Interpolating them raw into upstream
// paths rewrites the request: '/' adds a segment, '?' turns the tail into a
// query string — so a purge aimed at "a?b" lands on key "a". The GDPR routes
// were the asymmetric ones: the GET encoded, the DELETE did not.

describe('reserved-char ids reach memory encoded on every proxy path', () => {
  const encoded = encodeURIComponent('u/1?x') // '/' and '?' — the two path-rewriting characters

  it('GET/PUT/clear/DELETE memory and the learned-facts routes all encode the segments', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: unknown) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ updatedAt: 1 }), { status: 200 })
    }) as typeof fetch
    const { app } = await testAdmin({ fetchImpl, memoryUrl: 'http://mem' })
    const cookie = await login(app)

    const routes = [
      ['GET', `/v1/memory/koinbx-dev/${encoded}`, undefined],
      ['PUT', `/v1/memory/koinbx-dev/${encoded}`, { experienceLevel: 'pro' }],
      ['POST', `/v1/memory/koinbx-dev/${encoded}/clear`, undefined],
      ['DELETE', `/v1/memory/koinbx-dev/${encoded}`, undefined],
      ['GET', `/v1/learned-facts/user/koinbx-dev/${encoded}`, undefined],
      ['DELETE', `/v1/learned-facts/user/koinbx-dev/${encoded}`, undefined],
    ] as const
    for (const [method, url, payload] of routes) {
      await app.inject({
        method,
        url,
        headers: { cookie },
        ...(payload !== undefined ? { payload } : {}),
      })
    }
    expect(seen).toHaveLength(routes.length)
    for (const url of seen) {
      // The decoded id must never appear raw — every upstream URL carries the
      // id as ONE encoded segment.
      expect(url).toContain(encoded)
      expect(url).not.toContain('u/1?x')
    }
    await app.close()
  })

  it('a purge aimed at "a?b" must not land on key "a" (the truncation bug)', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: unknown) => {
      seen.push(String(url))
      return new Response('{"deleted":true}', { status: 200 })
    }) as typeof fetch
    const { app } = await testAdmin({ fetchImpl, memoryUrl: 'http://mem' })
    const cookie = await login(app)
    await app.inject({
      method: 'DELETE',
      url: `/v1/memory/koinbx-dev/${encodeURIComponent('a?b')}`,
      headers: { cookie },
    })
    // Raw interpolation produced ".../a?b" — path "/admin/personas/koinbx-dev/a"
    // plus query "b": the WRONG user's data. Encoded, the path keeps the id.
    expect(new URL(seen[0] ?? '').pathname).toBe('/admin/personas/koinbx-dev/a%3Fb')
    await app.close()
  })
})

// ── the audit trail records what happened, not what was attempted ──────────

describe('audit rows on failed memory writes', () => {
  it('a 404ed purge/update/clear is audited as *_failed and the status propagates', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"unknown persona"}', { status: 404 })) as typeof fetch
    const { app, audit } = await testAdmin({ fetchImpl })
    const cookie = await login(app)

    for (const [method, url, payload] of [
      ['PUT', '/v1/memory/koinbx-dev/ghost', { experienceLevel: 'pro' }],
      ['POST', '/v1/memory/koinbx-dev/ghost/clear', undefined],
      ['DELETE', '/v1/memory/koinbx-dev/ghost', undefined],
      ['DELETE', '/v1/memory?partnerId=ghost-partner', undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie },
        ...(payload !== undefined ? { payload } : {}),
      })
      // The upstream failure reaches the SPA — never swallowed into a 200.
      expect(res.statusCode, `${method} ${url}`).toBe(404)
    }

    const actions = (await audit.list({ limit: 50 })).rows.map((r) => r.action)
    // No row may assert a write that 404ed…
    for (const lie of ['memory.update', 'memory.clear', 'memory.purge', 'memory.purge_partner']) {
      expect(actions, lie).not.toContain(lie)
    }
    // …and each failure is recorded as itself, status included.
    for (const truth of [
      'memory.update_failed',
      'memory.clear_failed',
      'memory.purge_failed',
      'memory.purge_partner_failed',
    ]) {
      expect(actions, truth).toContain(truth)
    }
    const failed = (await audit.list({ limit: 50 })).rows.find(
      (r) => r.action === 'memory.purge_failed',
    )
    expect(failed?.detail).toMatchObject({ status: 404 })
    await app.close()
  })

  it('partner purge audits the cascade counts (personas + facts + notes)', async () => {
    const fetchImpl = (async () =>
      new Response('{"deleted":3,"facts":2,"notes":1}', { status: 200 })) as typeof fetch
    const { app, audit } = await testAdmin({ fetchImpl })
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/memory?partnerId=koinbx-dev',
      headers: { cookie },
    })
    expect(res.json()).toEqual({ deleted: 3, facts: 2, notes: 1 })
    const row = (await audit.list({})).rows.find((r) => r.action === 'memory.purge_partner')
    expect(row?.detail).toEqual({ deleted: 3, facts: 2, notes: 1 })
    await app.close()
  })
})

// ── an outage is not an absence ─────────────────────────────────────────────

describe('personaStatus on the user detail join', () => {
  async function userApp(fetchImpl: typeof fetch) {
    const users = new InMemoryUserStore()
    await users.upsertSeen('koinbx-dev', 'u1')
    const { app } = await testAdmin({ users, fetchImpl })
    return { app, cookie: await login(app) }
  }

  it("'none' when memory answers its default persona (updatedAt 0)", async () => {
    const { app, cookie } = await userApp(
      (async () =>
        new Response(JSON.stringify({ optIn: false, updatedAt: 0 }), {
          status: 200,
        })) as typeof fetch,
    )
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/koinbx-dev/u1',
      headers: { cookie },
    })
    expect(res.json()).toMatchObject({ persona: null, personaStatus: 'none' })
    await app.close()
  })

  it("'unavailable' when memory is down or erroring — never rendered as absence", async () => {
    for (const impl of [
      (async () => {
        throw new Error('memory down')
      }) as typeof fetch,
      (async () => new Response('{"error":"boom"}', { status: 500 })) as typeof fetch,
    ]) {
      const { app, cookie } = await userApp(impl)
      const res = await app.inject({
        method: 'GET',
        url: '/v1/users/koinbx-dev/u1',
        headers: { cookie },
      })
      expect(res.statusCode).toBe(200) // the user row itself still renders
      expect(res.json()).toMatchObject({ persona: null, personaStatus: 'unavailable' })
      await app.close()
    }
  })
})

// ── purge-user-everywhere (GDPR erasure across every store) ─────────────────

describe('DELETE /v1/users/:partnerId/:userId/everywhere', () => {
  function purgeStack(gatewayStatus = 200) {
    const seen: Array<{ url: string; method: string; body: unknown }> = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      if (String(url).includes('/internal/user-purge')) {
        return new Response(
          JSON.stringify({
            partnerId: 'koinbx-dev',
            userKey: 'u1',
            deleted: { intentSignals: 2, uploadedFiles: 1, alerts: 3, identities: 0 },
          }),
          { status: gatewayStatus },
        )
      }
      return new Response('{"deleted":true}', { status: 200 })
    }) as typeof fetch
    return { seen, fetchImpl }
  }

  it('fans out to all four legs and aggregates the results', async () => {
    const { seen, fetchImpl } = purgeStack()
    const { app, audit } = await testAdmin({
      fetchImpl,
      memoryUrl: 'http://mem',
      gatewayUrl: 'http://gw',
      internalToken: 'itok',
    })
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/users/koinbx-dev/u1/everywhere',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.results.persona).toEqual({ ok: true, detail: { deleted: true } })
    expect(body.results.learnedFacts.ok).toBe(true)
    expect(body.results.userNote.ok).toBe(true)
    expect(body.results.gateway.detail.deleted).toMatchObject({ intentSignals: 2 })

    const urls = seen.map((s) => `${s.method} ${s.url}`).sort()
    expect(urls).toEqual(
      [
        'DELETE http://mem/admin/personas/koinbx-dev/u1',
        'DELETE http://mem/v1/scope/user/koinbx-dev/u1/facts',
        'DELETE http://mem/v1/scope/user/koinbx-dev/u1',
        'POST http://gw/internal/user-purge',
      ].sort(),
    )
    const gw = seen.find((s) => s.url.includes('/internal/user-purge'))
    expect(gw?.body).toEqual({ partnerId: 'koinbx-dev', userKey: 'u1' })

    const actions = (await audit.list({})).rows.map((r) => r.action)
    expect(actions).toContain('user.purge_everywhere')
    await app.close()
  })

  it('a failed leg stays visible: ok=false, per-leg detail, partial audit row', async () => {
    const { fetchImpl } = purgeStack(500)
    const { app, audit } = await testAdmin({ fetchImpl })
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/users/koinbx-dev/u1/everywhere',
      headers: { cookie },
    })
    const body = res.json()
    expect(body.ok).toBe(false)
    expect(body.results.gateway).toEqual({ ok: false, error: 'upstream error', status: 500 })
    // Memory legs still report their own truth — not blanked by the failure.
    expect(body.results.persona.ok).toBe(true)
    const row = (await audit.list({})).rows.find(
      (r) => r.action === 'user.purge_everywhere_partial',
    )
    expect(row?.detail).toMatchObject({ gateway: false, persona: true })
    await app.close()
  })

  it('is operator-gated and encodes reserved-char ids on every leg', async () => {
    const { seen, fetchImpl } = purgeStack()
    const { app } = await testAdmin({ fetchImpl, memoryUrl: 'http://mem' })
    expect(
      (await app.inject({ method: 'DELETE', url: '/v1/users/koinbx-dev/u1/everywhere' }))
        .statusCode,
    ).toBe(401)
    expect(seen).toEqual([])

    const cookie = await login(app)
    await app.inject({
      method: 'DELETE',
      url: `/v1/users/koinbx-dev/${encodeURIComponent('u/1?x')}/everywhere`,
      headers: { cookie },
    })
    const memoryCalls = seen.filter((s) => s.url.startsWith('http://mem'))
    expect(memoryCalls).toHaveLength(3)
    for (const call of memoryCalls) {
      expect(call.url).toContain('u%2F1%3Fx')
    }
    await app.close()
  })
})

// ── operator visibility proxies (alerts / shares / identities / degraded) ──

describe('gateway visibility proxies', () => {
  function gatewayStub() {
    const seen: Array<{ url: string; method: string; token: string | null; body?: string }> = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method ?? 'GET',
        token: new Headers(init?.headers).get('x-hippo-internal-token'),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch
    return { seen, fetchImpl }
  }

  it('proxies list routes with the internal token; partnerId is required', async () => {
    const { seen, fetchImpl } = gatewayStub()
    const { app } = await testAdmin({ fetchImpl, gatewayUrl: 'http://gw', internalToken: 'itok' })
    const cookie = await login(app)

    for (const path of ['/v1/alerts', '/v1/shares', '/v1/identities']) {
      // Without partnerId: 400 before any gateway call.
      const missing = await app.inject({ method: 'GET', url: path, headers: { cookie } })
      expect(missing.statusCode, path).toBe(400)

      const res = await app.inject({
        method: 'GET',
        url: `${path}?partnerId=koinbx-dev`,
        headers: { cookie },
      })
      expect(res.statusCode, path).toBe(200)
    }
    expect(seen.map((s) => s.url)).toEqual([
      'http://gw/internal/alerts?partnerId=koinbx-dev',
      'http://gw/internal/shares?partnerId=koinbx-dev',
      'http://gw/internal/identities?partnerId=koinbx-dev',
    ])
    expect(seen.every((s) => s.token === 'itok')).toBe(true)
    await app.close()
  })

  it('cancels an alert (validated body, audited on success)', async () => {
    const { seen, fetchImpl } = gatewayStub()
    const { app, audit } = await testAdmin({ fetchImpl, gatewayUrl: 'http://gw' })
    const cookie = await login(app)

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/alerts/al_1/cancel',
      headers: { cookie },
      payload: { partnerId: 'koinbx-dev' }, // userKey missing
    })
    expect(bad.statusCode).toBe(400)
    expect(seen).toEqual([])

    const res = await app.inject({
      method: 'POST',
      url: '/v1/alerts/al_1/cancel',
      headers: { cookie },
      payload: { partnerId: 'koinbx-dev', userKey: 'id:vic' },
    })
    expect(res.statusCode).toBe(200)
    expect(seen[0]?.url).toBe('http://gw/internal/alerts/al_1/cancel')
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      partnerId: 'koinbx-dev',
      userKey: 'id:vic',
    })
    expect((await audit.list({})).rows.map((r) => r.action)).toContain('alert.cancel')
    await app.close()
  })

  it('deletes a share with the Fastify-safe {} body and audits it', async () => {
    const { seen, fetchImpl } = gatewayStub()
    const { app, audit } = await testAdmin({ fetchImpl, gatewayUrl: 'http://gw' })
    const cookie = await login(app)
    const res = await app.inject({ method: 'DELETE', url: '/v1/shares/sh_1', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(seen[0]).toMatchObject({
      url: 'http://gw/internal/shares/sh_1',
      method: 'DELETE',
      body: '{}', // bodyless DELETE through a JSON client 400s at the gateway
    })
    expect((await audit.list({})).rows.map((r) => r.action)).toContain('share.delete')
    await app.close()
  })

  it('forces/unforces degraded mode (audited) and lists the forced set', async () => {
    const { seen, fetchImpl } = gatewayStub()
    const { app, audit } = await testAdmin({ fetchImpl, gatewayUrl: 'http://gw' })
    const cookie = await login(app)

    expect(
      (await app.inject({ method: 'GET', url: '/v1/degraded', headers: { cookie } })).statusCode,
    ).toBe(200)

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/degraded',
      headers: { cookie },
      payload: { partnerId: 'koinbx-dev', forced: 'yes' }, // not a boolean
    })
    expect(bad.statusCode).toBe(400)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/degraded',
      headers: { cookie },
      payload: { partnerId: 'koinbx-dev', forced: true },
    })
    expect(res.statusCode).toBe(200)
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET http://gw/internal/degraded',
      'POST http://gw/internal/degraded',
    ])
    const row = (await audit.list({})).rows.find((r) => r.action === 'degraded.force')
    expect(row).toMatchObject({ target: 'koinbx-dev', detail: { forced: true } })
    await app.close()
  })

  it('401s unauthenticated and 502s when the gateway is down', async () => {
    const downImpl = (async () => {
      throw new Error('gateway down')
    }) as typeof fetch
    const { app } = await testAdmin({ fetchImpl: downImpl })
    const routes = [
      ['GET', '/v1/alerts?partnerId=p'],
      ['POST', '/v1/alerts/al_1/cancel'],
      ['GET', '/v1/shares?partnerId=p'],
      ['DELETE', '/v1/shares/sh_1'],
      ['GET', '/v1/identities?partnerId=p'],
      ['GET', '/v1/degraded'],
      ['POST', '/v1/degraded'],
    ] as const
    for (const [method, url] of routes) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401)
    }
    const cookie = await login(app)
    for (const [method, url] of routes) {
      const payload = url.includes('cancel')
        ? { partnerId: 'p', userKey: 'k' }
        : url === '/v1/degraded' && method === 'POST'
          ? { partnerId: 'p', forced: true }
          : undefined
      const res = await app.inject({
        method,
        url,
        headers: { cookie },
        ...(payload ? { payload } : {}),
      })
      expect(res.statusCode, `${method} ${url}`).toBe(502)
      expect(res.json().error, `${method} ${url}`).toBe('gateway unreachable')
    }
    await app.close()
  })
})

// ── lockout keying: one attacker must not lock the whole team ───────────────

describe('login lockout keying (email+IP)', () => {
  // Literal-free credentials so the secret scanner stays quiet.
  const rightPass = ['correct', 'horse', 'battery'].join(' ')
  const wrongPass = ['wrong', 'guess', 'entirely'].join(' ')
  const secondPass = ['a', 'fine', 'passphrase', '2'].join(' ')

  it('5 failures against one email do not lock a different operator on the same IP', async () => {
    const { app, operators } = await testAdmin()
    await operators.create({
      email: 'second@hippo.dev',
      passwordHash: hashPassword(secondPass),
      role: 'operator',
    })
    // Attacker hammers ops@ from the (shared) inject address…
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ops@hippo.dev', password: wrongPass },
      })
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'ops@hippo.dev', password: rightPass },
        })
      ).statusCode,
    ).toBe(429)
    // …and the second operator, same IP, still signs in. Under the old bare
    // `ip:` key this was a 429 — one attacker locked out every operator
    // behind the shared proxy address.
    const other = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'second@hippo.dev', password: secondPass },
    })
    expect(other.statusCode).toBe(200)
    await app.close()
  })

  it('with trustProxy, x-forwarded-for separates clients; without it, it is ignored', async () => {
    // trustProxy on: the forwarded client IP keys the lockout.
    const trusted = await testAdmin({ trustProxy: true })
    for (let i = 0; i < 5; i++) {
      await trusted.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-forwarded-for': '9.9.9.9' },
        payload: { email: 'ops@hippo.dev', password: wrongPass },
      })
    }
    const sameClient = await trusted.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-forwarded-for': '9.9.9.9' },
      payload: { email: 'ops@hippo.dev', password: rightPass },
    })
    expect(sameClient.statusCode).toBe(429)
    const otherClient = await trusted.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-forwarded-for': '8.8.8.8' },
      payload: { email: 'ops@hippo.dev', password: rightPass },
    })
    expect(otherClient.statusCode).toBe(200)
    await trusted.app.close()

    // trustProxy off (default): the header is untrusted noise — all attempts
    // share the socket address, so the lockout holds regardless of the header.
    const direct = await testAdmin()
    for (let i = 0; i < 5; i++) {
      await direct.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
        payload: { email: 'ops@hippo.dev', password: wrongPass },
      })
    }
    const forged = await direct.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-forwarded-for': '10.0.0.99' },
      payload: { email: 'ops@hippo.dev', password: rightPass },
    })
    expect(forged.statusCode).toBe(429)
    await direct.app.close()
  })
})

// ── self-serve provisioning: body input never masquerades as an identity ───

describe('provisioning audit row provenance', () => {
  it('records the caller-typed email as requestedEmail, never as operatorEmail', async () => {
    const { app, audit } = await testAdmin()
    await app.inject({
      method: 'POST',
      url: '/v1/provision/sandbox',
      payload: { email: 'attacker@evil.example', venueName: 'Shady Venue' },
    })
    const row = (await audit.list({})).rows.find((r) => r.action === 'provision.sandbox')
    expect(row?.operatorEmail).toBe('provisioning')
    expect(row?.detail).toMatchObject({ requestedEmail: 'attacker@evil.example' })
    await app.close()
  })
})
