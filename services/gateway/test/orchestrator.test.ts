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
  TEST_INTERNAL_TOKEN,
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
    expect(types).toEqual(['user_echo', 'thinking', 'interpretation', 'skeleton', 'research_brief'])

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

  it('forwards the model id from intelligence deltas onto brief_delta frames', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        respondStream: async function* () {
          yield { event: 'meta', data: {} }
          yield { event: 'delta', data: { text: 'BTC is down ', model: 'anthropic/claude-test' } }
          await delay(170)
          yield { event: 'delta', data: { text: 'sharply.', model: 'anthropic/claude-test' } }
          await delay(170)
          yield { event: 'done', data: briefFixture }
        },
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const deltas = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'brief_delta')
      .map((e) => e.frame as { model?: string })
    expect(deltas.length).toBeGreaterThanOrEqual(2)
    for (const d of deltas) expect(d.model).toBe('anthropic/claude-test')
    // The final brief still carries its own provenance.
    const brief = frameOfType<{ model?: string }>(session, 'research_brief')
    expect(brief.model).toBe(briefFixture.model)
    await app.close()
  })

  it('an intelligence service without delta model tags still streams (no model field)', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        respondStream: async function* () {
          yield { event: 'meta', data: {} }
          yield { event: 'delta', data: { text: 'BTC is down sharply today.' } }
          await delay(170)
          yield { event: 'done', data: briefFixture }
        },
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const delta = frameOfType<{ model?: string }>(session, 'brief_delta')
    expect(delta.model).toBeUndefined()
    await app.close()
  })

  it('a second research turn mid-stream stops the first stream, then streams cleanly', async () => {
    const { app, sessions } = await testApp({
      intel: stubIntel({
        respondStream: async function* (req) {
          if (req.text === 'first question') {
            yield { event: 'meta', data: {} }
            yield { event: 'delta', data: { text: 'FIRST-STREAM ' } }
            await delay(1_500) // long tail turn B interrupts
            yield { event: 'delta', data: { text: 'NEVER-DELIVERED' } }
            yield { event: 'done', data: briefFixture }
          } else {
            yield { event: 'meta', data: {} }
            yield { event: 'delta', data: { text: 'SECOND-STREAM ' } }
            await delay(170)
            yield { event: 'done', data: { ...briefFixture, headline: 'Second answer' } }
          }
        },
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'first question' })
    await waitForJournal(session, (t) => t.includes('brief_delta'))
    await sendTurn(app, session.id, { kind: 'user_text', text: 'second question' })
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 2, 4_000)
    const frames = session.journal.after(0).map((e) => e.frame)
    // Turn A ends in its stopped brief BEFORE turn B's skeleton — no interleave.
    const stoppedIdx = frames.findIndex(
      (f) =>
        f.type === 'research_brief' && (f as { eyebrow?: string }).eyebrow?.includes('STOPPED'),
    )
    const secondSkeletonIdx = frames.findIndex(
      (f, i) => f.type === 'skeleton' && i > frames.findIndex((x) => x.type === 'skeleton'),
    )
    expect(stoppedIdx).toBeGreaterThan(-1)
    expect(secondSkeletonIdx).toBeGreaterThan(stoppedIdx)
    // Turn A's tail never lands; turn B finishes authoritatively.
    const allText = JSON.stringify(frames)
    expect(allText).not.toContain('NEVER-DELIVERED')
    const briefs = frames.filter((f) => f.type === 'research_brief')
    expect((briefs[briefs.length - 1] as { headline: string }).headline).toBe('Second answer')
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
    expect(ticket.cta).toContain('Assetworks')
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

    // Simulate the venue: the seam POSTs the fill to /internal/venue-events
    // (now guarded by INTERNAL_API_TOKEN — the seam sends it).
    const res = await app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
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
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
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

describe('orchestrator: card actions (reserved chip_tap prefixes)', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('refresh:<frameId> re-runs the original turn in place — no echo, no thinking, no new turn', async () => {
    const { app, sessions } = await testApp()
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is sol down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const first = frameOfType<{ id: string }>(session, 'research_brief')
    const seqBefore = session.journal.lastSeq()

    expect(await sendTurn(app, session.id, { kind: 'chip_tap', text: `refresh:${first.id}` })).toBe(
      200,
    )
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 2)
    const after = session.journal.after(seqBefore).map((e) => e.frame)
    // A refresh is a command, not conversation: nothing conversational lands.
    expect(after.map((f) => f.type)).toEqual(['research_brief'])
    // The re-run supersedes the original card in place.
    expect((after[0] as { replaces?: string }).replaces).toBe(first.id)
    await app.close()
  })

  it('share:/manage: are telemetry-only acks — no frames at all', async () => {
    const { app, sessions, telemetry } = await testApp()
    const session = await createSession(app, sessions)
    const before = session.journal.lastSeq()
    expect(await sendTurn(app, session.id, { kind: 'chip_tap', text: 'share:f_abc_1' })).toBe(200)
    expect(await sendTurn(app, session.id, { kind: 'chip_tap', text: 'manage:o_btc' })).toBe(200)
    await delay(50)
    expect(session.journal.lastSeq()).toBe(before)
    const metrics = telemetry.snapshot() as { uplinks: Record<string, number> }
    expect(metrics.uplinks.card_share).toBe(1)
    expect(metrics.uplinks.card_manage).toBe(1)
    await app.close()
  })

  it('refresh with an unknown frame id says so honestly instead of guessing', async () => {
    const { app, sessions } = await testApp()
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'chip_tap', text: 'refresh:f_gone_1' })
    const types = await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(types).not.toContain('user_echo')
    expect(types).not.toContain('research_brief')
    const rej = frameOfType<{ title: string }>(session, 'rejection_ticket')
    expect(rej.title).toBe('Refresh unavailable')
    await app.close()
  })

  it('degraded refresh falls back to the market-only brief, still in place', async () => {
    // The stream works (first brief lands) but blocking respond — the refresh
    // path — is down: refresh must degrade to the market-only brief honestly.
    const { app, sessions } = await testApp({
      intel: stubIntel({
        respond: () => {
          throw new Error('intelligence unreachable')
        },
        respondStream: async function* () {
          yield { event: 'meta', data: {} }
          yield { event: 'done', data: briefFixture }
        },
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is sol down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const first = frameOfType<{ id: string }>(session, 'research_brief')
    await sendTurn(app, session.id, { kind: 'chip_tap', text: `refresh:${first.id}` })
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 2)
    const briefs = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'research_brief')
      .map((e) => e.frame as { replaces?: string; sources: string[] })
    expect(briefs[1]?.replaces).toBe(first.id)
    expect(briefs[1]?.sources).toEqual(['PRICE FEED'])
    await app.close()
  })
})

describe('orchestrator: venue-event backstop + post-confirm cancel truth', () => {
  const buyIntent = () =>
    stubIntel({
      intent: () => ({
        intent: 'action',
        confidence: 0.9,
        language: 'en',
        order: { side: 'buy', size: '0.05', instrument: 'BTC/USDT', orderType: 'market' },
      }),
    })

  async function preparedAndConfirmed(seam = stubSeam()) {
    const gw = await testApp({ intel: buyIntent(), seam })
    const session = await createSession(gw.app, gw.sessions)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    const ticket = frameOfType<{ ticketId: string }>(session, 'order_ticket')
    await sendTurn(gw.app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'confirm_handoff',
    })
    await waitForJournal(session, (t) => t.includes('lifecycle'))
    return { ...gw, session, ticket }
  }

  it('no venue event within the window → honest terminal expired frame, never eternal waiting', async () => {
    process.env.TICKET_EVENT_TIMEOUT_MS = '80'
    try {
      const { app, session } = await preparedAndConfirmed()
      await waitForJournal(session, (t) => t.filter((x) => x === 'lifecycle').length >= 2)
      const lifecycles = session.journal
        .after(0)
        .filter((e) => e.frame.type === 'lifecycle')
        .map((e) => e.frame as { phase: string; statusLine: string })
      expect(lifecycles[0]?.phase).toBe('awaiting_confirm')
      expect(lifecycles[1]?.phase).toBe('expired')
      expect(lifecycles[1]?.statusLine).toContain('CHECK THE VENUE')
      await app.close()
    } finally {
      delete process.env.TICKET_EVENT_TIMEOUT_MS
    }
  })

  it('a venue event inside the window defuses the backstop', async () => {
    process.env.TICKET_EVENT_TIMEOUT_MS = '120'
    try {
      const { app, session, ticket } = await preparedAndConfirmed()
      await app.inject({
        method: 'POST',
        url: '/internal/venue-events',
        headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
        payload: { ticketId: ticket.ticketId, phase: 'filled', statusLine: 'FILLED' },
      })
      await new Promise((r) => setTimeout(r, 200)) // past the window
      const phases = session.journal
        .after(0)
        .filter((e) => e.frame.type === 'lifecycle')
        .map((e) => (e.frame as { phase: string }).phase)
      expect(phases).toEqual(['awaiting_confirm', 'filled']) // no late 'expired'
      await app.close()
    } finally {
      delete process.env.TICKET_EVENT_TIMEOUT_MS
    }
  })

  it('cancel AFTER confirm never claims "nothing was sent", and a racing fill still reaches the trader', async () => {
    const { app, session, ticket } = await preparedAndConfirmed()
    await sendTurn(app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'cancel',
    })
    await waitForJournal(session, (t) => t.filter((x) => x === 'lifecycle').length >= 2)
    const lifecycles = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'lifecycle')
      .map((e) => e.frame as { phase: string; statusLine: string })
    expect(lifecycles[1]?.statusLine).toContain('CANCEL REQUESTED')
    expect(lifecycles[1]?.statusLine).not.toContain('NOTHING WAS SENT')

    // The venue's fill won the race — it must still be routed and shown.
    const res = await app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
      payload: { ticketId: ticket.ticketId, phase: 'filled', statusLine: 'FILLED' },
    })
    expect(res.json()).toEqual({ ok: true, routed: true })
    const phases = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'lifecycle')
      .map((e) => (e.frame as { phase: string }).phase)
    expect(phases[phases.length - 1]).toBe('filled')
    await app.close()
  })
})

