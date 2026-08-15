/**
 * Ambient market pulse — the server-side signal behind the minimized pill.
 *
 * Pure half: the 1h-move math, tag formatting and the threshold/cooldown
 * gates in src/pulse.ts. Wire half: a real >threshold move reaches a
 * connected stream as a TRANSIENT pulse frame (never journaled, never id'd —
 * the price_tick contract), exactly once per cooldown window, and a
 * below-threshold market emits nothing at all.
 */
import { describe, expect, it } from 'vitest'
import type { MarketSnapshot } from '../src/orchestrator/market.js'
import {
  change1hPct,
  createPulseWatcher,
  DEFAULT_PULSE_THRESHOLD_PCT,
  formatSignedPct,
  pulseTag,
} from '../src/pulse.js'
import { createSession, snapshotFixture, testApp } from './helpers.js'

/** A snapshot whose LAST HOUR moved `pct`% (spark tail crafted accordingly). */
function snapWith1hMove(pct: number): MarketSnapshot {
  const hourAgo = 60_000
  const last = hourAgo * (1 + pct / 100)
  return {
    ...snapshotFixture,
    last,
    lastDisplay: String(last),
    spark: [59_000, 59_500, hourAgo, last],
  }
}

describe('change1hPct — last vs the close one hourly candle back', () => {
  it('computes the last-hour move from the spark tail', () => {
    expect(change1hPct(snapWith1hMove(4.2))).toBeCloseTo(4.2, 6)
    expect(change1hPct(snapWith1hMove(-5))).toBeCloseTo(-5, 6)
  })

  it('never fakes a number: short spark or degenerate base → null', () => {
    expect(change1hPct({ ...snapshotFixture, spark: [61240] })).toBeNull()
    expect(change1hPct({ ...snapshotFixture, spark: [0, 61240] })).toBeNull()
    expect(change1hPct({ ...snapshotFixture, spark: [-5, 61240] })).toBeNull()
    expect(change1hPct({ ...snapshotFixture, last: Number.NaN })).toBeNull()
  })

  it('the shared fixture (flat last hour) sits far below any sane threshold', () => {
    const pct = change1hPct(snapshotFixture)
    expect(pct).not.toBeNull()
    expect(Math.abs(pct as number)).toBeLessThan(0.1)
  })
})

describe('pulse tag — server-authored, rendered verbatim by the SDK', () => {
  it('formats "BTC +4.2% 1H" with the base asset and a signed one-decimal move', () => {
    expect(pulseTag('BTC/USDT', 4.2)).toBe('BTC +4.2% 1H')
  })

  it('uses the typographic minus for drops (matches market-data stat cells)', () => {
    expect(pulseTag('SOL/USDT', -5.04)).toBe('SOL −5.0% 1H')
    expect(formatSignedPct(-0.06)).toBe('−0.1%')
  })
})

describe('threshold + cooldown gates', () => {
  it('below the threshold: no tag, and no cooldown is burned', () => {
    const watcher = createPulseWatcher({ thresholdPct: 3, cooldownMs: 1000, now: () => 0 })
    const session = {}
    expect(watcher.maybeTag(session, snapWith1hMove(2.9))).toBeNull()
    // The quiet miss must not start a cooldown — a real move right after fires.
    expect(watcher.maybeTag(session, snapWith1hMove(3.1))).toBe('BTC +3.1% 1H')
  })

  it('one pulse per session per cooldown window — no spam, one state', () => {
    let t = 0
    const watcher = createPulseWatcher({ thresholdPct: 3, cooldownMs: 60_000, now: () => t })
    const session = {}
    expect(watcher.maybeTag(session, snapWith1hMove(5))).toBe('BTC +5.0% 1H')
    t = 30_000 // still inside the window — the move persisting is not news
    expect(watcher.maybeTag(session, snapWith1hMove(6))).toBeNull()
    t = 60_000 // window over — a still-tripping market may pulse again
    expect(watcher.maybeTag(session, snapWith1hMove(6))).toBe('BTC +6.0% 1H')
  })

  it('cooldown is PER SESSION — one trader’s pulse never silences another’s', () => {
    const watcher = createPulseWatcher({ thresholdPct: 3, cooldownMs: 60_000, now: () => 0 })
    const a = {}
    const b = {}
    expect(watcher.maybeTag(a, snapWith1hMove(5))).not.toBeNull()
    expect(watcher.maybeTag(b, snapWith1hMove(5))).not.toBeNull()
  })

  it('default threshold is modest but real (3%)', () => {
    expect(DEFAULT_PULSE_THRESHOLD_PCT).toBe(3)
  })
})

