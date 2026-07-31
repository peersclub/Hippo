/**
 * Pilot instrumentation surface: the in-process advice counters and the 24h
 * load curve added for the admin Pilot dashboard, plus the internal-token
 * guard on /internal/metrics (it was the one unauthenticated /internal route).
 */
import { describe, expect, it } from 'vitest'
import { type LoadBucket, Telemetry } from '../src/plugins/telemetry.js'
import { TEST_INTERNAL_TOKEN, testApp } from './helpers.js'

const HOUR_MS = 3_600_000

describe('Telemetry pilot counters', () => {
  it('counts advice outcomes into the snapshot with a decline rate', () => {
    const t = new Telemetry()
    t.recordAdvice(true)
    t.recordAdvice(true)
    t.recordAdvice(false)
    const snap = t.snapshot() as {
      advice: { answered: number; declined: number; declineRate: number | null }
    }
    expect(snap.advice.answered).toBe(1)
    expect(snap.advice.declined).toBe(2)
    expect(snap.advice.declineRate).toBeCloseTo(2 / 3)
  })

  it('reports a null decline rate before any advice turn', () => {
    const snap = new Telemetry().snapshot() as { advice: { declineRate: number | null } }
    expect(snap.advice.declineRate).toBeNull()
  })

  it('buckets turns per hour and counts user_text as queries', () => {
    const t = new Telemetry()
    const now = Date.parse('2026-07-31T10:15:00Z')
    t.recordTurn('user_text', now)
    t.recordTurn('context', now)
    t.recordTurn('user_text', now - HOUR_MS)
    const curve = t.loadCurve(now)
    expect(curve).toHaveLength(2)
    expect(curve[0]).toMatchObject({ uplinks: 1, queries: 1 }) // the older hour
    expect(curve[1]).toMatchObject({ uplinks: 2, queries: 1 })
    expect(curve[0]?.hourStartMs).toBeLessThan(curve[1]?.hourStartMs ?? 0)
  })

  it('prunes buckets older than 24h', () => {
    const t = new Telemetry()
    const now = Date.parse('2026-07-31T10:15:00Z')
    t.recordTurn('user_text', now - 25 * HOUR_MS)
    t.recordTurn('user_text', now)
    const curve: LoadBucket[] = t.loadCurve(now)
    expect(curve).toHaveLength(1)
    expect(curve[0]?.queries).toBe(1)
  })
})

describe('GET /internal/metrics guard', () => {
  it('401s without the internal token and serves the snapshot with it', async () => {
    const { app } = await testApp()
    expect((await app.inject({ method: 'GET', url: '/internal/metrics' })).statusCode).toBe(401)
    const res = await app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { advice: unknown; loadCurve: unknown[] }
    expect(body.advice).toBeDefined()
    expect(Array.isArray(body.loadCurve)).toBe(true)
    await app.close()
  })
})
