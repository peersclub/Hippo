/**
 * Language plumbing: the session's answer language (settings uplink) must
 * reach the answer engine on EVERY respond path.
 *
 * The shipped bug: session.language was passed to intent() and analyze-file
 * but to none of the respond/respondStream call sites — the SDK's language
 * picker changed chip labels while every answer stayed English. These tests
 * capture the actual payloads the orchestrator sends and pin the field on all
 * three sites: the streaming research turn, the blocking advice decline, and
 * the refresh:<frameId> re-run.
 */
import { describe, expect, it } from 'vitest'
import type {
  IntelligenceClient,
  RespondStreamEvent,
} from '../src/orchestrator/intelligence.js'
import {
  briefFixture,
  createSession,
  frameOfType,
  sendTurn,
  stubIntel,
  testApp,
  waitForJournal,
} from './helpers.js'

type RespondReq = Parameters<IntelligenceClient['respond']>[0]
type StreamReq = Parameters<IntelligenceClient['respondStream']>[0]

/** stubIntel whose respond() records its payload (the stock stub drops it). */
function capturingIntel(
  seen: RespondReq[],
  intent?: Parameters<typeof stubIntel>[0]['intent'],
): IntelligenceClient {
  const base = stubIntel(intent ? { intent } : {})
  return {
    ...base,
    respond: async (req) => {
      seen.push(req)
      return req.intent === 'advice'
        ? {
            kind: 'decline',
            message: 'No calls here.',
            pivotTitle: 'BTC right now',
            facts: [{ icon: '📊', text: 'BTC is trading at 61,240' }],
            followups: ['Why is BTC moving?', 'What is funding?'],
          }
        : briefFixture
    },
  }
}

describe('orchestrator: session language reaches the answer engine', () => {
  it('research stream payload carries the settings language', async () => {
    const seen: StreamReq[] = []
    const { app, sessions } = await testApp({
      intel: stubIntel({
        respondStream: async function* (req): AsyncGenerator<RespondStreamEvent> {
          seen.push(req)
          yield { event: 'meta', data: {} }
          yield { event: 'done', data: briefFixture }
        },
      }),
    })
    const session = await createSession(app, sessions)
    expect(await sendTurn(app, session.id, { kind: 'settings', language: 'hi' })).toBe(200)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.language).toBe('hi')
    await app.close()
  })

  it('stream payload omits language until a settings uplink sets one', async () => {
    const seen: StreamReq[] = []
    const { app, sessions } = await testApp({
      intel: stubIntel({
        respondStream: async function* (req): AsyncGenerator<RespondStreamEvent> {
          seen.push(req)
          yield { event: 'meta', data: {} }
          yield { event: 'done', data: briefFixture }
        },
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    // Absent, not null/'' — the intelligence service's English default owns it.
    expect(seen[0] && 'language' in seen[0]).toBe(false)
    await app.close()
  })

  it('advice decline payload carries the settings language (ar)', async () => {
    const seen: RespondReq[] = []
    const { app, sessions } = await testApp({
      intel: capturingIntel(seen, () => ({ intent: 'advice', confidence: 0.9, language: 'en' })),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'settings', language: 'ar' })
    await sendTurn(app, session.id, { kind: 'user_text', text: 'should i buy btc?' })
    await waitForJournal(session, (t) => t.includes('advice_decline'))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.intent).toBe('advice')
    expect(seen[0]?.language).toBe('ar')
    await app.close()
  })

  it('refresh re-run payload carries the settings language', async () => {
    const seen: RespondReq[] = []
    const { app, sessions } = await testApp({ intel: capturingIntel(seen) })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'settings', language: 'hinglish' })
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is sol down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const first = frameOfType<{ id: string }>(session, 'research_brief')

    expect(await sendTurn(app, session.id, { kind: 'chip_tap', text: `refresh:${first.id}` })).toBe(
      200,
    )
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 2)
    // The first turn streams; only the refresh goes through blocking respond().
    expect(seen).toHaveLength(1)
    expect(seen[0]?.language).toBe('hinglish')
    await app.close()
  })
})
