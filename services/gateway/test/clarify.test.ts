/**
 * Confidence-aware clarification: the gateway asking instead of guessing.
 *
 * The contract under test, end to end:
 *   under-threshold COSTLY intent → a clarification frame and NOTHING executed
 *   the trader's pick             → the chosen reading runs the real path
 *   unknown / expired / duplicate → an honest frame, never a silent no-op
 *   cheap intents                 → never clarified, byte-identical behaviour
 *   an optionId we never offered  → refused, nothing executed
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildClarification,
  CLARIFICATION_TTL_MS,
  CLARIFICATIONS_CAP,
  CLARIFY_CONFIDENCE,
  type OpenClarification,
  rememberClarification,
  takeChoice,
} from '../src/orchestrator/clarify.js'
import type { IntentResult } from '../src/orchestrator/intelligence.js'
import type { Session, SessionStore } from '../src/plugins/auth.js'
import { InMemorySessionStore } from '../src/plugins/auth.js'
import {
  createSession,
  deadIntel,
  frameOfType,
  sendTurn,
  stubIntel,
  stubSeam,
  type TestGateway,
  testApp,
  waitForJournal,
} from './helpers.js'

type ClarificationFrame = {
  clarificationId: string
  question: string
  options: Array<{ id: string; label: string; hint?: string }>
  originalText?: string
  note?: string
}

let gw: TestGateway
let sessions: SessionStore
afterEach(async () => {
  await gw?.app.close()
})

/** Boot with a stub classifier that returns exactly this classification. */
async function bootWith(result: IntentResult, seam = stubSeam()) {
  sessions = new InMemorySessionStore()
  gw = await testApp({ intel: stubIntel({ intent: () => result }), seam, sessions })
  const session = await createSession(gw.app, sessions)
  return { session, seam }
}

const ctx = { symbol: 'BTC/USDT', venueName: 'Assetworks' }

// ── the policy (pure) ──────────────────────────────────────────────────────

describe('clarification policy — threshold boundaries', () => {
  const action = (confidence: number): IntentResult => ({
    intent: 'action',
    confidence,
    language: 'en',
  })

  it('clarifies just below the threshold', () => {
    expect(buildClarification(action(CLARIFY_CONFIDENCE - 0.01), ctx)).not.toBeNull()
  })

  it('does NOT clarify exactly at the threshold', () => {
    expect(buildClarification(action(CLARIFY_CONFIDENCE), ctx)).toBeNull()
  })

  it('does NOT clarify above the threshold (every fast-path hit is 0.92+)', () => {
    for (const c of [0.92, 0.93, 0.95, 0.97]) {
      expect(buildClarification(action(c), ctx)).toBeNull()
    }
  })

  it('clarifies every rule_classify confidence (0.6–0.8)', () => {
    for (const c of [0.6, 0.65, 0.7, 0.8]) {
      expect(buildClarification(action(c), ctx)).not.toBeNull()
    }
  })
})

describe('clarification policy — costly vs cheap intents', () => {
  it('clarifies the three costly intents', () => {
    for (const intent of ['action', 'alert', 'host_action'] as const) {
      const plan = buildClarification({ intent, confidence: 0.6, language: 'en' }, ctx)
      expect(plan, intent).not.toBeNull()
    }
  })

  it('NEVER clarifies a cheap intent — being wrong there costs a re-ask', () => {
    for (const intent of [
      'research',
      'concept',
      'smalltalk',
      'portfolio',
      'orders_query',
    ] as const) {
      const plan = buildClarification({ intent, confidence: 0.5, language: 'en' }, ctx)
      expect(plan, intent).toBeNull()
    }
  })
})

