/**
 * Operator diagnostics: percentile math, ring-buffer eviction, rolling
 * counters, client instrumentation, and the /internal/telemetry surface
 * (guarded exactly like the other internal routes).
 */
import { describe, expect, it } from 'vitest'
import {
  Diagnostics,
  type DiagnosticsSnapshot,
  instrumentClient,
  percentile,
} from '../src/diagnostics.js'
import {
  createSession,
  sendTurn,
  TEST_INTERNAL_TOKEN,
  testApp,
  testAppRaw,
  waitForJournal,
} from './helpers.js'

describe('percentile', () => {
  it('is null on an empty sample', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([], 95)).toBeNull()
  })

  it('computes nearest-rank p50/p95 without mutating the sample', () => {
    const sample = [400, 100, 300, 200] // deliberately unsorted
    expect(percentile(sample, 50)).toBe(200)
    expect(percentile(sample, 95)).toBe(400)
    expect(sample).toEqual([400, 100, 300, 200])
  })

  it('p95 over 100 sorted values lands on the 95th', () => {
    const sample = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(sample, 95)).toBe(95)
    expect(percentile(sample, 50)).toBe(50)
  })
})

describe('Diagnostics rolling windows', () => {
  it('evicts turn latencies beyond the 500-sample window', () => {
    const diag = new Diagnostics()
    // 100 slow samples first, then 500 fast ones — the slow ones must age out.
    for (let i = 0; i < 100; i++) diag.recordTurn(9_000)
    for (let i = 0; i < 500; i++) diag.recordTurn(10)
    const snap = diag.snapshot(0)
    expect(snap.turns.count).toBe(500)
    expect(snap.turns.totalMs.p95).toBe(10)
  })

  it('evicts first-token latencies the same way', () => {
    const diag = new Diagnostics()
    for (let i = 0; i < 501; i++) diag.recordFirstToken(i)
    const snap = diag.snapshot(0)
    expect(snap.turns.firstTokenMs.count).toBe(500)
    // Sample is now 1..500 — the 0 was evicted.
    expect(snap.turns.firstTokenMs.p50).toBe(250)
  })

  it('caps the call log at 100 entries, newest first', () => {
    const diag = new Diagnostics()
    for (let i = 0; i < 150; i++) diag.recordCall('research', i, true)
    const snap = diag.snapshot(0)
    expect(snap.calls).toHaveLength(100)
    expect(snap.calls[0]?.durationMs).toBe(149) // newest first
    expect(snap.calls.at(-1)?.durationMs).toBe(50) // 0..49 evicted
  })

  it('uplinks-per-minute is a rolling 60s window', () => {
    const diag = new Diagnostics()
    const t0 = 1_000_000
    diag.recordUplink(t0)
    diag.recordUplink(t0 + 30_000)
    diag.recordUplink(t0 + 59_000)
    expect(diag.uplinksLastMinute(t0 + 59_500)).toBe(3)
    // 61s after the first uplink it has aged out; the other two remain.
    expect(diag.uplinksLastMinute(t0 + 61_000)).toBe(2)
    expect(diag.uplinksLastMinute(t0 + 200_000)).toBe(0)
  })

  it('SSE gauge tracks opens/closes and never goes negative', () => {
    const diag = new Diagnostics()
    diag.sseOpened()
    diag.sseOpened()
    diag.sseClosed()
    expect(diag.snapshot(0).load.sseConnections).toBe(1)
    diag.sseClosed()
    diag.sseClosed() // double-close must not underflow
    expect(diag.snapshot(0).load.sseConnections).toBe(0)
  })
})