describe('orchestrator: honest order journey (stage + side + order-shaped waiting)', () => {
  const buyIntent = () =>
    stubIntel({
      intent: () => ({
        intent: 'action',
        confidence: 0.9,
        language: 'en',
        order: { side: 'buy', size: '0.05', instrument: 'BTC/USDT', orderType: 'market' },
      }),
    })

  it('order turns get order-shaped thinking lines + a ticket skeleton; research keeps its own', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: buyIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.05 btc at market' })
    const types = await waitForJournal(session, (t) => t.includes('order_ticket'))
    expect(types).toEqual(['user_echo', 'thinking', 'interpretation', 'skeleton', 'order_ticket'])
    const thinking = frameOfType<{ lines: string[] }>(session, 'thinking')
    expect(thinking.lines[0]).toBe('Constructing order…')
    expect(thinking.lines[1]).toContain('Checking balance on')
    const skeleton = frameOfType<{ shape: string }>(session, 'skeleton')
    expect(skeleton.shape).toBe('ticket')
    await app.close()
  })

  it('confirm emits stage:placing with neutral SENDING copy and the ticket side', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: buyIntent(), seam })
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
    const lc = frameOfType<{
      phase: string
      stage?: string
      side?: string
      statusLine: string
      cancellable: boolean
    }>(session, 'lifecycle')
    expect(lc.phase).toBe('awaiting_confirm')
    expect(lc.stage).toBe('placing')
    expect(lc.side).toBe('buy')
    // Neutral copy: the gateway cannot know the venue's confirm surface, so
    // "sending" is the only honest claim at this moment.
    expect(lc.statusLine).toContain('SENDING ORDER TO')
    expect(lc.statusLine).not.toContain('WAITING FOR YOUR CONFIRM')
    expect(lc.cancellable).toBe(true)
    await app.close()
  })

  it('a working placement ack passes through (stage/cancellable/side) WITHOUT tearing down routing', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: buyIntent(), seam })
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

    // The venue acks placement (non-terminal awaiting_confirm)…
    const ack = await app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        ticketId: ticket.ticketId,
        phase: 'awaiting_confirm',
        stage: 'working',
        statusLine: 'PLACED — WORKING',
        cancellable: true,
      },
    })
    expect(ack.json()).toEqual({ ok: true, routed: true })

    // …and the FILL that follows must still be routed (the ack is not terminal).
    const fill = await app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
      payload: { ticketId: ticket.ticketId, phase: 'filled', statusLine: 'FILLED' },
    })
    expect(fill.json()).toEqual({ ok: true, routed: true })

    const lifecycles = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'lifecycle')
      .map((e) => e.frame as { phase: string; stage?: string; side?: string })
    expect(lifecycles.map((l) => l.stage)).toEqual(['placing', 'working', undefined])
    // Side is enriched from the gateway's own ticket map on every frame.
    expect(lifecycles.every((l) => l.side === 'buy')).toBe(true)
    await app.close()
  })

  it('post-confirm cancel is stage:cancel_pending (not cancellable)', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: buyIntent(), seam })
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
    await sendTurn(app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'cancel',
    })
    await waitForJournal(session, (t) => t.filter((x) => x === 'lifecycle').length >= 2)
    const lifecycles = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'lifecycle')
      .map((e) => e.frame as { stage?: string; cancellable: boolean })
    expect(lifecycles[1]?.stage).toBe('cancel_pending')
    expect(lifecycles[1]?.cancellable).toBe(false)
    await app.close()
  })

  it('backstop expiry carries the side read before ticket teardown', async () => {
    process.env.TICKET_EVENT_TIMEOUT_MS = '80'
    try {
      const seam = stubSeam()
      const { app, sessions } = await testApp({ intel: buyIntent(), seam })
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
      const lifecycles = session.journal
        .after(0)
        .filter((e) => e.frame.type === 'lifecycle')
        .map((e) => e.frame as { phase: string; side?: string })
      expect(lifecycles[1]?.phase).toBe('expired')
      expect(lifecycles[1]?.side).toBe('buy')
      await app.close()
    } finally {
      delete process.env.TICKET_EVENT_TIMEOUT_MS
    }
  })
})

