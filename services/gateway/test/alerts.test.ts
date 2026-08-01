/**
 * Price alerts: conversational arm (incl. 'cross' resolution against the live
 * price), the poll-loop trigger semantics (above/below, no double-trigger),
 * cancel idempotency + ownership, the armed cap, and the feature's soul —
 * cross-session delivery: a trigger with no live session is swept in on the
 * trader's next session start.
 */

import { type Alert, InMemoryAlertStore, MAX_ARMED_ALERTS_PER_USER } from '@hippo/stores'
import { describe, expect, it } from 'vitest'
import type { IntentResult } from '../src/orchestrator/intelligence.js'
import type { Session } from '../src/plugins/auth.js'
import {
  createSession,
  frameOfType,
  sendTurn,
  stubIntel,
  testApp,
  waitForJournal,
} from './helpers.js'

/** Intent stub that classifies EVERY turn as the given alert intent. */
const alertIntel = (alertIntent: NonNullable<IntentResult['alertIntent']>) =>
  stubIntel({
    intent: () => ({ intent: 'alert', confidence: 0.95, language: 'en', alertIntent }),
  })

/** An armed alert row owned by the given session's effective user. */
const armedAlert = (session: Session, extra: Partial<Alert> = {}): Alert => ({
  id: `al_${Math.random().toString(36).slice(2, 10)}`,
  partnerId: session.partner.partnerId,
  userKey: session.venueUserId ?? session.id,
  symbol: 'BTC/USDT',
  condition: 'above',
  price: 70_000,
  state: 'armed',
  createdAt: Date.now(),
  delivered: false,
  ...extra,
})

/** Mark the session "connected" the way streamSession does (live writer set). */
const goLive = (session: Session) => {
  session.live = () => {}
}

const alertFrames = (session: Session) =>
  session.journal
    .after(0)
    .map((e) => e.frame)
    .filter((f) => f.type === 'alert') as Array<{
    alertId: string
    state: string
    conditionLabel: string
    symbol: string
    note?: string
  }>

