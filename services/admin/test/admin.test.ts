import {
  InMemoryAuditStore,
  InMemoryOperatorStore,
  InMemoryPartnerStore,
  InMemoryPlanStore,
  InMemoryUserStore,
} from '@hippo/stores'
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/opauth.js'
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
    const personaBody = { optIn: true, experienceLevel: 'pro', followedAssets: ['BTC'] }
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
    expect(detail.json()).toMatchObject({ userId: 'u1', persona: personaBody })

    const block = await app.inject({
      method: 'POST',
      url: '/v1/users/koinbx-dev/u1/block',
      headers: { cookie },
    })
    expect(block.json().status).toBe('blocked')
    await app.close()
  })

  it('proxies memory list/update/purge with the internal token attached', async () => {
    const seen: Array<{ url: string; token: string | null; method: string; contentType: string | null }> = []
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