describe('orchestrator: stage-1 interpretation', () => {
  it('emits a persistent interpretation frame and forwards the restructured query to the answer engine', async () => {
    let seenText: string | undefined
    const intel = stubIntel({
      intent: async () => ({
        intent: 'research',
        confidence: 0.95,
        language: 'en',
        interpretation: 'Wants the drivers behind the BTC drop.',
        restructuredQuery: 'What is driving the BTC/USDT decline today?',
      }),
      respondStream: async function* (req) {
        seenText = req.text
        yield { event: 'meta', data: {} }
        yield { event: 'done', data: briefFixture }
      },
    })
    const { app, sessions } = await testApp({ intel })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why btc down' })
    await waitForJournal(session, (t) => t.includes('research_brief'))

    const interp = frameOfType<{ summary: string; intent: string }>(session, 'interpretation')
    expect(interp.summary).toBe('Wants the drivers behind the BTC drop.')
    expect(interp.intent).toBe('research')
    // The RESTRUCTURED query reached the answer engine, not the raw text.
    expect(seenText).toBe('What is driving the BTC/USDT decline today?')
    await app.close()
  })

  it('falls back to a default summary and the raw text when stage-1 omits the new fields', async () => {
    let seenText: string | undefined
    const intel = stubIntel({
      intent: async () => ({ intent: 'research', confidence: 0.95, language: 'en' }),
      respondStream: async function* (req) {
        seenText = req.text
        yield { event: 'meta', data: {} }
        yield { event: 'done', data: briefFixture }
      },
    })
    const { app, sessions } = await testApp({ intel })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why btc down' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const interp = frameOfType<{ summary: string }>(session, 'interpretation')
    expect(interp.summary.length).toBeGreaterThan(0) // default, not empty
    expect(seenText).toBe('why btc down') // raw text forwarded
    await app.close()
  })
})

