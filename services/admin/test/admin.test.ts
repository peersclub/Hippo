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
