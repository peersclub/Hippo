/**
 * Implicit misunderstanding signals: the pure detectors, the four orchestrator
 * hooks end-to-end, the learn opt-out (text withheld, count kept), the eval
 * export's JSONL shape, and the operator gate on the internal routes.
 */
import { InMemoryIntentSignalStore, type IntentSignal } from '@hippo/stores'
import { describe, expect, it } from 'vitest'
import {
  isRapidRephrase,
  previousTurn,
  REPHRASE_WINDOW_MS,
  toEvalRows,
  toJsonl,
  turnContaining,
  turnsFromJournal,
} from '../src/accuracy-signals.js'
import type { JournalEntry } from '../src/plugins/sse.js'
import {
  createSession,
  deadMemory,
  frameOfType,
  sendTurn,
  stubIntel,
  stubMemory,
  submitDraft,
  TEST_INTERNAL_TOKEN,
  testApp,
  testAppRaw,
  waitForJournal,
} from './helpers.js'

// ── journal fixtures for the pure detectors ────────────────────────────────

let seq = 0
const frame = (type: string, extra: Record<string, unknown> = {}, ts = 1_000): JournalEntry => {
  seq += 1
  return {
    seq,
    frame: { v: 1, id: `f_${seq}`, ts, type, ...extra } as unknown as JournalEntry['frame'],
  }
}

/** user_echo → interpretation → <outcome frames>. */
const turn = (text: string, ts: number, intent: string | null, ...outcome: JournalEntry[]) => [
  frame('user_echo', { text }, ts),
  ...(intent ? [frame('interpretation', { summary: 's', intent }, ts + 10)] : []),
  ...outcome,
]

describe('accuracy signals: turn derivation from the frame journal', () => {
  it('reads text, timestamp, classified intent and outcome per exchange', () => {
    const journal = [
      frame('orders_snapshot', {}, 0), // pre-first-turn frames are ignored
      ...turn('why is btc down', 1_000, 'research', frame('research_brief', { headline: 'h' })),
      ...turn('should i buy', 2_000, 'advice', frame('advice_decline', { message: 'no' })),
    ]
    expect(turnsFromJournal(journal)).toEqual([
      { text: 'why is btc down', ts: 1_000, intent: 'research', outcome: 'answered' },
      { text: 'should i buy', ts: 2_000, intent: 'advice', outcome: 'declined' },
    ])
  })

  it('a turn with no interpretation frame (the low-confidence nudge) is unclassified', () => {
    const journal = turn('hey', 1_000, null, frame('research_brief', { headline: 'Ask me' }))
    expect(previousTurn(journal)).toEqual({ text: 'hey', ts: 1_000, outcome: 'answered' })
    expect(isRapidRephrase(previousTurn(journal), 1_100)).toBe(false)
  })

  it('finds the turn that produced a given frame', () => {
    const journal = [
      ...turn('long btc', 1_000, 'action', frame('order_ticket', { ticketId: 't_1' })),
      ...turn('why is eth up', 2_000, 'research', frame('research_brief', { headline: 'h' })),
    ]
    const found = turnContaining(journal, (f) => f.type === 'order_ticket' && f.ticketId === 't_1')
    expect(found?.text).toBe('long btc')
    expect(found?.intent).toBe('action')
    expect(turnContaining(journal, (f) => f.ticketId === 'nope')).toBeNull()
  })
})

describe('accuracy signals: isRapidRephrase', () => {
  const answered = previousTurn(
    turn('why is btc down', 1_000, 'research', frame('research_brief', { headline: 'h' })),
  )

  it('fires inside the window, not outside it', () => {
    expect(isRapidRephrase(answered, 1_000 + REPHRASE_WINDOW_MS - 1)).toBe(true)
    expect(isRapidRephrase(answered, 1_000 + REPHRASE_WINDOW_MS)).toBe(true)
    expect(isRapidRephrase(answered, 1_000 + REPHRASE_WINDOW_MS + 1)).toBe(false)
  })

  it('is NOT a signal after a clarification — the system already asked back', () => {
    const clarified = previousTurn(
      turn('sell it', 1_000, 'action', frame('clarification', { question: 'sell what?' })),
    )
    expect(clarified?.outcome).toBe('clarified')
    expect(isRapidRephrase(clarified, 1_100)).toBe(false)
  })

  it('is NOT a signal after a decline, a rejection, or an empty turn', () => {
    const declined = previousTurn(
      turn('should i buy', 1_000, 'advice', frame('advice_decline', { message: 'no' })),
    )
    const rejected = previousTurn(
      turn('long btc', 1_000, 'action', frame('rejection_ticket', { title: 'no' })),
    )
    const empty = previousTurn(turn('hmm', 1_000, 'research'))
    expect(isRapidRephrase(declined, 1_100)).toBe(false)
    expect(isRapidRephrase(rejected, 1_100)).toBe(false)
    expect(isRapidRephrase(empty, 1_100)).toBe(false)
    expect(isRapidRephrase(null, 1_100)).toBe(false)
  })
})