describe('orchestrator: memory composition (Phase C)', () => {
  it('composes scope docs, forwards them as memoryContext, tags the card, and saves the snapshot', async () => {
    let seenMemory: string | undefined
    const intel = stubIntel({
      intent: async () => ({ intent: 'research', confidence: 0.95, language: 'en' }),
      respondStream: async function* (req) {
        seenMemory = (req as { memoryContext?: string }).memoryContext
        yield { event: 'meta', data: {} }
        yield { event: 'done', data: briefFixture }
      },
    })
    const memory = stubMemory()
    memory.scopeDocsData.global = 'never give advice'
    memory.scopeDocsData.host = 'KoinBX-style venue'
    const { app, sessions } = await testApp({ intel, memory })
    const session = await createSession(app, sessions)
    session.partner = { ...session.partner, entitlements: { memoryLab: true } }
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why btc down' })
    await waitForJournal(session, (t) => t.includes('research_brief'))

    // memoryContext forwarded, authority-ordered
    expect(seenMemory).toContain('PLATFORM RULES')
    expect(seenMemory).toContain('VENUE CONTEXT')
    expect(seenMemory?.indexOf('PLATFORM RULES')).toBeLessThan(
      seenMemory?.indexOf('VENUE CONTEXT') ?? 0,
    )
    // interpretation card tagged with the applied scopes
    const interp = frameOfType<{ memoryScopes: string[] }>(session, 'interpretation')
    expect(interp.memoryScopes).toEqual(['platform', 'venue'])
    // composed snapshot persisted for the inspector
    expect(memory.composed.get(session.id)).toContain('PLATFORM RULES')
    await app.close()
  })

  it('no scope docs → no memoryContext, empty scopes (memory off is inert)', async () => {
    let seenMemory: string | undefined = 'set'
    const intel = stubIntel({
      intent: async () => ({ intent: 'research', confidence: 0.95, language: 'en' }),
      respondStream: async function* (req) {
        seenMemory = (req as { memoryContext?: string }).memoryContext
        yield { event: 'meta', data: {} }
        yield { event: 'done', data: briefFixture }
      },
    })
    const { app, sessions } = await testApp({ intel, memory: stubMemory() })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why btc down' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(seenMemory).toBeUndefined()
    const interp = frameOfType<{ memoryScopes: string[] }>(session, 'interpretation')
    expect(interp.memoryScopes).toEqual([])
    await app.close()
  })
})

