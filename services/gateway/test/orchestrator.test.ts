import { describe, expect, it } from 'vitest'
import {
  briefFixture,
  createSession,
  deadIntel,
  deadMarket,
  frameOfType,
  sendTurn,
  stubIntel,
  testApp,
  waitForJournal,
} from './helpers.js'

// The emitter runs strict in tests (NODE_ENV=test): any protocol-invalid
// frame the orchestrator builds throws instead of being dropped, so every
// passing test here also asserts Frame.safeParse validity end-to-end.

describe('orchestrator: research route', () => {
  it('emits user_echo → thinking → skeleton → research_brief', async () => {
    const { app, sessions } = await testApp()
    const session = await createSession(app, sessions)
    expect(await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })).toBe(
      200,
    )
    const types = await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(types).toEqual(['user_echo', 'thinking', 'skeleton', 'research_brief'])

    const brief = frameOfType<{
      headline: string
      liveBar: { asOf: string; cached: boolean }
      sources: string[]
    }>(session, 'research_brief')
    expect(brief.headline).toBe(briefFixture.headline)
    expect(brief.liveBar.asOf).toMatch(/^AS OF \d{2}:\d{2}:\d{2} IST$/)
    expect(brief.liveBar.cached).toBe(false)
    await app.close()
  })

  it('marks cached responses with liveBar.cached + cacheAge', async () => {
    const { app, sessions, telemetry } = await testApp({
      intel: stubIntel({
        respond: () => ({
          ...briefFixture,
          cached: true,
          asOfIso: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'eth funding rate' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const brief = frameOfType<{ liveBar: { cached: boolean; cacheAge?: string } }>(
      session,
      'research_brief',
    )
    expect(brief.liveBar.cached).toBe(true)
    expect(brief.liveBar.cacheAge).toBe('updated 6 min ago')
    const metrics = telemetry.snapshot() as { cache: { hits: number } }
    expect(metrics.cache.hits).toBe(1)
    await app.close()
  })
})

describe('orchestrator: action route', () => {
  const buyIntent = stubIntel({
    intent: () => ({
      intent: 'action',
      confidence: 0.9,
      language: 'en',
      order: { side: 'buy', size: '0.05', instrument: 'BTC/USDT', orderType: 'market' },
    }),
  })

  it('prepares a gateway-side ticket quoted from market-data', async () => {
    const { app, sessions } = await testApp({ intel: buyIntent })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.05 btc at market' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))

    const ticket = frameOfType<{
      ticketId: string
      sideLabel: string
      rows: Array<{ label: string; value: string }>
      cta: string
    }>(session, 'order_ticket')
    expect(ticket.sideLabel).toBe('BUY · MKT')
    const rowMap = Object.fromEntries(ticket.rows.map((r) => [r.label, r.value]))
    expect(rowMap.Instrument).toBe('BTC / USDT')
    expect(rowMap.Size).toBe('0.05 BTC')
    expect(rowMap['Est. price']).toBe('61,240')
    // 0.05 × 61,240 × 1.001 (0.1% fee) = 3,065.062
    expect(rowMap['Est. cost incl. fees']).toBe('3,065.06 USDT')
    expect(ticket.cta).toContain('KoinBX')
    await app.close()
  })

  it('confirm_handoff → awaiting_confirm then simulated fill with quote actuals', async () => {
    const { app, sessions, telemetry } = await testApp({ intel: buyIntent })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    const ticket = frameOfType<{ ticketId: string }>(session, 'order_ticket')

    await sendTurn(app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'confirm_handoff',
    })
    await waitForJournal(session, (t) => t.filter((x) => x === 'lifecycle').length >= 2)

    const phases = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'lifecycle')
      .map((e) => (e.frame as { phase: string }).phase)
    expect(phases).toEqual(['awaiting_confirm', 'filled'])

    const filled = session.journal
      .after(0)
      .map((e) => e.frame as { type: string; phase?: string; rows?: Array<{ label: string }> })
      .find((f) => f.phase === 'filled')
    expect(filled?.rows?.map((r) => r.label)).toContain('Fees (actual)')

    const metrics = telemetry.snapshot() as { mau: { order_executed: number } }
    expect(metrics.mau.order_executed).toBe(1)
    await app.close()
  })

  it('cancel → cancelled lifecycle, no fill', async () => {
    const { app, sessions } = await testApp({ intel: buyIntent, fillDelayMs: 50 })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    const ticket = frameOfType<{ ticketId: string }>(session, 'order_ticket')

    await sendTurn(app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'cancel',
    })
    await waitForJournal(session, (t) => t.includes('lifecycle'))
    await new Promise((r) => setTimeout(r, 80)) // past the would-be fill delay

    const phases = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'lifecycle')
      .map((e) => (e.frame as { phase: string }).phase)
    expect(phases).toEqual(['cancelled'])
    await app.close()
  })
})