describe('clarification options', () => {
  it('offers the risky reading plus a safe alternative, 2..4 of them', () => {
    const plan = buildClarification(
      {
        intent: 'action',
        confidence: 0.65,
        language: 'en',
        order: {
          side: 'sell',
          size: '',
          instrument: 'BTC/USDT',
          orderType: 'market',
          action: 'close',
        },
        alternatives: ['orders_query'],
      },
      ctx,
    )
    expect(plan).not.toBeNull()
    if (!plan) return
    expect(plan.options.length).toBeGreaterThanOrEqual(2)
    expect(plan.options.length).toBeLessThanOrEqual(4)
    expect(plan.options[0]?.label).toBe('Close your BTC position (market)')
    expect(plan.options[1]?.label).toBe('Show me my orders first')
    // Every option has a resolution, and the escape is a CHEAP intent.
    for (const o of plan.options) expect(plan.resolutions[o.id]).toBeDefined()
    expect(plan.resolutions[plan.options[1]?.id ?? '']?.intent).toBe('orders_query')
  })

  it('always lands a safe escape even when the classifier names no alternative', () => {
    const plan = buildClarification({ intent: 'action', confidence: 0.7, language: 'en' }, ctx)
    expect(plan?.options.length).toBe(2)
    const safeOption = plan?.options[1]?.id ?? ''
    expect(plan?.resolutions[safeOption]?.intent).toBe('portfolio')
  })

  it('ignores an alternative that is not a cheap reading it can render', () => {
    const plan = buildClarification(
      {
        intent: 'action',
        confidence: 0.7,
        language: 'en',
        // Untrusted wire data: a costly or unknown "alternative" is dropped.
        alternatives: ['action', 'nonsense' as unknown as 'research'],
      },
      ctx,
    )
    expect(plan?.options.length).toBe(2)
    expect(plan?.resolutions[plan.options[1]?.id ?? '']?.intent).toBe('portfolio')
  })

  it('pins every resolution to confidence 1 so a pick can never re-clarify', () => {
    const plan = buildClarification({ intent: 'alert', confidence: 0.6, language: 'en' }, ctx)
    for (const r of Object.values(plan?.resolutions ?? {})) expect(r.confidence).toBe(1)
  })
})

// ── the store (pure) ───────────────────────────────────────────────────────

describe('open-clarification store', () => {
  const entry = (expiresAt: number): OpenClarification => ({
    options: [{ id: 'a', label: 'A' }],
    resolutions: { a: { intent: 'portfolio', confidence: 1, language: 'en' } },
    text: 'close btc',
    expiresAt,
  })

  it('is bounded — the oldest question is evicted', () => {
    const store = new Map<string, OpenClarification>()
    const now = Date.now()
    for (let i = 0; i < CLARIFICATIONS_CAP + 3; i++) {
      rememberClarification(store, `c_${i}`, entry(now + CLARIFICATION_TTL_MS), now)
    }
    expect(store.size).toBe(CLARIFICATIONS_CAP)
    expect(store.has('c_0')).toBe(false)
  })

  it('accepts an offered option once and refuses the duplicate', () => {
    const store = new Map<string, OpenClarification>()
    const now = Date.now()
    rememberClarification(store, 'c_1', entry(now + CLARIFICATION_TTL_MS), now)
    expect(takeChoice(store, 'c_1', 'a', now).ok).toBe(true)
    const again = takeChoice(store, 'c_1', 'a', now)
    expect(again).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses an optionId that was never offered — without consuming the card', () => {
    const store = new Map<string, OpenClarification>()
    const now = Date.now()
    rememberClarification(store, 'c_1', entry(now + CLARIFICATION_TTL_MS), now)
    expect(takeChoice(store, 'c_1', 'not_offered', now)).toEqual({
      ok: false,
      reason: 'not_offered',
    })
    // Still answerable with a real option.
    expect(takeChoice(store, 'c_1', 'a', now).ok).toBe(true)
  })

  it('refuses a pick past the TTL', () => {
    const store = new Map<string, OpenClarification>()
    const now = Date.now()
    rememberClarification(store, 'c_1', entry(now + CLARIFICATION_TTL_MS), now)
    const outcome = takeChoice(store, 'c_1', 'a', now + CLARIFICATION_TTL_MS + 1)
    expect(outcome).toEqual({ ok: false, reason: 'expired' })
    expect(store.size).toBe(0)
  })

  it('refuses an unknown clarificationId', () => {
    expect(takeChoice(new Map(), 'nope', 'a')).toEqual({ ok: false, reason: 'unknown' })
  })
})

// ── the turn (end to end) ──────────────────────────────────────────────────

describe('under-threshold costly turn', () => {
  it('emits a clarification and executes NOTHING', async () => {
    const { session, seam } = await bootWith({
      intent: 'action',
      confidence: 0.65,
      language: 'en',
      order: {
        side: 'sell',
        size: '',
        instrument: 'BTC/USDT',
        orderType: 'market',
        action: 'close',
      },
      alternatives: ['orders_query'],
    })
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'close btc' })
    await waitForJournal(session, (t) => t.includes('clarification'))

    const types = session.journal.after(0).map((e) => e.frame.type)
    // No ticket, no draft, no skeleton — and no "UNDERSTOOD" card claiming we
    // understood the very thing we are asking about.
    expect(types).not.toContain('order_ticket')
    expect(types).not.toContain('order_draft')
    expect(types).not.toContain('interpretation')
    expect(seam.prepares).toEqual([])
    expect(seam.confirms).toEqual([])

    const frame = frameOfType<ClarificationFrame>(session, 'clarification')
    expect(frame.options.length).toBeGreaterThanOrEqual(2)
    expect(frame.originalText).toBe('close btc')
    expect(frame.note).toContain('Assetworks')
  })

  it('does NOT clarify a cheap intent at the same confidence', async () => {
    const { session } = await bootWith({ intent: 'research', confidence: 0.6, language: 'en' })
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'why is btc down' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(session.journal.after(0).map((e) => e.frame.type)).not.toContain('clarification')
  })

  it('does NOT clarify in degraded mode — a deterministic parse is not a guess', async () => {
    sessions = new InMemorySessionStore()
    gw = await testApp({ intel: deadIntel, seam: stubSeam(), sessions })
    const session = await createSession(gw.app, sessions)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    expect(session.journal.after(0).map((e) => e.frame.type)).not.toContain('clarification')
  })
})