describe('orchestrator: memoryLab entitlement gate (Phase D)', () => {
  const composeIntel = (capture: { mem?: string }) =>
    stubIntel({
      intent: async () => ({ intent: 'research', confidence: 0.95, language: 'en' }),
      respondStream: async function* (req) {
        capture.mem = (req as { memoryContext?: string }).memoryContext
        yield { event: 'meta', data: {} }
        yield { event: 'done', data: briefFixture }
      },
    })

  it('UNENTITLED partner: docs exist but nothing composes — no memoryContext, empty scopes', async () => {
    const capture: { mem?: string } = { mem: 'unset' }
    const memory = stubMemory()
    memory.scopeDocsData.global = 'never give advice' // a doc IS set…
    const { app, sessions } = await testApp({ intel: composeIntel(capture), memory })
    const session = await createSession(app, sessions) // …but no memoryLab entitlement
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why btc down' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(capture.mem).toBeUndefined() // …so it never reaches the model
    const interp = frameOfType<{ memoryScopes: string[] }>(session, 'interpretation')
    expect(interp.memoryScopes).toEqual([])
    expect(memory.composed.get(session.id)).toBeUndefined() // and nothing persisted
    await app.close()
  })

  it('ENTITLED partner: the same docs compose and reach the model', async () => {
    const capture: { mem?: string } = {}
    const memory = stubMemory()
    memory.scopeDocsData.global = 'never give advice'
    const { app, sessions } = await testApp({ intel: composeIntel(capture), memory })
    const session = await createSession(app, sessions)
    session.partner = { ...session.partner, entitlements: { memoryLab: true } }
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why btc down' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(capture.mem).toContain('PLATFORM RULES')
    const interp = frameOfType<{ memoryScopes: string[] }>(session, 'interpretation')
    expect(interp.memoryScopes).toEqual(['platform'])
    await app.close()
  })
})
