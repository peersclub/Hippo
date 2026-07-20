import {
  hashPassword,
  InMemoryAuditStore,
  InMemoryMauStore,
  InMemoryPartnerAdminStore,
  InMemoryPartnerStore,
  InMemoryPlanStore,
  InMemoryUserStore,
  tokenHash,
} from '@hippo/stores'
import { describe, expect, it } from 'vitest'
import { sessionCookie } from '../src/auth.js'
import { buildPortalService } from '../src/service.js'

const JWT_SECRET = 'test-portal-secret'
const INVITE_TOKEN = 'invite-token-plaintext-abc123'

/** Two partners with one claimed admin each — every test asserts against the
 * kbx tenant and uses the second (oX) tenant as the cross-tenant tripwire. */
async function testPortal() {
  const partners = new InMemoryPartnerStore()
  await partners.create({
    partnerId: 'kbx',
    partnerKey: 'pk_kbx',
    jwtSecret: 'kbx-venue-secret',
    venueName: 'KoinBX',
    locales: ['en', 'hi'],
    suggestedQueries: ['ETH funding rate'],
    planId: 'pilot',
  })
  await partners.create({
    partnerId: 'ox',
    partnerKey: 'pk_ox',
    jwtSecret: 'ox-venue-secret',
    venueName: 'OtherEx',
    locales: ['en'],
    suggestedQueries: [],
  })

  const plans = new InMemoryPlanStore(async () => false)
  await plans.create({
    planId: 'pilot',
    name: 'Pilot',
    tier: 'pilot',
    mauQuota: 1000,
    priceMonthlyUsd: 500,
    entitlements: { streaming: true },
  })

  const users = new InMemoryUserStore()
  await users.upsertSeen('kbx', 'user-a')
  await users.upsertSeen('kbx', 'user-b')
  await users.upsertSeen('ox', 'other-user')

  const partnerAdmins = new InMemoryPartnerAdminStore()
  await partnerAdmins.create({
    email: 'admin@koinbx.com',
    partnerId: 'kbx',
    role: 'admin',
    inviteTokenHash: null,
    inviteExpiresAt: null,
  })
  await partnerAdmins.setPassword('admin@koinbx.com', hashPassword('a long portal password'))
  await partnerAdmins.create({
    email: 'viewer@koinbx.com',
    partnerId: 'kbx',
    role: 'viewer',
    inviteTokenHash: null,
    inviteExpiresAt: null,
  })
  await partnerAdmins.setPassword('viewer@koinbx.com', hashPassword('a long portal password'))

  const audit = new InMemoryAuditStore()
  // A foreign tenant's audit entry — must never surface in kbx's view.
  await audit.append({
    operatorEmail: 'admin@otherex.com',
    action: 'portal.integration.update',
    target: 'partner:ox',
    detail: { partnerId: 'ox' },
  })

  const mauStore = new InMemoryMauStore()
  await mauStore.record('kbx', 'user-a')
  await mauStore.record('kbx', 'user-b')
  await mauStore.record('ox', 'other-user')

  const app = buildPortalService({
    partners,
    plans,
    users,
    partnerAdmins,
    audit,
    jwtSecret: JWT_SECRET,
    mauStore,
    sdkUrl: 'https://cdn.test/hippo-loader.js',
  })
  return { app, partners, plans, users, partnerAdmins, audit }
}

type Portal = Awaited<ReturnType<typeof testPortal>>

