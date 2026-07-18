import { describe, expect, it } from 'vitest'
import {
  briefFixture,
  createSession,
  deadIntel,
  deadMarket,
  deadMemory,
  deadSeam,
  frameOfType,
  portfolioFixture,
  sendTurn,
  stubIntel,
  stubMemory,
  stubSeam,
  testApp,
  ticketFixture,
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

describe('orchestrator: streaming research (brief_delta)', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('emits coalesced brief_delta frames, then the authoritative research_brief', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        respondStream: async function* () {
          yield { event: 'meta', data: {} }
          yield { event: 'delta', data: { text: 'BTC is down 4.2% ' } }
          await delay(170) // beyond the 150ms coalescing window → second flush
          yield { event: 'delta', data: { text: 'after the US inflation print.' } }
          await delay(170)
          yield { event: 'done', data: briefFixture }
        },
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    const types = await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(types.filter((t) => t === 'brief_delta').length).toBeGreaterThanOrEqual(2)
    expect(types[types.length - 1]).toBe('research_brief')
    // Deltas arrive between the skeleton and the final brief.
    expect(types.indexOf('brief_delta')).toBeGreaterThan(types.indexOf('skeleton'))
    await app.close()
  })

  it('guardrail replace mid-stream becomes an advice_decline frame', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        respondStream: async function* () {
          yield { event: 'meta', data: {} }
          yield { event: 'delta', data: { text: 'You should… ' } }
          yield {
            event: 'replace',
            data: {
              kind: 'decline' as const,
              message: 'No calls — by design.',
              pivotTitle: "What's true right now",
              facts: [{ icon: '◎', text: 'BTC at 61,240' }],
              followups: ['Why is BTC moving?'],
            },
          }
        },
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    const types = await waitForJournal(session, (t) => t.includes('advice_decline'))
    expect(types).not.toContain('research_brief')
    await app.close()
  })

  it('a stream that dies mid-generation degrades to the market-only brief', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        respondStream: async function* () {
          yield { event: 'delta', data: { text: 'BTC is ' } }
          throw new Error('stream died')
        },
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    const types = await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(types).toContain('banner') // degraded, honestly labeled
    const brief = frameOfType<{ sources: string[] }>(session, 'research_brief')
    expect(brief.sources).toEqual(['PRICE FEED'])
    await app.close()
  })

  it('stream_stop mid-stream halts deltas and emits the stopped brief from accumulated text', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        respondStream: async function* () {
          yield { event: 'meta', data: { asOfIso: '2026-07-14T09:02:05.000Z' } }
          yield { event: 'delta', data: { text: 'BTC is down 4.2% ' } }
          await delay(170)
          yield { event: 'delta', data: { text: 'after the US inflation print. ' } }
          await delay(1_000) // the long tail the trader won't sit through
          yield { event: 'delta', data: { text: 'NEVER-DELIVERED ' } }
          yield { event: 'done', data: briefFixture }
        },
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    await waitForJournal(session, (t) => t.includes('brief_delta'))
    expect(await sendTurn(app, session.id, { kind: 'stream_stop' })).toBe(200)

    const types = await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(types[types.length - 1]).toBe('research_brief')

    const brief = frameOfType<{
      eyebrow: string
      headline: string
      paragraphs: string[]
      stats: unknown[]
      spark?: unknown
      liveBar?: { asOfIso: string }
    }>(session, 'research_brief')
    // Server-assembled from what actually streamed — honest and truncated.
    expect(brief.eyebrow).toBe('MARKET BRIEF · STOPPED')
    expect(brief.paragraphs.join(' ')).toContain('BTC is down 4.2%')
    expect(brief.paragraphs.join(' ')).not.toContain('NEVER-DELIVERED')
    expect(brief.headline).not.toBe(briefFixture.headline) // never the full brief
    // The server fabricates no numbers it didn't retrieve…
    expect(brief.stats).toEqual([])
    expect(brief.spark).toBeUndefined()
    // …but the snapshot meta HAD been fetched, so the liveBar asOf is real.
    expect(brief.liveBar?.asOfIso).toBe('2026-07-14T09:02:05.000Z')

    // Deltas cease: even after the stream's tail would have fired, nothing
    // else lands in the journal.
    const seqAtStop = session.journal.lastSeq()
    await delay(1_300)
    expect(session.journal.lastSeq()).toBe(seqAtStop)
    await app.close()
  })

  it('stream_stop with no active stream is a silent no-op', async () => {
    const { app, sessions } = await testApp()
    const session = await createSession(app, sessions)
    const before = session.journal.lastSeq()
    expect(await sendTurn(app, session.id, { kind: 'stream_stop' })).toBe(200)
    await delay(50)
    expect(session.journal.lastSeq()).toBe(before) // nothing emitted
    await app.close()
  })

  it('a stream ending without done also degrades truthfully', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        respondStream: async function* () {
          yield { event: 'meta', data: {} }
          // …and nothing else: connection closed early.
        },
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    const types = await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(types).toContain('banner')
    await app.close()
  })
})

