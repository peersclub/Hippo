/**
 * Tech diagnostics proxy: operator-gated read of the gateway's
 * /internal/telemetry joined with the intelligence /health mode+model.
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

const gatewayTelemetryFixture = {
  bootAt: 1_700_000_000_000,
  turns: {
    window: 500,
    count: 2,
    totalMs: { p50: 900, p95: 1400 },
    firstTokenMs: { count: 2, p50: 420, p95: 610 },
  },
  calls: [{ ts: 1_700_000_100_000, kind: 'interpret', durationMs: 120, ok: true }],
  load: { liveSessions: 3, sseConnections: 2, uplinksLastMinute: 7 },
  degraded: { active: false, seconds: 12 },
  config: { sessionsBackend: 'memory', devMode: true, intelligenceUrl: 'http://intel' },
}

async function testAdmin(fetchImpl?: typeof fetch) {
  const operators = new InMemoryOperatorStore()
  await operators.create({
    email: 'ops@hippo.dev',
    passwordHash: hashPassword('correct horse battery'),
    role: 'operator', // plain operator — the tech page is not owner-gated
  })
  const partners = new InMemoryPartnerStore()
  const app = buildAdminService({
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
  return app
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

describe('GET /v1/tech/telemetry', () => {
  it('401s without an operator session', async () => {
    const app = await testAdmin()
    const res = await app.inject({ method: 'GET', url: '/v1/tech/telemetry' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('proxies gateway telemetry and joins the intelligence mode for any operator', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/internal/telemetry')) {
        return new Response(JSON.stringify(gatewayTelemetryFixture), { status: 200 })
      }
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ mode: 'llm', model: 'anthropic/claude-haiku-4.5' }), {
          status: 200,
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    const app = await testAdmin(fetchImpl)
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tech/telemetry',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      gateway: gatewayTelemetryFixture,
      intelligence: { mode: 'llm', model: 'anthropic/claude-haiku-4.5' },
    })
    await app.close()
  })

  it('degrades to nulls when both upstreams are down (never a 500)', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connection refused')
    }
    const app = await testAdmin(fetchImpl)
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tech/telemetry',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ gateway: null, intelligence: null })
    await app.close()
  })
})