describe('accuracy signals: eval export shape', () => {
  const row = (extra: Partial<IntentSignal> = {}): IntentSignal => ({
    id: 'is_1',
    partnerId: 'koinbx-dev',
    userKey: 'u1',
    signal: 'rephrase',
    originalText: 'btc kyu gir raha hai',
    classifiedIntent: 'research',
    detail: { lang: 'hinglish' },
    createdAt: 1,
    ...extra,
  })

  it('emits the harness row shape with expected_intent null', () => {
    expect(toEvalRows([row()])).toEqual([
      {
        text: 'btc kyu gir raha hai',
        lang: 'hinglish',
        category: 'observed',
        expected_intent: null,
        observed_intent: 'research',
        signal: 'rephrase',
      },
    ])
  })

  it('omits lang when unknown and nulls observed_intent when we never classified', () => {
    const [only] = toEvalRows([row({ detail: {}, classifiedIntent: undefined })])
    expect(only).toEqual({
      text: 'btc kyu gir raha hai',
      category: 'observed',
      expected_intent: null,
      observed_intent: null,
      signal: 'rephrase',
    })
    expect(only && 'lang' in only).toBe(false)
  })

  it('drops signals whose text was withheld — a row with no question is not a test case', () => {
    expect(toEvalRows([row({ originalText: undefined })])).toEqual([])
    expect(toJsonl([])).toBe('')
  })

  it('serializes one JSON object per line with a trailing newline', () => {
    const jsonl = toJsonl(toEvalRows([row(), row({ id: 'is_2', signal: 'ticket_abandoned' })]))
    const lines = jsonl.trimEnd().split('\n')
    expect(jsonl.endsWith('\n')).toBe(true)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ signal: 'ticket_abandoned' })
  })
})

// ── end-to-end through the gateway ─────────────────────────────────────────

async function waitForSignals(
  store: InMemoryIntentSignalStore,
  count: number,
  timeoutMs = 2_000,
): Promise<IntentSignal[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await store.list({ partnerId: 'koinbx-dev' })
    if (rows.length >= count) return rows
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} signals; store has ${rows.length}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** No signal may appear — give the fire-and-forget path room to have run. */
async function expectNoSignal(store: InMemoryIntentSignalStore): Promise<void> {
  await new Promise((r) => setTimeout(r, 60))
  expect(await store.list({ partnerId: 'koinbx-dev' })).toEqual([])
}