describe('orchestrator: memory v1 (opt-in persona)', () => {
  it('consent uplink flips memory opt-in', async () => {
    const memory = stubMemory()
    const { app, sessions } = await testApp({ memory })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'consent', memoryOptIn: true, l2Acknowledged: true })
    expect(memory.updates).toContainEqual({ userId: session.id, patch: { optIn: true } })
    await app.close()
  })

  it('research turns record followed asset + open thread for opted-in users', async () => {
    const memory = stubMemory({ optIn: true })
    const { app, sessions } = await testApp({ memory })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is sol down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const recorded = memory.updates.find((u) => u.patch.followAsset)
    expect(recorded?.patch.followAsset).toBe('SOL')
    expect(recorded?.patch.openThread?.text).toBe('why is sol down?')
    await app.close()
  })

  it('records nothing for opted-out users — persona, not surveillance', async () => {
    const memory = stubMemory() // optIn defaults false
    const { app, sessions } = await testApp({ memory })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is sol down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(memory.updates).toHaveLength(0)
    await app.close()
  })

  it('forwards experience level to the research engine for opted-in users', async () => {
    const memory = stubMemory({ optIn: true, experienceLevel: 'new' })
    let seenPersona: unknown = 'unset'
    const { app, sessions } = await testApp({
      memory,
      intel: stubIntel({
        respondStream: async function* (req) {
          seenPersona = req.persona
          yield { event: 'done', data: briefFixture }
        },
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'what is funding?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(seenPersona).toEqual({ experienceLevel: 'new' })
    await app.close()
  })

  it('settings clearMemory wipes the persona', async () => {
    const memory = stubMemory({ optIn: true })
    const { app, sessions } = await testApp({ memory })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'settings', clearMemory: true })
    expect(memory.clears).toContain(session.id)
    await app.close()
  })

  it('memory being hard-down never breaks a research turn', async () => {
    const { app, sessions } = await testApp({ memory: deadMemory })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    const types = await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(types).not.toContain('banner') // not even degraded — just no memory
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

  it('prepares a ticket via the seam and forwards its rows verbatim', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: buyIntent, seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.05 btc at market' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))

    // The seam received the canonical prepare request…
    expect(seam.prepares[0]).toMatchObject({
      partnerId: 'koinbx-dev',
      side: 'buy',
      size: '0.05',
      instrument: 'BTC/USDT',
      orderType: 'market',
    })
    // …and the frame carries the seam's display rows untouched.
    const ticket = frameOfType<{
      ticketId: string
      sideLabel: string
      rows: Array<{ label: string; value: string }>
      cta: string
    }>(session, 'order_ticket')
    expect(ticket.sideLabel).toBe('BUY · MKT')
    expect(ticket.rows).toEqual(ticketFixture.rows)
    expect(ticket.cta).toContain('KoinBX')
    await app.close()
  })

  it('confirm_handoff → awaiting_confirm, then the venue event webhook drives the fill', async () => {
    const seam = stubSeam()
    const { app, sessions, telemetry } = await testApp({ intel: buyIntent, seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    const ticket = frameOfType<{ ticketId: string }>(session, 'order_ticket')

    await sendTurn(app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'confirm_handoff',
    })
    await waitForJournal(session, (t) => t.includes('lifecycle'))
    expect(seam.confirms).toEqual([ticket.ticketId])

    // Simulate the venue: the seam POSTs the fill to /internal/venue-events.
    const res = await app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      payload: {
        ticketId: ticket.ticketId,
        phase: 'filled',
        statusLine: 'FILLED',
        venueOrderId: 'SIM-12345678',
        rows: [{ label: 'Fees (actual)', value: '3.06 USDT' }],
      },
    })
    expect(res.json()).toEqual({ ok: true, routed: true })

    const phases = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'lifecycle')
      .map((e) => (e.frame as { phase: string }).phase)
    expect(phases).toEqual(['awaiting_confirm', 'filled'])

    const metrics = telemetry.snapshot() as { mau: { order_executed: number } }
    expect(metrics.mau.order_executed).toBe(1)
    await app.close()
  })

  it('cancel → cancelled lifecycle; a late venue event for that ticket is not routed', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: buyIntent, seam })
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
    expect(seam.cancels).toEqual([ticket.ticketId])

    // A straggler venue event after cancel must not resurrect the thread.
    const res = await app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      payload: { ticketId: ticket.ticketId, phase: 'filled', statusLine: 'FILLED' },
    })
    expect(res.json()).toEqual({ ok: true, routed: false })

    const phases = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'lifecycle')
      .map((e) => (e.frame as { phase: string }).phase)
    expect(phases).toEqual(['cancelled'])
    await app.close()
  })

  it('seam down → honest rejection ticket, nothing sent to the venue', async () => {
    const { app, sessions } = await testApp({ intel: buyIntent, seam: deadSeam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    const types = await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(types).not.toContain('order_ticket')
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

  it('portfolio → positions frame from the seam (never cached)', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        intent: () => ({ intent: 'portfolio', confidence: 0.9, language: 'en' }),
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'my positions' })
    await waitForJournal(session, (t) => t.includes('positions'))
    const positions = frameOfType<{ rows: Array<{ instrument: string }> }>(session, 'positions')
    expect(positions.rows).toEqual(portfolioFixture.positions)
    await app.close()
  })

  it('portfolio with the seam down → honest unavailability, never a fabricated table', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        intent: () => ({ intent: 'portfolio', confidence: 0.9, language: 'en' }),
      }),
      seam: deadSeam,
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'my positions' })
    const types = await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(types).not.toContain('positions')
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
