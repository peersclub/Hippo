/**
 * Implicit misunderstanding signals: the operator gate and the two gateway
 * proxies (JSON counts, and the JSONL eval export passed through verbatim).
 */
import {
  InMemoryAuditStore,
  InMemoryOperatorStore,
  InMemoryPartnerAdminStore,
  InMemoryPartnerStore,
  InMemoryPlanStore,
  InMemoryUserStore,
} from '@hippo/stores'
import { describe, expect, it } from 'vitest'
import { hashPassword } from '../src/opauth.js'
import { buildAdminService } from '../src/service.js'

const JWT_SECRET = 'test-admin-secret'

const signalsFixture = {
  signals: [
    {
      id: 'is_1',
      partnerId: 'koinbx-dev',
      userKey: 'u1',
      signal: 'rephrase',
      originalText: 'btc funding',
      classifiedIntent: 'research',
      createdAt: 1_700_000_000_000,
    },
  ],
  summary: {
    total: 1,
    bySignal: { rephrase: 1, ticket_abandoned: 0, draft_dismissed: 0, negative_feedback: 0 },
    byIntent: { research: 1 },
  },
}

const EXPORT_JSONL = `${JSON.stringify({
  text: 'btc funding',
  category: 'observed',
  expected_intent: null,
  observed_intent: 'research',
  signal: 'rephrase',
})}\n`

async function testAdmin(fetchImpl?: typeof fetch) {
  const operators = new InMemoryOperatorStore()
  await operators.create({
    email: 'ops@hippo.dev',
    passwordHash: hashPassword('correct horse battery'),
    role: 'operator', // a plain operator may read; this is not owner-gated
  })
  const partners = new InMemoryPartnerStore()
  return buildAdminService({
    partners,
    plans: new InMemoryPlanStore(async (planId) =>
      (await partners.list()).some((p) => p.planId === planId),
    ),
    users: new InMemoryUserStore(),
    operators,
    partnerAdmins: new InMemoryPartnerAdminStore(),
    audit: new InMemoryAuditStore(),
    jwtSecret: JWT_SECRET,
    ...(fetchImpl ? { fetchImpl } : {}),
  })
}

async function login(app: Awaited<ReturnType<typeof testAdmin>>): Promise<string> {
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

const gatewayStub =
  (seen: string[]): typeof fetch =>
  async (input) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/internal/intent-signals/export')) {
      return new Response(EXPORT_JSONL, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }
    if (url.includes('/internal/intent-signals')) {
      return new Response(JSON.stringify(signalsFixture), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }

describe('GET /v1/intent-signals', () => {
  it('401s without an operator session (both the list and the export)', async () => {
    const app = await testAdmin()
    expect((await app.inject({ method: 'GET', url: '/v1/intent-signals' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/v1/intent-signals/export' })).statusCode).toBe(
      401,
    )
    await app.close()
  })

  it('proxies the gateway counts for any authenticated operator', async () => {
    const seen: string[] = []
    const app = await testAdmin(gatewayStub(seen))
    const cookie = await login(app)
    const res = await app.inject({ method: 'GET', url: '/v1/intent-signals', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(signalsFixture)
    await app.close()
  })

  it('forwards only the allowlisted query params', async () => {
    const seen: string[] = []
    const app = await testAdmin(gatewayStub(seen))
    const cookie = await login(app)
    await app.inject({
      method: 'GET',
      url: '/v1/intent-signals?partnerId=koinbx-dev&limit=10&signal=rephrase&junk=../../etc',
      headers: { cookie },
    })
    expect(seen[0]).toContain('partnerId=koinbx-dev')
    expect(seen[0]).toContain('limit=10')
    expect(seen[0]).toContain('signal=rephrase')
    expect(seen[0]).not.toContain('junk')
    await app.close()
  })

  it('passes the export through as JSONL, not JSON', async () => {
    const seen: string[] = []
    const app = await testAdmin(gatewayStub(seen))
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/intent-signals/export',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/x-ndjson')
    expect(res.headers['content-disposition']).toContain('intent-signals.jsonl')
    expect(JSON.parse(res.body.trimEnd())).toMatchObject({
      category: 'observed',
      expected_intent: null,
      observed_intent: 'research',
    })
    await app.close()
  })

  it('502s (never 500s) when the gateway is unreachable', async () => {
    const app = await testAdmin(async () => {
      throw new Error('connection refused')
    })
    const cookie = await login(app)
    for (const url of ['/v1/intent-signals', '/v1/intent-signals/export']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } })
      expect(res.statusCode).toBe(502)
    }
    await app.close()
  })
})
