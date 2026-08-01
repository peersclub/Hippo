import { describe, expect, it } from 'vitest'
import { assembleHistory } from '../src/orchestrator/index.js'
import type { HistoryItem, IntelligenceClient } from '../src/orchestrator/intelligence.js'
import type { JournalEntry } from '../src/plugins/sse.js'
import {
  briefFixture,
  createSession,
  sendTurn,
  stubIntel,
  testApp,
  waitForJournal,
} from './helpers.js'

// Conversation-history threading: the orchestrator assembles a bounded thread
// (user echoes + assistant answer HEADLINES) from the frame journal and passes
// it to /v1/intent ONLY — the respond/stream calls stay history-blind so the
// fleet-wide answer cache keeps its key.

type IntentReq = { text: string; language?: string; history?: HistoryItem[] }

/** stubIntel wrapper that records the FULL intent request (helpers' override
 * surface only exposes the text). */
function recordingIntel(intentCalls: IntentReq[]): IntelligenceClient {
  const base = stubIntel({})
  return {
    ...base,
    intent: async (req) => {
      intentCalls.push(req)
      return { intent: 'research', confidence: 0.95, language: 'en' }
    },
  }
}

async function turn(
  app: Awaited<ReturnType<typeof testApp>>['app'],
  session: Awaited<ReturnType<typeof createSession>>,
  text: string,
): Promise<void> {
  const before = session.journal.after(0).filter((e) => e.frame.type === 'research_brief').length
  expect(await sendTurn(app, session.id, { kind: 'user_text', text })).toBe(200)
  await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length > before)
}

describe('conversation history: gateway assembly', () => {
  it('first turn sends NO history; follow-up carries the prior exchange', async () => {
    const intentCalls: IntentReq[] = []
    const { app, sessions } = await testApp({ intel: recordingIntel(intentCalls) })
    const session = await createSession(app, sessions)

    await turn(app, session, 'price of btc')
    expect(intentCalls[0]?.history).toBeUndefined()

    await turn(app, session, 'what about eth?')
    expect(intentCalls[1]?.text).toBe('what about eth?')
    expect(intentCalls[1]?.history).toEqual([
      { role: 'user', text: 'price of btc' },
      { role: 'assistant', text: briefFixture.headline },
    ])
    await app.close()
  })

  it('assistant items are headlines only — never brief paragraphs', async () => {
    const intentCalls: IntentReq[] = []
    const { app, sessions } = await testApp({ intel: recordingIntel(intentCalls) })
    const session = await createSession(app, sessions)

    await turn(app, session, 'price of btc')
    await turn(app, session, 'why is it down?')
    const history = intentCalls[1]?.history ?? []
    const assistant = history.filter((h) => h.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]?.text).toBe(briefFixture.headline)
    for (const h of history) {
      expect(h.text).not.toContain(briefFixture.paragraphs[0])
    }
    await app.close()
  })

  it('bounds: ≤6 exchanges and ≤1200 total chars, newest kept', async () => {
    const intentCalls: IntentReq[] = []
    const { app, sessions } = await testApp({ intel: recordingIntel(intentCalls) })
    const session = await createSession(app, sessions)

    for (let i = 0; i < 9; i++) await turn(app, session, `question number ${i} about btc`)
    const history = intentCalls[8]?.history ?? []
    expect(history.filter((h) => h.role === 'user').length).toBeLessThanOrEqual(6)
    expect(history.reduce((n, h) => n + h.text.length, 0)).toBeLessThanOrEqual(1200)
    // Newest exchange survives; the earliest fell out of the window.
    expect(history.some((h) => h.text === 'question number 7 about btc')).toBe(true)
    expect(history.some((h) => h.text === 'question number 0 about btc')).toBe(false)
    await app.close()
  })

  it('history feeds intent only — the respond stream never sees it', async () => {
    const streamReqs: Array<Record<string, unknown>> = []
    const base = stubIntel({})
    const intel: IntelligenceClient = {
      ...base,
      respondStream: (req) => {
        streamReqs.push(req as unknown as Record<string, unknown>)
        return base.respondStream(req)
      },
    }
    const { app, sessions } = await testApp({ intel })
    const session = await createSession(app, sessions)
    await turn(app, session, 'price of btc')
    await turn(app, session, 'what about eth?')
    for (const req of streamReqs) {
      expect(req).not.toHaveProperty('history')
    }
    await app.close()
  })
})

describe('conversation history: assembleHistory (pure)', () => {
  const entry = (frame: Record<string, unknown>, seq: number): JournalEntry =>
    ({ seq, frame }) as unknown as JournalEntry

  it('drops the in-flight turn and returns [] on a first turn', () => {
    const entries = [
      entry({ type: 'orders_snapshot', open: [], positionsCount: 0 }, 1),
      entry({ type: 'user_echo', text: 'price of btc' }, 2),
      entry({ type: 'thinking', lines: [] }, 3),
    ]
    expect(assembleHistory(entries)).toEqual([])
  })

  it('brief headline wins over the interpretation summary', () => {
    const entries = [
      entry({ type: 'user_echo', text: 'price of btc' }, 1),
      entry({ type: 'interpretation', summary: 'Looking up live market info.' }, 2),
      entry({ type: 'research_brief', headline: 'BTC is down 4.2%' }, 3),
      entry({ type: 'user_echo', text: 'what about eth?' }, 4),
    ]
    expect(assembleHistory(entries)).toEqual([
      { role: 'user', text: 'price of btc' },
      { role: 'assistant', text: 'BTC is down 4.2%' },
    ])
  })

  it('falls back to the interpretation summary when no brief landed', () => {
    const entries = [
      entry({ type: 'user_echo', text: 'my positions' }, 1),
      entry({ type: 'interpretation', summary: 'Checking your own positions.' }, 2),
      entry({ type: 'positions', rows: [] }, 3),
      entry({ type: 'user_echo', text: 'and my orders?' }, 4),
    ]
    expect(assembleHistory(entries)).toEqual([
      { role: 'user', text: 'my positions' },
      { role: 'assistant', text: 'Checking your own positions.' },
    ])
  })

  it('caps individual item length', () => {
    const entries = [
      entry({ type: 'user_echo', text: 'x'.repeat(999) }, 1),
      entry({ type: 'user_echo', text: 'what about eth?' }, 2),
    ]
    const history = assembleHistory(entries)
    expect(history).toHaveLength(1)
    expect(history[0]?.text.length).toBeLessThanOrEqual(240)
  })
})