describe('wire: pulse frames on a live stream (transient, like price_tick)', () => {
  it('a >threshold 1h move emits ONE pulse — transient, never journaled, never id’d', async () => {
    process.env.PRICE_TICK_INTERVAL_MS = '25'
    try {
      const moved = snapWith1hMove(4.2)
      const { app, sessions } = await testApp({
        market: { snapshot: async (symbol) => ({ ...moved, symbol }) },
      })
      const session = await createSession(app, sessions)
      await app.listen({ port: 0, host: '127.0.0.1' })
      const address = app.server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      const url = `http://127.0.0.1:${address.port}/v1/stream?session=${session.id}`

      // Read the live socket until several ticks have passed — enough polls
      // for a spammy implementation to have betrayed itself.
      const ctrl = new AbortController()
      const res = await fetch(url, { signal: ctrl.signal })
      const reader = res.body?.getReader()
      if (!reader) throw new Error('no body stream')
      const decoder = new TextDecoder()
      let buf = ''
      const deadline = Date.now() + 3000
      while ((buf.match(/"price_tick"/g) ?? []).length < 3) {
        if (Date.now() > deadline) throw new Error(`not enough ticks; got:\n${buf}`)
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
      }
      ctrl.abort()

      // Exactly one pulse across many polls (default 30min cooldown).
      expect((buf.match(/"pulse"/g) ?? []).length).toBe(1)
      const pulseLine = buf.split('\n').find((l) => l.includes('"pulse"'))
      const frame = JSON.parse((pulseLine ?? '').replace(/^data: /, ''))
      expect(frame.type).toBe('pulse')
      expect(frame.tag).toBe('BTC +4.2% 1H')

      // Transient contract: no `id:` line rides a pulse, and the journal —
      // the only replay source — contains none.
      expect(buf).not.toMatch(/id: \d+\ndata: [^\n]*"pulse"/)
      expect(session.journal.after(0).some((e) => e.frame.type === 'pulse')).toBe(false)

      await app.close()
    } finally {
      delete process.env.PRICE_TICK_INTERVAL_MS
    }
  })

  it('a quiet market pulses nothing — silence is the default state', async () => {
    process.env.PRICE_TICK_INTERVAL_MS = '25'
    try {
      // The shared fixture's last hour is ~flat (61,250 → 61,240).
      const { app, sessions } = await testApp()
      const session = await createSession(app, sessions)
      await app.listen({ port: 0, host: '127.0.0.1' })
      const address = app.server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')

      const ctrl = new AbortController()
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/stream?session=${session.id}`, {
        signal: ctrl.signal,
      })
      const reader = res.body?.getReader()
      if (!reader) throw new Error('no body stream')
      const decoder = new TextDecoder()
      let buf = ''
      const deadline = Date.now() + 3000
      while ((buf.match(/"price_tick"/g) ?? []).length < 3) {
        if (Date.now() > deadline) throw new Error(`not enough ticks; got:\n${buf}`)
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
      }
      ctrl.abort()

      expect(buf).not.toContain('"pulse"')
      await app.close()
    } finally {
      delete process.env.PRICE_TICK_INTERVAL_MS
    }
  })
})
