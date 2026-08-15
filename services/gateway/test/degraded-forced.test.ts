/**
 * Operator-forced degraded mode (SLA demo — PRD gate 5, /internal/degraded).
 *
 * The claim under test is the SLA clause itself, on demand: with the flag ON
 * the partner's turns take the EXACT degraded path a real intelligence outage
 * takes (amber banner + labeled market-data-only research) while intent and
 * the order flow stay fully responsive — and the intelligence service is
 * NEVER touched, so flipping the flag OFF restores live behaviour on the very
 * next turn with no restart.
 */
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { IntelligenceClient } from '../src/orchestrator/intelligence.js'
import {
  briefFixture,
  createSession,
  frameOfType,
  sendTurn,
  stubIntel,
  submitDraft,
  TEST_INTERNAL_TOKEN,
  testApp,
  waitForJournal,
} from './helpers.js'

/** The seeded dev partner every test session mints under (pk_demo). */
const PARTNER_ID = 'koinbx-dev'

/** A LIVE intelligence stub that counts calls — proof the forced path never
 * consults the service (the whole point: degraded WITHOUT an outage). */
function countingIntel(): { intel: IntelligenceClient; calls: () => number } {
  let n = 0
  const inner = stubIntel({})
  return {
    calls: () => n,
    intel: {
      intent: (req) => {
        n += 1
        return inner.intent(req)
      },
      respond: (req) => {
        n += 1
        return inner.respond(req)
      },
      respondStream: (req) => {
        n += 1
        return inner.respondStream(req)
      },
      extractMemory: (req) => inner.extractMemory(req),
    },
  }
}

async function setForced(app: FastifyInstance, partnerId: string, forced: boolean) {
  return app.inject({
    method: 'POST',
    url: '/internal/degraded',
    headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
    payload: { partnerId, forced },
  })
}