describe('accuracy signals: rephrase end-to-end', () => {
  it('records the FIRST question (with its intent) when the trader asks again seconds later', async () => {
    const intentSignalStore = new InMemoryIntentSignalStore()
    const { app, sessions } = await testApp({ intentSignalStore })
    const session = await createSession(app, sessions)

    await sendTurn(app, session.id, { kind: 'user_text', text: 'btc funding' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    await sendTurn(app, session.id, { kind: 'user_text', text: 'no I mean the funding RATE' })

    const [row] = await waitForSignals(intentSignalStore, 1)
    expect(row?.signal).toBe('rephrase')
    // The stored text is the possibly-misread FIRST question — never the rephrase.
    expect(row?.originalText).toBe('btc funding')
    expect(row?.classifiedIntent).toBe('research')
    expect(row?.userKey).toBe(session.venueUserId ?? session.id)
    expect(row?.sessionId).toBe(session.id)
    expect(row?.detail?.gapMs).toBeTypeOf('number')
    await app.close()
  })

  it('does not fire after a decline, nor for a chip tap', async () => {
    const intentSignalStore = new InMemoryIntentSignalStore()
    const { app, sessions } = await testApp({
      intentSignalStore,
      intel: stubIntel({
        intent: () => ({ intent: 'advice', confidence: 0.9, language: 'en' }),
        respond: () => ({
          kind: 'decline',
          message: 'no calls',
          pivotTitle: 'what I can do',
          facts: [],
          followups: [],
        }),
      }),
    })
    const session = await createSession(app, sessions)

    await sendTurn(app, session.id, { kind: 'user_text', text: 'should i buy btc' })
    await waitForJournal(session, (t) => t.includes('advice_decline'))
    await sendTurn(app, session.id, { kind: 'user_text', text: 'ok but should i though' })
    await waitForJournal(session, (t) => t.filter((x) => x === 'advice_decline').length === 2)
    // A followup CHIP is a suggested question, not a rephrase.
    await sendTurn(app, session.id, { kind: 'chip_tap', text: 'BTC price picture' })

    await expectNoSignal(intentSignalStore)
    await app.close()
  })
})

describe('accuracy signals: abandoned order intent', () => {
  it('records a pre-confirm ticket cancel with the order terms as evidence', async () => {
    const intentSignalStore = new InMemoryIntentSignalStore()
    const { app, sessions } = await testApp({
      intentSignalStore,
      intel: stubIntel({
        intent: () => ({
          intent: 'action',
          confidence: 0.95,
          language: 'en',
          order: {
            capability: 'spot',
            action: 'open',
            side: 'buy',
            instrument: 'BTC/USDT',
            size: '0.05',
          },
        }),
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'sell 0.05 btc' })
    const { ticket } = await submitDraft(app, session)

    await sendTurn(app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'cancel',
    })

    const [row] = await waitForSignals(intentSignalStore, 1)
    expect(row?.signal).toBe('ticket_abandoned')
    expect(row?.classifiedIntent).toBe('action')
    expect(row?.originalText).toBe('sell 0.05 btc')
    // Exactly the misparse this signal exists to catch: they said SELL, the
    // (stubbed) classifier built a BUY, and they cancelled instead of confirming.
    expect(row?.detail).toMatchObject({ ticketId: ticket.ticketId, side: 'buy' })
    await app.close()
  })

  it('CONFIRMING a ticket is not a signal', async () => {
    const intentSignalStore = new InMemoryIntentSignalStore()
    const { app, sessions } = await testApp({
      intentSignalStore,
      intel: stubIntel({
        intent: () => ({
          intent: 'action',
          confidence: 0.95,
          language: 'en',
          order: {
            capability: 'spot',
            action: 'open',
            side: 'buy',
            instrument: 'BTC/USDT',
            size: '0.05',
          },
        }),
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    const { ticket } = await submitDraft(app, session)

    await sendTurn(app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'confirm_handoff',
    })
    await waitForJournal(session, (t) => t.includes('lifecycle'))

    await expectNoSignal(intentSignalStore)
    await app.close()
  })

  it('records a dismissed draft with the originating turn text', async () => {
    const intentSignalStore = new InMemoryIntentSignalStore()
    const { app, sessions } = await testApp({
      intentSignalStore,
      intel: stubIntel({
        intent: () => ({
          intent: 'action',
          confidence: 0.95,
          language: 'en',
          order: {
            capability: 'spot',
            action: 'open',
            side: 'buy',
            instrument: 'BTC/USDT',
            size: '0.05',
          },
        }),
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'grab me some btc' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<{ draftId: string }>(session, 'order_draft')

    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'dismiss',
    })

    const [row] = await waitForSignals(intentSignalStore, 1)
    expect(row?.signal).toBe('draft_dismissed')
    expect(row?.originalText).toBe('grab me some btc')
    expect(row?.classifiedIntent).toBe('action')
    expect(row?.detail).toMatchObject({ draftId: draft.draftId, side: 'buy' })
    await app.close()
  })
})

describe('accuracy signals: feedback joined to the classified intent', () => {
  it('records a thumbs-DOWN against the intent we assigned that turn; up is not a signal', async () => {
    const intentSignalStore = new InMemoryIntentSignalStore()
    const { app, sessions } = await testApp({ intentSignalStore })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const brief = frameOfType<{ id: string }>(session, 'research_brief')

    await sendTurn(app, session.id, { kind: 'feedback', frameId: brief.id, vote: 'up' })
    await expectNoSignal(intentSignalStore)

    await sendTurn(app, session.id, {
      kind: 'feedback',
      frameId: brief.id,
      vote: 'down',
      reason: 'inaccurate',
    })
    const [row] = await waitForSignals(intentSignalStore, 1)
    expect(row?.signal).toBe('negative_feedback')
    expect(row?.classifiedIntent).toBe('research')
    expect(row?.originalText).toBe('why is btc down')
    expect(row?.detail).toMatchObject({ frameId: brief.id, reason: 'inaccurate' })
    await app.close()
  })
})

describe('accuracy signals: the learn opt-out is honored', () => {
  it('an opted-out trader is COUNTED but their text is never stored', async () => {
    const intentSignalStore = new InMemoryIntentSignalStore()
    const { app, sessions } = await testApp({
      intentSignalStore,
      memory: stubMemory({ learnOptOut: true }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'btc funding' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    await sendTurn(app, session.id, { kind: 'user_text', text: 'no the FUNDING rate' })

    const [row] = await waitForSignals(intentSignalStore, 1)
    expect(row?.signal).toBe('rephrase')
    expect(row?.classifiedIntent).toBe('research') // the count still teaches us something
    expect(row?.originalText).toBeUndefined() // the words do not
    // …and such a row can never reach the eval export.
    expect(toEvalRows([row as IntentSignal])).toEqual([])
    await app.close()
  })

  it('withholds text when the persona read fails — consent unconfirmed is consent denied', async () => {
    const intentSignalStore = new InMemoryIntentSignalStore()
    const { app, sessions } = await testApp({ intentSignalStore, memory: deadMemory })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'btc funding' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    await sendTurn(app, session.id, { kind: 'user_text', text: 'no the FUNDING rate' })

    const [row] = await waitForSignals(intentSignalStore, 1)
    expect(row?.signal).toBe('rephrase')
    expect(row?.originalText).toBeUndefined()
    await app.close()
  })
})

describe('GET /internal/intent-signals[/export]', () => {
  async function seeded() {
    const intentSignalStore = new InMemoryIntentSignalStore()
    const gateway = await testApp({ intentSignalStore })
    const session = await createSession(gateway.app, gateway.sessions)
    await sendTurn(gateway.app, session.id, { kind: 'user_text', text: 'btc funding' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    await sendTurn(gateway.app, session.id, { kind: 'user_text', text: 'no the FUNDING rate' })
    await waitForSignals(intentSignalStore, 1)
    return gateway
  }

  it('401s without the internal token and 503s when the surface is unconfigured', async () => {
    const { app } = await testApp()
    expect((await app.inject({ method: 'GET', url: '/internal/intent-signals' })).statusCode).toBe(
      401,
    )
    expect(
      (await app.inject({ method: 'GET', url: '/internal/intent-signals/export' })).statusCode,
    ).toBe(401)
    await app.close()

    const raw = await testAppRaw()
    expect(
      (await raw.app.inject({ method: 'GET', url: '/internal/intent-signals' })).statusCode,
    ).toBe(503)
    await raw.app.close()
  })

  it('returns recent signals plus the summary counts', async () => {
    const { app } = await seeded()
    const res = await app.inject({
      method: 'GET',
      url: '/internal/intent-signals',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      signals: IntentSignal[]
      summary: { total: number; bySignal: Record<string, number>; byIntent: Record<string, number> }
    }
    expect(body.signals).toHaveLength(1)
    expect(body.summary.total).toBe(1)
    expect(body.summary.bySignal.rephrase).toBe(1)
    expect(body.summary.byIntent.research).toBe(1)
    await app.close()
  })

  it('exports JSONL in the eval harness row shape', async () => {
    const { app } = await seeded()
    const res = await app.inject({
      method: 'GET',
      url: '/internal/intent-signals/export',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/x-ndjson')
    expect(res.headers['content-disposition']).toContain('intent-signals.jsonl')
    const lines = res.body.trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      text: 'btc funding',
      category: 'observed',
      expected_intent: null,
      observed_intent: 'research',
      signal: 'rephrase',
    })
    await app.close()
  })
})