describe('instrumentClient', () => {
  it('records resolved promise calls as ok with their kind', async () => {
    const diag = new Diagnostics()
    const client = { intent: async () => 'classified' }
    const wrapped = instrumentClient(client, diag, { intent: 'interpret' })
    await expect(wrapped.intent()).resolves.toBe('classified')
    const [call] = diag.snapshot(0).calls
    expect(call).toMatchObject({ kind: 'interpret', ok: true })
  })

  it('records rejected promise calls as failed and rethrows', async () => {
    const diag = new Diagnostics()
    const client = {
      confirm: async () => {
        throw new Error('seam unreachable')
      },
    }
    const wrapped = instrumentClient(client, diag, { confirm: 'order' })
    await expect(wrapped.confirm()).rejects.toThrow('seam unreachable')
    expect(diag.snapshot(0).calls[0]).toMatchObject({ kind: 'order', ok: false })
  })

  it('methods absent from the kind map classify as other', async () => {
    const diag = new Diagnostics()
    const wrapped = instrumentClient({ portfolio: async () => [] }, diag, {})
    await wrapped.portfolio()
    expect(diag.snapshot(0).calls[0]?.kind).toBe('other')
  })

  it('records a completed stream once, as ok', async () => {
    const diag = new Diagnostics()
    const client = {
      respondStream: async function* () {
        yield 'a'
        yield 'b'
      },
    }
    const wrapped = instrumentClient(client, diag, { respondStream: 'research' })
    const seen: unknown[] = []
    for await (const v of wrapped.respondStream()) seen.push(v)
    expect(seen).toEqual(['a', 'b'])
    const { calls } = diag.snapshot(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: 'research', ok: true })
  })

  it('records a mid-stream throw as failed', async () => {
    const diag = new Diagnostics()
    const client = {
      respondStream: async function* () {
        yield 'a'
        throw new Error('intelligence unreachable')
      },
    }
    const wrapped = instrumentClient(client, diag, { respondStream: 'research' })
    const stream = wrapped.respondStream()
    await stream.next()
    await expect(stream.next()).rejects.toThrow('intelligence unreachable')
    expect(diag.snapshot(0).calls[0]).toMatchObject({ kind: 'research', ok: false })
  })

  it('records an early return (stream_stop) as ok, not a failure', async () => {
    const diag = new Diagnostics()
    const client = {
      respondStream: async function* () {
        yield 'a'
        yield 'never consumed'
      },
    }
    const wrapped = instrumentClient(client, diag, { respondStream: 'research' })
    const stream = wrapped.respondStream()
    await stream.next()
    await stream.return(undefined)
    const { calls } = diag.snapshot(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.ok).toBe(true)
  })
})

describe('GET /internal/telemetry', () => {
  it('503s when no internal token is configured (fail-closed)', async () => {
    const { app } = await testAppRaw({ internalToken: '' })
    const res = await app.inject({ method: 'GET', url: '/internal/telemetry' })
    expect(res.statusCode).toBe(503)
    await app.close()
  })

  it('401s a missing or wrong token', async () => {
    const { app } = await testApp()
    expect((await app.inject({ method: 'GET', url: '/internal/telemetry' })).statusCode).toBe(401)
    const wrong = await app.inject({
      method: 'GET',
      url: '/internal/telemetry',
      headers: { 'x-hippo-internal-token': 'not-the-token' },
    })
    expect(wrong.statusCode).toBe(401)
    await app.close()
  })

  it('serves the empty-boot shape with the right token', async () => {
    const { app } = await testApp()
    const res = await app.inject({
      method: 'GET',
      url: '/internal/telemetry',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as DiagnosticsSnapshot & {
      degraded: { active: boolean; seconds: number }
      config: { sessionsBackend: string; devMode: boolean }
    }
    expect(body.turns.count).toBe(0)
    expect(body.turns.totalMs).toEqual({ p50: null, p95: null })
    expect(body.calls).toEqual([])
    expect(body.load).toMatchObject({ liveSessions: 0, sseConnections: 0, uplinksLastMinute: 0 })
    expect(body.degraded).toMatchObject({ active: false })
    expect(body.config.devMode).toBe(true)
    await app.close()
  })

  it('a research turn lands interpret + research calls, turn timings and load', async () => {
    const { app, sessions } = await testApp()
    const session = await createSession(app, sessions)
    expect(await sendTurn(app, session.id, { kind: 'user_text', text: 'what is btc doing' })).toBe(
      200,
    )
    await waitForJournal(session, (t) => t.includes('research_brief'))
    // recordTurnLatency fires on the turn promise's finally — one more beat.
    await new Promise((r) => setTimeout(r, 20))

    const res = await app.inject({
      method: 'GET',
      url: '/internal/telemetry',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
    })
    const body = res.json() as DiagnosticsSnapshot
    const kinds = body.calls.map((c) => c.kind)
    expect(kinds).toContain('interpret') // intel.intent
    expect(kinds).toContain('research') // intel.respondStream
    expect(body.calls.every((c) => c.ok)).toBe(true)
    expect(body.turns.count).toBe(1)
    expect(body.turns.totalMs.p50).not.toBeNull()
    expect(body.turns.firstTokenMs.count).toBe(1)
    expect(body.load.liveSessions).toBe(1)
    expect(body.load.uplinksLastMinute).toBe(1)
    await app.close()
  })
})