describe('forced degraded mode: /internal/degraded', () => {
  it('is operator-scoped: no token → 401/503, never partner-reachable', async () => {
    const { app } = await testApp()
    const bare = await app.inject({
      method: 'POST',
      url: '/internal/degraded',
      payload: { partnerId: PARTNER_ID, forced: true },
    })
    expect(bare.statusCode).toBe(401)
    const badToken = await app.inject({
      method: 'POST',
      url: '/internal/degraded',
      headers: { 'x-hippo-internal-token': 'wrong' },
      payload: { partnerId: PARTNER_ID, forced: true },
    })
    expect(badToken.statusCode).toBe(401)
    await app.close()
  })

  it('validates the payload (partnerId + boolean forced) and lists forced partners', async () => {
    const { app } = await testApp()
    const noPartner = await setForced(app, '', true)
    expect(noPartner.statusCode).toBe(400)
    const badForced = await app.inject({
      method: 'POST',
      url: '/internal/degraded',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
      payload: { partnerId: PARTNER_ID, forced: 'yes' },
    })
    expect(badForced.statusCode).toBe(400)

    expect((await setForced(app, PARTNER_ID, true)).statusCode).toBe(200)
    const list = await app.inject({
      method: 'GET',
      url: '/internal/degraded',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
    })
    expect(list.json()).toEqual({ forced: [PARTNER_ID] })
    expect((await setForced(app, PARTNER_ID, false)).statusCode).toBe(200)
    const cleared = await app.inject({
      method: 'GET',
      url: '/internal/degraded',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
    })
    expect(cleared.json()).toEqual({ forced: [] })
    await app.close()
  })

  it('ON → banner + labeled market-only brief, service untouched; OFF → live again, no restart', async () => {
    const counting = countingIntel()
    const { app, sessions, telemetry } = await testApp({ intel: counting.intel })
    const session = await createSession(app, sessions)

    await setForced(app, PARTNER_ID, true)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    let types = await waitForJournal(session, (t) => t.includes('research_brief'))
    // The exact degraded artifacts a real outage produces: the amber banner…
    expect(types).toContain('banner')
    const banner = frameOfType<{ kind: string; title: string }>(session, 'banner')
    expect(banner.kind).toBe('degraded')
    expect(banner.title).toBe('HIGH MARKET LOAD')
    // …and the deterministic market-data-only brief, LABELED as such: price
    // feed provenance, honest "research is paused" prose, no model tag (the
    // live path would have carried briefFixture's sources + model).
    const brief = frameOfType<{ sources: string[]; paragraphs: string[]; model?: string }>(
      session,
      'research_brief',
    )
    expect(brief.sources).toEqual(['PRICE FEED'])
    expect(brief.paragraphs[0]).toContain('Fresh research is briefly paused')
    expect(brief.model).toBeUndefined()
    // Forced ≠ outage: the (perfectly healthy) intelligence service was never
    // consulted — no intent, no respond, no stream.
    expect(counting.calls()).toBe(0)
    // The operator surface shows the same degraded clock a real episode would.
    const metrics = telemetry.snapshot() as { degraded: { active: boolean } }
    expect(metrics.degraded.active).toBe(true)

    // OFF: the very next turn is live — model brief, intelligence consulted.
    await setForced(app, PARTNER_ID, false)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'and eth?' })
    types = await waitForJournal(
      session,
      (t) => t.filter((x) => x === 'research_brief').length >= 2,
    )
    const briefs = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'research_brief')
      .map((e) => e.frame as unknown as { sources: string[]; model?: string })
    expect(briefs[1]?.sources).toEqual(briefFixture.sources)
    expect(briefs[1]?.model).toBe(briefFixture.model)
    expect(counting.calls()).toBeGreaterThan(0)
    await app.close()
  })

  it('while forced, intent + order flow stay responsive — the SLA claim itself', async () => {
    const counting = countingIntel()
    const { app, sessions } = await testApp({ intel: counting.intel })
    const session = await createSession(app, sessions)
    await setForced(app, PARTNER_ID, true)

    // The deterministic parser classifies the order and the FULL interactive
    // flow runs — draft → submit → prepared ticket — all venue-side surfaces,
    // none of which ever needed the intelligence service.
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    const { ticket } = await submitDraft(app, session)
    expect(ticket.ticketId).toBeTruthy()
    const t = frameOfType<{ sideLabel: string }>(session, 'order_ticket')
    expect(t.sideLabel).toBe('BUY · MKT')

    // Portfolio stays live too.
    await sendTurn(app, session.id, { kind: 'user_text', text: 'my positions' })
    await waitForJournal(session, (t2) => t2.includes('positions'))

    expect(counting.calls()).toBe(0)
    await app.close()
  })

  it('a REFRESH tap while forced takes the degraded fallback, not a live model call', async () => {
    const counting = countingIntel()
    const { app, sessions } = await testApp({ intel: counting.intel })
    const session = await createSession(app, sessions)

    // Live brief first (flag off), so there is a card to refresh.
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const liveBrief = frameOfType<{ id: string }>(session, 'research_brief')
    const callsBeforeForce = counting.calls()

    await setForced(app, PARTNER_ID, true)
    await sendTurn(app, session.id, { kind: 'chip_tap', text: `refresh:${liveBrief.id}` })
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 2)
    const refreshed = session.journal
      .after(0)
      .map((e) => e.frame as unknown as { type: string; sources?: string[]; replaces?: string })
      .filter((f) => f.type === 'research_brief')[1]
    // In-place replacement, but the degraded market-only brief — labeled.
    expect(refreshed?.replaces).toBe(liveBrief.id)
    expect(refreshed?.sources).toEqual(['PRICE FEED'])
    expect(counting.calls()).toBe(callsBeforeForce)
    await app.close()
  })

  it('is partner-scoped: forcing another partner leaves this one live', async () => {
    const counting = countingIntel()
    const { app, sessions } = await testApp({ intel: counting.intel })
    const session = await createSession(app, sessions)
    await setForced(app, 'someone-else', true)

    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    const types = await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(types).not.toContain('banner')
    const brief = frameOfType<{ sources: string[] }>(session, 'research_brief')
    expect(brief.sources).toEqual(briefFixture.sources)
    expect(counting.calls()).toBeGreaterThan(0)
    await app.close()
  })

  it('banner re-arms across forced episodes separated by a live turn', async () => {
    const { app, sessions } = await testApp()
    const session = await createSession(app, sessions)

    await setForced(app, PARTNER_ID, true)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    // Second degraded turn: still one banner (once per episode).
    await sendTurn(app, session.id, { kind: 'user_text', text: 'and eth?' })
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 2)
    expect(session.journal.after(0).filter((e) => e.frame.type === 'banner')).toHaveLength(1)

    // Recover (live turn resets the episode), then force again → new banner.
    await setForced(app, PARTNER_ID, false)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'sol volume?' })
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 3)
    await setForced(app, PARTNER_ID, true)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'btc again?' })
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 4)
    expect(session.journal.after(0).filter((e) => e.frame.type === 'banner')).toHaveLength(2)
    await app.close()
  })
})