describe('conversational arm', () => {
  it('creates an armed alert and emits the armed frame with a server-authored label', async () => {
    const { app, sessions, alertStore } = await testApp({
      intel: alertIntel({
        action: 'create',
        symbol: 'BTC/USDT',
        direction: 'above',
        price: 70_000,
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'alert me when btc goes above 70k' })
    await waitForJournal(session, (t) => t.includes('alert'))

    const frame = frameOfType<{ state: string; conditionLabel: string; symbol: string }>(
      session,
      'alert',
    )
    expect(frame.state).toBe('armed')
    expect(frame.symbol).toBe('BTC/USDT')
    expect(frame.conditionLabel).toBe('BTC/USDT ABOVE 70,000')

    const stored = await alertStore.listByUser(session.partner.partnerId, session.id)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.condition).toBe('above')
    expect(stored[0]?.state).toBe('armed')
    await app.close()
  })

  it("resolves 'cross' against the live price: target above current → above", async () => {
    // snapshotFixture.last = 61,240 — a 70k cross watches upward.
    const { app, sessions, alertStore } = await testApp({
      intel: alertIntel({
        action: 'create',
        symbol: 'BTC/USDT',
        direction: 'cross',
        price: 70_000,
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'alert me when btc crosses 70k' })
    await waitForJournal(session, (t) => t.includes('alert'))
    expect((await alertStore.listByUser(session.partner.partnerId, session.id))[0]?.condition).toBe(
      'above',
    )
    await app.close()
  })

  it("resolves 'cross' against the live price: target below current → below", async () => {
    const { app, sessions, alertStore } = await testApp({
      intel: alertIntel({
        action: 'create',
        symbol: 'BTC/USDT',
        direction: 'cross',
        price: 50_000,
      }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'alert me when btc crosses 50k' })
    await waitForJournal(session, (t) => t.includes('alert'))
    expect((await alertStore.listByUser(session.partner.partnerId, session.id))[0]?.condition).toBe(
      'below',
    )
    await app.close()
  })

  it(`enforces the ${MAX_ARMED_ALERTS_PER_USER}-armed cap with an honest decline`, async () => {
    const alertStore = new InMemoryAlertStore()
    const { app, sessions } = await testApp({
      alertStore,
      intel: alertIntel({
        action: 'create',
        symbol: 'BTC/USDT',
        direction: 'above',
        price: 70_000,
      }),
    })
    const session = await createSession(app, sessions)
    for (let i = 0; i < MAX_ARMED_ALERTS_PER_USER; i++) {
      await alertStore.create(armedAlert(session, { id: `al_pre${i}` }))
    }
    await sendTurn(app, session.id, { kind: 'user_text', text: 'alert me when btc goes above 70k' })
    const types = await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(types).not.toContain('alert') // nothing was armed
    expect(await alertStore.listByUser(session.partner.partnerId, session.id)).toHaveLength(
      MAX_ARMED_ALERTS_PER_USER,
    )
    await app.close()
  })
})

describe('poll-loop trigger', () => {
  it('triggers ABOVE when last ≥ target and delivers to the live session', async () => {
    const alertStore = new InMemoryAlertStore()
    const { app, sessions, alerts } = await testApp({ alertStore })
    const session = await createSession(app, sessions)
    goLive(session)
    // Fixture last = 61,240 ≥ 61,000 → crossed.
    const alert = armedAlert(session, { condition: 'above', price: 61_000 })
    await alertStore.create(alert)

    await alerts.tick()

    const frames = alertFrames(session)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.state).toBe('triggered')
    expect(frames[0]?.conditionLabel).toBe('BTC/USDT ABOVE 61,000')
    expect(frames[0]?.note).toContain('61,240') // the observed price, honest
    const [row] = await alertStore.listByUser(session.partner.partnerId, session.id)
    expect(row?.state).toBe('triggered')
    expect(row?.delivered).toBe(true)
    await app.close()
  })

  it('triggers BELOW when last ≤ target; an uncrossed alert stays armed', async () => {
    const alertStore = new InMemoryAlertStore()
    const { app, sessions, alerts } = await testApp({ alertStore })
    const session = await createSession(app, sessions)
    goLive(session)
    await alertStore.create(
      armedAlert(session, { id: 'al_below', condition: 'below', price: 62_000 }),
    )
    await alertStore.create(
      armedAlert(session, { id: 'al_far', condition: 'above', price: 70_000 }),
    )

    await alerts.tick()

    const frames = alertFrames(session)
    expect(frames.map((f) => f.alertId)).toEqual(['al_below'])
    const rows = await alertStore.listByUser(session.partner.partnerId, session.id)
    expect(rows.find((a) => a.id === 'al_below')?.state).toBe('triggered')
    expect(rows.find((a) => a.id === 'al_far')?.state).toBe('armed')
    await app.close()
  })

  it('never double-triggers: a second tick emits nothing new', async () => {
    const alertStore = new InMemoryAlertStore()
    const { app, sessions, alerts } = await testApp({ alertStore })
    const session = await createSession(app, sessions)
    goLive(session)
    await alertStore.create(armedAlert(session, { condition: 'above', price: 61_000 }))

    await alerts.tick()
    await alerts.tick()

    expect(alertFrames(session)).toHaveLength(1)
    await app.close()
  })

  it('skips the beat when market-data is down — no fake trigger', async () => {
    const alertStore = new InMemoryAlertStore()
    const { app, sessions, alerts } = await testApp({
      alertStore,
      market: {
        snapshot: async () => {
          throw new Error('market-data unreachable')
        },
      },
    })
    const session = await createSession(app, sessions)
    goLive(session)
    await alertStore.create(armedAlert(session, { condition: 'above', price: 1 }))

    await alerts.tick()

    expect(alertFrames(session)).toHaveLength(0)
    expect(await alertStore.listArmed()).toHaveLength(1)
    await app.close()
  })
})

describe('cross-session delivery — the trader who closed the tab', () => {
  it('leaves delivered=false with no live session, then sweeps on session start', async () => {
    const alertStore = new InMemoryAlertStore()
    const { app, sessions, alerts } = await testApp({ alertStore })
    const session = await createSession(app, sessions)
    // NOT live: the trader closed the tab. Trigger fires into the void.
    await alertStore.create(
      armedAlert(session, { id: 'al_away', condition: 'above', price: 61_000 }),
    )
    await alerts.tick()

    expect(alertFrames(session)).toHaveLength(0) // nothing was emitted anywhere
    let [row] = await alertStore.listByUser(session.partner.partnerId, session.id)
    expect(row?.state).toBe('triggered')
    expect(row?.delivered).toBe(false)

    // SESSION START: connect the stream (real socket, like an SDK reconnect).
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const ctrl = new AbortController()
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/stream?session=${session.id}`, {
      headers: { accept: 'text/event-stream' },
      signal: ctrl.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body stream')
    const decoder = new TextDecoder()
    let buffer = ''
    while (!buffer.includes('"alert"')) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    ctrl.abort()

    const frames = [...buffer.matchAll(/^data: (.+)$/gm)]
      .map((m) => JSON.parse(m[1] as string))
      .filter((f) => f.type === 'alert')
    expect(frames).toHaveLength(1)
    expect(frames[0].alertId).toBe('al_away')
    expect(frames[0].state).toBe('triggered')
    expect(frames[0].note).toBe('Triggered while you were away')
    ;[row] = await alertStore.listByUser(session.partner.partnerId, session.id)
    expect(row?.delivered).toBe(true)
    await app.close()
  })
})

describe('cancel', () => {
  it('alert_action cancel flips armed→cancelled and is idempotent on replay', async () => {
    const alertStore = new InMemoryAlertStore()
    const { app, sessions } = await testApp({ alertStore })
    const session = await createSession(app, sessions)
    const alert = armedAlert(session, { id: 'al_c1' })
    await alertStore.create(alert)

    expect(
      await sendTurn(app, session.id, { kind: 'alert_action', alertId: 'al_c1', action: 'cancel' }),
    ).toBe(200)
    await waitForJournal(session, (t) => t.includes('alert'))
    expect(alertFrames(session).map((f) => f.state)).toEqual(['cancelled'])

    // Replay: a non-armed alert is a no-op ack — no crash, no second frame.
    expect(
      await sendTurn(app, session.id, { kind: 'alert_action', alertId: 'al_c1', action: 'cancel' }),
    ).toBe(200)
    expect(
      await sendTurn(app, session.id, { kind: 'alert_action', alertId: 'ghost', action: 'cancel' }),
    ).toBe(200)
    await new Promise((r) => setTimeout(r, 25))
    expect(alertFrames(session)).toHaveLength(1)
    await app.close()
  })

  it("never cancels another user's alert", async () => {
    const alertStore = new InMemoryAlertStore()
    const { app, sessions } = await testApp({ alertStore })
    const mine = await createSession(app, sessions)
    const theirs = await createSession(app, sessions)
    await alertStore.create(armedAlert(theirs, { id: 'al_theirs' }))

    await sendTurn(app, mine.id, { kind: 'alert_action', alertId: 'al_theirs', action: 'cancel' })
    await new Promise((r) => setTimeout(r, 25))

    expect(alertFrames(mine)).toHaveLength(0)
    expect((await alertStore.listArmed()).map((a) => a.id)).toEqual(['al_theirs'])
    await app.close()
  })

  it('conversational cancel with exactly one match cancels it', async () => {
    const alertStore = new InMemoryAlertStore()
    const { app, sessions } = await testApp({
      alertStore,
      intel: alertIntel({ action: 'cancel', symbol: 'BTC/USDT' }),
    })
    const session = await createSession(app, sessions)
    await alertStore.create(armedAlert(session, { id: 'al_only' }))
    await alertStore.create(armedAlert(session, { id: 'al_eth', symbol: 'ETH/USDT' }))

    await sendTurn(app, session.id, { kind: 'user_text', text: 'cancel my btc alert' })
    await waitForJournal(session, (t) => t.includes('alert'))

    const frames = alertFrames(session)
    expect(frames.map((f) => [f.alertId, f.state])).toEqual([['al_only', 'cancelled']])
    const rows = await alertStore.listByUser(session.partner.partnerId, session.id)
    expect(rows.find((a) => a.id === 'al_eth')?.state).toBe('armed')
    await app.close()
  })

  it('conversational cancel with several matches lists them instead of guessing', async () => {
    const alertStore = new InMemoryAlertStore()
    const { app, sessions } = await testApp({
      alertStore,
      intel: alertIntel({ action: 'cancel', symbol: 'BTC/USDT' }),
    })
    const session = await createSession(app, sessions)
    await alertStore.create(armedAlert(session, { id: 'al_a', price: 70_000 }))
    await alertStore.create(armedAlert(session, { id: 'al_b', price: 55_000, condition: 'below' }))

    await sendTurn(app, session.id, { kind: 'user_text', text: 'cancel my btc alert' })
    const types = await waitForJournal(
      session,
      (t) => t.filter((x) => x === 'alert').length === 2 && t.includes('banner'),
    )
    expect(types.filter((x) => x === 'alert')).toHaveLength(2)
    // Every card re-emitted ARMED (each carries its own CANCEL chip); nothing cancelled.
    expect(alertFrames(session).every((f) => f.state === 'armed')).toBe(true)
    expect(await alertStore.listArmed()).toHaveLength(2)
    await app.close()
  })

  it('conversational cancel with no armed alerts answers honestly', async () => {
    const { app, sessions, alertStore } = await testApp({
      intel: alertIntel({ action: 'cancel' }),
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'cancel my alerts' })
    await waitForJournal(session, (t) => t.includes('banner'))
    expect(alertFrames(session)).toHaveLength(0)
    expect(await alertStore.listArmed()).toEqual([])
    await app.close()
  })
})