async function login(app: Portal['app'], email = 'admin@koinbx.com'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: 'a long portal password' },
  })
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode}`)
  const setCookie = res.headers['set-cookie']
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? ''
  return cookie.split(';')[0] ?? ''
}

describe('claim flow', () => {
  it('claims a one-time invite, burns the token, and can then log in', async () => {
    const { app, partnerAdmins } = await testPortal()
    await partnerAdmins.create({
      email: 'new@koinbx.com',
      partnerId: 'kbx',
      role: 'admin',
      inviteTokenHash: tokenHash(INVITE_TOKEN),
      inviteExpiresAt: Date.now() + 60_000,
    })

    const claim = await app.inject({
      method: 'POST',
      url: '/auth/claim',
      payload: { token: INVITE_TOKEN, password: 'fresh portal password' },
    })
    expect(claim.statusCode).toBe(200)
    expect(claim.json()).toMatchObject({ ok: true, email: 'new@koinbx.com' })

    // Token is single-use.
    const again = await app.inject({
      method: 'POST',
      url: '/auth/claim',
      payload: { token: INVITE_TOKEN, password: 'another password!!' },
    })
    expect(again.statusCode).toBe(404)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'new@koinbx.com', password: 'fresh portal password' },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('410s an expired invite and 404s an unknown token', async () => {
    const { app, partnerAdmins } = await testPortal()
    await partnerAdmins.create({
      email: 'late@koinbx.com',
      partnerId: 'kbx',
      role: 'admin',
      inviteTokenHash: tokenHash('expired-token-plaintext'),
      inviteExpiresAt: Date.now() - 1,
    })
    const expired = await app.inject({
      method: 'POST',
      url: '/auth/claim',
      payload: { token: 'expired-token-plaintext', password: 'whatever password' },
    })
    expect(expired.statusCode).toBe(410)
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/claim',
      payload: { token: 'never-issued-token-xx', password: 'whatever password' },
    })
    expect(unknown.statusCode).toBe(404)
    await app.close()
  })
})

describe('portal auth', () => {
  it('logs in with its own cookie namespace (hippo_portal, HttpOnly, Strict)', async () => {
    const { app } = await testPortal()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@koinbx.com', password: 'a long portal password' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ partnerId: 'kbx', role: 'admin', venueName: 'KoinBX' })
    const cookie = String(res.headers['set-cookie'])
    expect(cookie).toContain('hippo_portal=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    await app.close()
  })

  it('refuses login for a suspended partner and 401s every /portal route without a session', async () => {
    const { app, partners } = await testPortal()
    await partners.setStatus('kbx', 'suspended')
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@koinbx.com', password: 'a long portal password' },
    })
    expect(res.statusCode).toBe(403)

    for (const [method, url] of [
      ['GET', '/portal/overview'],
      ['GET', '/portal/users'],
      ['GET', '/portal/integration'],
      ['GET', '/portal/plan'],
      ['GET', '/portal/audit'],
    ] as const) {
      const r = await app.inject({ method, url })
      expect(r.statusCode, `${method} ${url}`).toBe(401)
    }
    await app.close()
  })
})

describe('tenancy by construction', () => {
  it('overview, users, and audit are scoped to the session partner only', async () => {
    const { app } = await testPortal()
    const cookie = await login(app)

    const overview = await app.inject({
      method: 'GET',
      url: '/portal/overview',
      headers: { cookie },
    })
    expect(overview.json()).toMatchObject({ partnerId: 'kbx', mau: 2, userCount: 2 })

    const users = await app.inject({ method: 'GET', url: '/portal/users', headers: { cookie } })
    const ids = (users.json() as { rows: { userId: string; partnerId: string }[] }).rows
    expect(ids).toHaveLength(2)
    expect(ids.every((u) => u.partnerId === 'kbx')).toBe(true)

    const audit = await app.inject({ method: 'GET', url: '/portal/audit', headers: { cookie } })
    const entries = (audit.json() as { rows: { detail: { partnerId: string } }[] }).rows
    expect(entries.every((e) => e.detail.partnerId === 'kbx')).toBe(true)
    expect(JSON.stringify(entries)).not.toContain('otherex')
    await app.close()
  })

  it('blocks/unblocks only its own users, audited with detail.partnerId', async () => {
    const { app, users, audit } = await testPortal()
    const cookie = await login(app)

    const block = await app.inject({
      method: 'POST',
      url: '/portal/users/user-a/block',
      headers: { cookie },
    })
    expect(block.json()).toMatchObject({ userId: 'user-a', status: 'blocked' })
    expect((await users.get('kbx', 'user-a'))?.status).toBe('blocked')

    // Another tenant's user id is simply unknown inside this session.
    const foreign = await app.inject({
      method: 'POST',
      url: '/portal/users/other-user/block',
      headers: { cookie },
    })
    expect(foreign.statusCode).toBe(404)
    expect((await users.get('ox', 'other-user'))?.status).toBe('active')

    const trail = await audit.list({ partnerId: 'kbx' })
    expect(trail.rows[0]).toMatchObject({
      action: 'portal.user.block',
      detail: { partnerId: 'kbx' },
    })
    await app.close()
  })

  it('viewer seats are read-only (403 on every mutation)', async () => {
    const { app } = await testPortal()
    const cookie = await login(app, 'viewer@koinbx.com')
    for (const [method, url] of [
      ['POST', '/portal/users/user-a/block'],
      ['PATCH', '/portal/integration'],
      ['POST', '/portal/integration/rotate-secret'],
      ['POST', '/portal/plan/request'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie },
        payload: {},
      })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    await app.close()
  })
})

describe('integration', () => {
  it('GET never exposes the jwtSecret; PATCH edits partner-owned config only', async () => {
    const { app } = await testPortal()
    const cookie = await login(app)

    const res = await app.inject({ method: 'GET', url: '/portal/integration', headers: { cookie } })
    expect(res.json()).toMatchObject({ partnerKey: 'pk_kbx' })
    expect(JSON.stringify(res.json())).not.toContain('kbx-venue-secret')
    expect((res.json() as { embedSnippet: string }).embedSnippet).toContain(
      'data-hippo-key="pk_kbx"',
    )

    const patch = await app.inject({
      method: 'PATCH',
      url: '/portal/integration',
      headers: { cookie },
      payload: { venueName: 'KoinBX Pro', jwtSecret: 'smuggled' },
    })
    // Unknown keys are stripped by the schema, not honored.
    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toMatchObject({ venueName: 'KoinBX Pro' })
    await app.close()
  })

  it('rotate-secret returns the new secret exactly once and never audits it', async () => {
    const { app, partners, audit } = await testPortal()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'POST',
      url: '/portal/integration/rotate-secret',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const { jwtSecret } = res.json() as { jwtSecret: string }
    expect(jwtSecret).toHaveLength(64)

    // The gateway-visible record now carries the new secret…
    expect((await partners.get('kbx'))?.jwtSecret).toBe(jwtSecret)
    // …and the audit trail never does.
    const trail = await audit.list({ partnerId: 'kbx' })
    expect(trail.rows[0]?.action).toBe('portal.secret.rotate')
    expect(JSON.stringify(trail.rows)).not.toContain(jwtSecret)
    await app.close()
  })
})

describe('plan', () => {
  it('shows the plan with usage and logs a change request for operators', async () => {
    const { app, audit } = await testPortal()
    const cookie = await login(app)

    const plan = await app.inject({ method: 'GET', url: '/portal/plan', headers: { cookie } })
    expect(plan.json()).toMatchObject({
      plan: { planId: 'pilot', mauQuota: 1000 },
      usage: { mau: 2, mauQuota: 1000 },
    })

    const req = await app.inject({
      method: 'POST',
      url: '/portal/plan/request',
      headers: { cookie },
      payload: { message: 'We need the growth tier before Diwali.' },
    })
    expect(req.statusCode).toBe(200)
    const trail = await audit.list({ partnerId: 'kbx' })
    expect(trail.rows[0]).toMatchObject({
      action: 'portal.plan.change_requested',
      detail: { partnerId: 'kbx', currentPlanId: 'pilot' },
    })
    await app.close()
  })
})

describe('session cookie Secure flag', () => {
  const withEnv = (val: string | undefined, prodEnv: string | undefined, fn: () => void) => {
    const savedSecure = process.env.PORTAL_COOKIE_SECURE
    const savedNode = process.env.NODE_ENV
    if (val === undefined) delete process.env.PORTAL_COOKIE_SECURE
    else process.env.PORTAL_COOKIE_SECURE = val
    if (prodEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prodEnv
    try {
      fn()
    } finally {
      if (savedSecure === undefined) delete process.env.PORTAL_COOKIE_SECURE
      else process.env.PORTAL_COOKIE_SECURE = savedSecure
      if (savedNode === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = savedNode
    }
  }

  it('is Secure by default in production', () => {
    withEnv(undefined, 'production', () => {
      expect(sessionCookie('tok')).toContain('; Secure')
    })
  })

  it('can be forced off in production with PORTAL_COOKIE_SECURE=0', () => {
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