describe('orchestrator: other routes', () => {
  it('advice → advice_decline from the intelligence service', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        intent: () => ({ intent: 'advice', confidence: 0.9, language: 'en' }),
        respond: () => ({
          kind: 'decline',
          message: 'No calls — by design.',
          pivotTitle: "What's true about BTC right now",
          facts: [{ icon: '▾', text: 'Down 4.2% in 12h on macro.' }],
          followups: ['How do dips usually resolve?'],
        }),
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'should i buy?' })
    const types = await waitForJournal(session, (t) => t.includes('advice_decline'))
    expect(types).not.toContain('skeleton')
    await app.close()
  })

  it('portfolio → positions frame from the demo table', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        intent: () => ({ intent: 'portfolio', confidence: 0.9, language: 'en' }),
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'my positions' })
    await waitForJournal(session, (t) => t.includes('positions'))
    const positions = frameOfType<{ rows: unknown[] }>(session, 'positions')
    expect(positions.rows).toHaveLength(3)
    await app.close()
  })

  it('smalltalk → helpful nudge brief with suggested queries', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        intent: () => ({ intent: 'smalltalk', confidence: 0.9, language: 'en' }),
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'hello there' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const nudge = frameOfType<{ followups: string[]; headline: string }>(session, 'research_brief')
    expect(nudge.followups.length).toBeGreaterThan(0)
    await app.close()
  })

  it('opening state on stream connect is orders_snapshot only — no scripted thread', async () => {
    const { app, sessions } = await testApp()
    const session = await createSession(app, sessions)
    // onStreamConnect is invoked by the stream route; call the journal check
    // via a real connect in journal.test.ts — here assert the journal is
    // empty until then (thread starts empty; SDK shows its hero).
    expect(session.journal.lastSeq()).toBe(0)
    await app.close()
  })
})

describe('orchestrator: degraded fallback (intelligence down)', () => {
  it('research → degraded banner once + market-data-only brief, sources PRICE FEED', async () => {
    const { app, sessions, telemetry } = await testApp({ intel: deadIntel })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    const types = await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(types).toContain('banner')
    expect(types).toContain('skeleton')

    const brief = frameOfType<{ sources: string[]; headline: string; stats: unknown[] }>(
      session,
      'research_brief',
    )
    expect(brief.sources).toEqual(['PRICE FEED'])
    expect(brief.headline).toBe('BTC is down 4.2% over 12 hours')
    expect(brief.stats.length).toBeGreaterThanOrEqual(2)

    // Second degraded turn: no second banner (once per session per episode).
    await sendTurn(app, session.id, { kind: 'user_text', text: 'and eth?' })
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 2)
    const banners = session.journal.after(0).filter((e) => e.frame.type === 'banner')
    expect(banners).toHaveLength(1)

    const metrics = telemetry.snapshot() as { degraded: { active: boolean } }
    expect(metrics.degraded.active).toBe(true)
    await app.close()
  })

  it('regex fallback still routes "buy 0.05 btc" to a live order ticket', async () => {
    const { app, sessions } = await testApp({ intel: deadIntel })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    const types = await waitForJournal(session, (t) => t.includes('order_ticket'))
    expect(types).toContain('banner')
    const ticket = frameOfType<{ sideLabel: string }>(session, 'order_ticket')
    expect(ticket.sideLabel).toBe('BUY · MKT')
    await app.close()
  })

  it('regex fallback routes advice to a static decline', async () => {
    const { app, sessions } = await testApp({ intel: deadIntel })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'is this the dip?' })
    await waitForJournal(session, (t) => t.includes('advice_decline'))
    await app.close()
  })

  it('regex fallback routes p&l to positions', async () => {
    const { app, sessions } = await testApp({ intel: deadIntel })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'show my p&l' })
    await waitForJournal(session, (t) => t.includes('positions'))
    await app.close()
  })

  it('stays truthful when market-data is down too', async () => {
    const { app, sessions } = await testApp({ intel: deadIntel, market: deadMarket })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const brief = frameOfType<{ headline: string; sources: string[] }>(session, 'research_brief')
    expect(brief.headline).toContain('unavailable')
    expect(brief.sources).toEqual([])
    await app.close()
  })
})

describe('turns endpoint hygiene', () => {
  it('400s invalid uplinks and 404s unknown sessions', async () => {
    const { app } = await testApp()
    const bad = await app.inject({ method: 'POST', url: '/v1/turns', payload: { nope: 1 } })
    expect(bad.statusCode).toBe(400)
    const lost = await app.inject({
      method: 'POST',
      url: '/v1/turns',
      payload: { v: 1, sessionId: 's_ghost', ts: Date.now(), kind: 'user_text', text: 'hi' },
    })
    expect(lost.statusCode).toBe(404)
    await app.close()
  })

  it('feedback/consent/settings uplinks are recorded and ack ok', async () => {
    const { app, sessions, telemetry } = await testApp()
    const session = await createSession(app, sessions)
    expect(
      await sendTurn(app, session.id, {
        kind: 'feedback',
        frameId: 'f_x_1',
        vote: 'down',
        reason: 'too_shallow',
      }),
    ).toBe(200)
    expect(
      await sendTurn(app, session.id, { kind: 'consent', memoryOptIn: true, l2Acknowledged: true }),
    ).toBe(200)
    expect(await sendTurn(app, session.id, { kind: 'settings', language: 'hi' })).toBe(200)
    expect(session.language).toBe('hi')
    const metrics = telemetry.snapshot() as { uplinks: Record<string, number> }
    expect(metrics.uplinks.feedback).toBe(1)
    expect(metrics.uplinks.consent).toBe(1)
    await app.close()
  })
})