describe('clarification_choice', () => {
  async function ask(): Promise<{
    session: Session
    frame: ClarificationFrame
    seam: ReturnType<typeof stubSeam>
  }> {
    const { session, seam } = await bootWith({
      intent: 'action',
      confidence: 0.65,
      language: 'en',
      order: {
        side: 'sell',
        size: '',
        instrument: 'BTC/USDT',
        orderType: 'market',
        action: 'close',
      },
      alternatives: ['orders_query'],
    })
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'close btc' })
    await waitForJournal(session, (t) => t.includes('clarification'))
    return { session, frame: frameOfType<ClarificationFrame>(session, 'clarification'), seam }
  }

  it('the risky option re-runs the turn and DOES execute', async () => {
    const { session, frame, seam } = await ask()
    const risky = frame.options[0]
    expect(risky).toBeDefined()
    expect(
      await sendTurn(gw.app, session.id, {
        kind: 'clarification_choice',
        clarificationId: frame.clarificationId,
        optionId: risky?.id ?? '',
      }),
    ).toBe(200)
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    // The existing close/reduce path ran — no duplicated order logic.
    expect(seam.prepares.length).toBe(1)
    // The chosen option reads back in-thread, so the transcript shows it.
    expect(frameOfType<{ summary: string }>(session, 'interpretation').summary).toBe(risky?.label)
  })

  it('the safe option re-runs as the cheap reading and places nothing', async () => {
    const { session, frame, seam } = await ask()
    const safe = frame.options[1]
    await sendTurn(gw.app, session.id, {
      kind: 'clarification_choice',
      clarificationId: frame.clarificationId,
      optionId: safe?.id ?? '',
    })
    await waitForJournal(session, (t) => t.includes('orders_summary'))
    expect(seam.prepares).toEqual([])
  })

  it('a duplicate pick is refused honestly — the order is never placed twice', async () => {
    const { session, frame, seam } = await ask()
    const risky = frame.options[0]
    const choice = {
      kind: 'clarification_choice',
      clarificationId: frame.clarificationId,
      optionId: risky?.id ?? '',
    }
    await sendTurn(gw.app, session.id, choice)
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    await sendTurn(gw.app, session.id, choice)
    await waitForJournal(session, (t) => t.includes('banner'))
    expect(seam.prepares.length).toBe(1)
    expect(frameOfType<{ title: string }>(session, 'banner').title).toBe('That question is closed')
  })

  it('an optionId we never offered is rejected — nothing executes', async () => {
    const { session, frame, seam } = await ask()
    await sendTurn(gw.app, session.id, {
      kind: 'clarification_choice',
      clarificationId: frame.clarificationId,
      optionId: 'place_it_anyway',
    })
    await waitForJournal(session, (t) => t.includes('banner'))
    expect(seam.prepares).toEqual([])
    expect(frameOfType<{ title: string }>(session, 'banner').title).toBe(
      'That was not one of the choices',
    )
  })

  it('an unknown clarificationId gets an honest reply, never a crash', async () => {
    const { session, seam } = await ask()
    await sendTurn(gw.app, session.id, {
      kind: 'clarification_choice',
      clarificationId: 'c_neverexisted',
      optionId: 'as_asked',
    })
    await waitForJournal(session, (t) => t.includes('banner'))
    expect(seam.prepares).toEqual([])
  })

  it('an expired pick never fires the order it would have placed', async () => {
    const { session, frame, seam } = await ask()
    // Age the open clarification past its window (the real clock would take
    // two minutes; the store is the thing under test).
    const open = session.clarifications?.get(frame.clarificationId)
    expect(open).toBeDefined()
    if (open) open.expiresAt = Date.now() - 1
    await sendTurn(gw.app, session.id, {
      kind: 'clarification_choice',
      clarificationId: frame.clarificationId,
      optionId: frame.options[0]?.id ?? '',
    })
    await waitForJournal(session, (t) => t.includes('banner'))
    expect(seam.prepares).toEqual([])
    expect(frameOfType<{ title: string }>(session, 'banner').title).toBe('That question timed out')
  })
})
