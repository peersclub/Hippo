/**
 * Interactive order card (order_draft → draft_action) + session symbol
 * context + the transient live price ticker.
 *
 * The draft flow REPLACES instant-prepare: an action turn emits an editable
 * order_draft (prefilled + venue-bounded); the trader submits edited params
 * via draft_action, the gateway re-validates against capabilities and only
 * then runs the classic prepare → order_ticket path. price_tick frames are
 * transient by contract: delivered to connected SSE clients only, NEVER
 * journaled — a resume replay must contain zero ticks.
 */
import { describe, expect, it } from 'vitest'
import type { IntentResult } from '../src/orchestrator/intelligence.js'
import {
  createSession,
  type DraftFrame,
  frameOfType,
  sendTurn,
  stubIntel,
  stubSeam,
  submitDraft,
  testApp,
  waitForJournal,
} from './helpers.js'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fully-parsed perp order intent (what the intelligence stage-1 extracts). */
const perpIntent = () =>
  stubIntel({
    intent: (): IntentResult => ({
      intent: 'action',
      confidence: 0.9,
      language: 'en',
      order: {
        capability: 'futures_perp',
        side: 'buy',
        direction: 'long',
        leverage: 10,
        marginMode: 'cross',
        size: '0.5',
        instrument: 'ETH/USDT',
        orderType: 'limit',
        limitPrice: '3000',
      },
    }),
  })

/** Action intent where stage-1 could NOT extract an order ("long btc"). */
const bareActionIntent = () =>
  stubIntel({
    intent: (): IntentResult => ({ intent: 'action', confidence: 0.9, language: 'en' }),
  })

/** Close-long perp intent ("close long 0.5 BTC") — sell to reduce. */
const closeIntent = () =>
  stubIntel({
    intent: (): IntentResult => ({
      intent: 'action',
      confidence: 0.9,
      language: 'en',
      order: {
        capability: 'futures_perp',
        side: 'sell',
        direction: 'long',
        leverage: 10,
        size: '0.5',
        instrument: 'BTC/USDT',
        orderType: 'market',
        action: 'close',
        reduceOnly: true,
      },
    }),
  })

/** Reduce-only WITHOUT action:'close' — reduceOnly alone must also bypass. */
const reduceOnlyIntent = () =>
  stubIntel({
    intent: (): IntentResult => ({
      intent: 'action',
      confidence: 0.9,
      language: 'en',
      order: {
        capability: 'futures_perp',
        side: 'sell',
        direction: 'long',
        leverage: 10,
        size: '0.5',
        instrument: 'BTC/USDT',
        orderType: 'market',
        action: 'open',
        reduceOnly: true,
      },
    }),
  })

describe('order_draft: action turns emit an editable draft, not an instant ticket', () => {
  it('fully-parsed perp order → draft with prefill + venue bounds, no order_ticket', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: perpIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth 10x cross at 3000' })
    await waitForJournal(session, (t) => t.includes('order_draft'))

    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    // Prefill from the parsed order…
    expect(draft.capability).toBe('futures_perp')
    expect(draft.side).toBe('buy')
    expect(draft.direction).toBe('long')
    expect(draft.instrument).toBe('ETH/USDT')
    expect(draft.size).toBe('0.5')
    expect(draft.sizeAsset).toBe('ETH')
    expect(draft.orderType).toBe('limit')
    expect(draft.limitPrice).toBe('3000')
    expect(draft.leverage).toBe(10)
    expect(draft.marginMode).toBe('cross')
    // …bounds from the seam's capabilities (stub fixture: 20x, both modes)…
    expect(draft.maxLeverage).toBe(20)
    expect(draft.marginModes).toEqual(['isolated', 'cross'])
    // …and the dropdown lists the draft's instrument first.
    expect(draft.symbols[0]).toBe('ETH/USDT')
    expect(draft.title).toBe('Set up your LONG ETH order')

    // No instant prepare: the seam was not called, no ticket landed.
    await delay(30)
    expect(seam.prepares).toHaveLength(0)
    const types = session.journal.after(0).map((e) => e.frame.type)
    expect(types).not.toContain('order_ticket')
    expect(types).not.toContain('rejection_ticket')
    await app.close()
  })

  it('no parsed order → draft with empty size and the session symbol (no bare rejection)', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: bareActionIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'set up a trade' })
    await waitForJournal(session, (t) => t.includes('order_draft'))

    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    expect(draft.size).toBe('') // trader fills it in
    expect(draft.side).toBe('buy')
    expect(draft.capability).toBe('spot')
    expect(draft.instrument).toBe('BTC/USDT') // no session symbol → default
    const types = session.journal.after(0).map((e) => e.frame.type)
    expect(types).not.toContain('rejection_ticket')
    await app.close()
  })

  it('bare "long btc" opens perp-shaped (direction hint) when the venue supports perps', async () => {
    const { app, sessions } = await testApp({ intel: bareActionIntent() })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long btc' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    expect(draft.capability).toBe('futures_perp')
    expect(draft.direction).toBe('long')
    expect(draft.size).toBe('')
    expect(draft.maxLeverage).toBe(20)
    await app.close()
  })
})

describe('close/reduce-only orders bypass the draft — straight to prepare', () => {
  it('"close long 0.5 BTC" → NO draft; seam receives action:close + reduceOnly → order_ticket', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: closeIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'close long 0.5 btc' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))

    // The close never became an editable card — a draft would resubmit it
    // as an OPEN (drafts are open-only) and double exposure.
    const types = session.journal.after(0).map((e) => e.frame.type)
    expect(types).not.toContain('order_draft')
    expect(session.drafts.size).toBe(0)
    expect(types).not.toContain('rejection_ticket')

    // The seam got the intent VERBATIM: a closing, reduce-only order.
    expect(seam.prepares).toHaveLength(1)
    expect(seam.prepares[0]).toMatchObject({
      capability: 'futures_perp',
      instrument: 'BTC/USDT',
      direction: 'long',
      action: 'close',
      reduceOnly: true,
      size: '0.5',
      orderType: 'market',
    })
    await app.close()
  })

  it('reduceOnly without action:close also bypasses the draft (reduceOnly is a trigger)', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: reduceOnlyIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'reduce my long by 0.5 btc' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))

    const types = session.journal.after(0).map((e) => e.frame.type)
    expect(types).not.toContain('order_draft')
    expect(session.drafts.size).toBe(0)
    expect(seam.prepares).toHaveLength(1)
    expect(seam.prepares[0]).toMatchObject({
      capability: 'futures_perp',
      instrument: 'BTC/USDT',
      action: 'open',
      reduceOnly: true,
    })
    await app.close()
  })
})

describe('draft_action: submit re-validates, then runs the classic prepare flow', () => {
  it('valid edited params → prepare called with the EDITED values → order_ticket', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: perpIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth 10x' })
    // The trader edits: bigger size, more leverage, isolated, market.
    await submitDraft(app, session, {
      size: '1.25',
      leverage: 15,
      marginMode: 'isolated',
      orderType: 'market',
    })
    expect(seam.prepares).toHaveLength(1)
    expect(seam.prepares[0]).toMatchObject({
      capability: 'futures_perp',
      instrument: 'ETH/USDT',
      direction: 'long',
      leverage: 15,
      marginMode: 'isolated',
      size: '1.25',
      orderType: 'market',
    })
    const types = session.journal.after(0).map((e) => e.frame.type)
    expect(types).toContain('order_ticket')
    // The draft is consumed: a second submit of the same id is rejected.
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'submit',
      params: { instrument: 'ETH/USDT', orderType: 'market', size: '1' },
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(seam.prepares).toHaveLength(1)
    await app.close()
  })

  it('leverage over maxLeverage → rejection_ticket, prepare NOT called', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: perpIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'submit',
      params: { instrument: 'ETH/USDT', orderType: 'market', size: '0.5', leverage: 25 },
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    const rejection = frameOfType<{ reason: string }>(session, 'rejection_ticket')
    expect(rejection.reason).toContain('20')
    expect(seam.prepares).toHaveLength(0)
    expect(session.journal.after(0).map((e) => e.frame.type)).not.toContain('order_ticket')
    await app.close()
  })

  it('margin mode outside the venue set → rejection_ticket, prepare NOT called', async () => {
    const seam = stubSeam({
      spot: {},
      futures_perp: { maxLeverage: 20, marginModes: ['isolated'] },
    })
    const { app, sessions } = await testApp({ intel: perpIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'submit',
      params: {
        instrument: 'ETH/USDT',
        orderType: 'market',
        size: '0.5',
        leverage: 5,
        marginMode: 'cross',
      },
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    const rejection = frameOfType<{ reason: string }>(session, 'rejection_ticket')
    expect(rejection.reason).toContain('isolated')
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })

  it('size "0" → rejection_ticket, prepare NOT called', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: perpIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'submit',
      params: { instrument: 'ETH/USDT', orderType: 'market', size: '0', leverage: 5 },
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    const rejection = frameOfType<{ reason: string }>(session, 'rejection_ticket')
    expect(rejection.reason).toContain('positive')
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })

  it('limit order without a positive limit price → rejection_ticket', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: perpIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth limit' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'submit',
      params: { instrument: 'ETH/USDT', orderType: 'limit', size: '0.5', leverage: 5 },
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })

  it('dismiss drops the pending draft — no frame; a later submit is rejected', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: perpIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    const seqBefore = session.journal.lastSeq()

    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'dismiss',
    })
    await delay(30)
    expect(session.journal.lastSeq()).toBe(seqBefore) // dismiss emits nothing
    expect(session.drafts.size).toBe(0)

    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'submit',
      params: { instrument: 'ETH/USDT', orderType: 'market', size: '0.5', leverage: 5 },
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })
})

describe('protective exits (attached stop-loss / take-profit) through the draft flow', () => {
  /** Perp intent that carries protective exits ("long 0.5 eth 10x with stop
   * at 2500 and tp at 4000"). */
  const protectedIntent = () =>
    stubIntel({
      intent: (): IntentResult => ({
        intent: 'action',
        confidence: 0.9,
        language: 'en',
        order: {
          capability: 'futures_perp',
          side: 'buy',
          direction: 'long',
          leverage: 10,
          marginMode: 'cross',
          size: '0.5',
          instrument: 'ETH/USDT',
          orderType: 'market',
          stopLossPrice: '2500',
          takeProfitPrice: '4000',
        },
      }),
    })

  it('intent with stop/tp → the draft frame carries BOTH fields prefilled', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: protectedIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, {
      kind: 'user_text',
      text: 'long 0.5 eth 10x with stop at 2500 and tp at 4000',
    })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    expect(draft.stopLossPrice).toBe('2500')
    expect(draft.takeProfitPrice).toBe('4000')
    await app.close()
  })

  it('venue advertises protectiveExits → fields present (empty) even without parsed values; absent otherwise', async () => {
    // Supported venue: empty-string fields signal "inputs available".
    const { app, sessions } = await testApp({ intel: perpIntent() })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth 10x' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    expect(draft.stopLossPrice).toBe('')
    expect(draft.takeProfitPrice).toBe('')
    await app.close()

    // Venue WITHOUT protectiveExits: the frame must omit the fields entirely
    // (frame presence drives the SDK inputs — the server decides).
    const bareSeam = stubSeam({
      spot: {},
      futures_perp: { maxLeverage: 20, marginModes: ['isolated', 'cross'] },
    })
    const { app: app2, sessions: sessions2 } = await testApp({
      intel: perpIntent(),
      seam: bareSeam,
    })
    const session2 = await createSession(app2, sessions2)
    await sendTurn(app2, session2.id, { kind: 'user_text', text: 'long 0.5 eth 10x' })
    await waitForJournal(session2, (t) => t.includes('order_draft'))
    const draft2 = frameOfType<DraftFrame>(session2, 'order_draft')
    expect(draft2.stopLossPrice).toBeUndefined()
    expect(draft2.takeProfitPrice).toBeUndefined()
    await app2.close()
  })

  it('DESIGN CHOICE: stop/tp asked on a venue without protectiveExits → the ORDER is declined, nothing drops silently', async () => {
    const bareSeam = stubSeam({
      spot: {},
      futures_perp: { maxLeverage: 20, marginModes: ['isolated', 'cross'] },
    })
    const { app, sessions } = await testApp({ intel: protectedIntent(), seam: bareSeam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, {
      kind: 'user_text',
      text: 'long 0.5 eth 10x with stop at 2500 and tp at 4000',
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    const rejection = frameOfType<{ reason: string }>(session, 'rejection_ticket')
    expect(rejection.reason).toMatch(/doesn't support attached stop-loss\/take-profit/i)
    // No draft, no prepare: the protective half was never silently dropped.
    const types = session.journal.after(0).map((e) => e.frame.type)
    expect(types).not.toContain('order_draft')
    expect(bareSeam.prepares).toHaveLength(0)
    await app.close()
  })

  it('submit round-trip: edited stop/tp ride the plan to the seam verbatim', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: protectedIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth with stops' })
    await submitDraft(app, session, { stopLossPrice: '2600', takeProfitPrice: '3900' })
    expect(seam.prepares).toHaveLength(1)
    expect(seam.prepares[0]).toMatchObject({
      capability: 'futures_perp',
      instrument: 'ETH/USDT',
      direction: 'long',
      stopLossPrice: '2600',
      takeProfitPrice: '3900',
    })
    await app.close()
  })

  it('submit with EMPTY stop/tp strings omits them from the plan (blank inputs are not zeros)', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: perpIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth 10x' })
    await submitDraft(app, session, { stopLossPrice: '', takeProfitPrice: ' ' })
    expect(seam.prepares).toHaveLength(1)
    const plan = seam.prepares[0] as Record<string, unknown>
    expect(plan.stopLossPrice).toBeUndefined()
    expect(plan.takeProfitPrice).toBeUndefined()
    await app.close()
  })

  it('tamper rejection: stop above tp on a long → rejection_ticket, seam never called', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: perpIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth 10x' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'submit',
      params: {
        instrument: 'ETH/USDT',
        orderType: 'market',
        size: '0.5',
        leverage: 10,
        stopLossPrice: '4000',
        takeProfitPrice: '2500',
      },
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    const rejection = frameOfType<{ reason: string }>(session, 'rejection_ticket')
    expect(rejection.reason).toMatch(/stop-loss must be below the take-profit/i)
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })

  it('tamper rejection: non-numeric / non-positive protective prices → rejection_ticket', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: perpIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth 10x' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'submit',
      params: {
        instrument: 'ETH/USDT',
        orderType: 'market',
        size: '0.5',
        leverage: 10,
        stopLossPrice: '-2500',
      },
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    const rejection = frameOfType<{ reason: string }>(session, 'rejection_ticket')
    expect(rejection.reason).toMatch(/positive price/i)
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })

  it('tamper rejection: stop/tp injected against a venue without protectiveExits → rejected server-side', async () => {
    // The frame never offered the inputs (no fields), but a tampered client
    // sends them anyway — the gateway re-validates against capabilities.
    const bareSeam = stubSeam({
      spot: {},
      futures_perp: { maxLeverage: 20, marginModes: ['isolated', 'cross'] },
    })
    const { app, sessions } = await testApp({ intel: perpIntent(), seam: bareSeam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth 10x' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'submit',
      params: {
        instrument: 'ETH/USDT',
        orderType: 'market',
        size: '0.5',
        leverage: 10,
        stopLossPrice: '2500',
      },
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    const rejection = frameOfType<{ reason: string }>(session, 'rejection_ticket')
    expect(rejection.reason).toMatch(/doesn't support attached stop-loss\/take-profit/i)
    expect(bareSeam.prepares).toHaveLength(0)
    await app.close()
  })

  it('limit entry sanity: a stop that would trigger immediately against the limit price is rejected', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: perpIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 eth 10x at 3000' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'submit',
      params: {
        instrument: 'ETH/USDT',
        orderType: 'limit',
        limitPrice: '3000',
        size: '0.5',
        leverage: 10,
        stopLossPrice: '3200', // above a long's limit entry
      },
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    const rejection = frameOfType<{ reason: string }>(session, 'rejection_ticket')
    expect(rejection.reason).toMatch(/would trigger immediately/i)
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })

  it('spot order with stop/tp routes through the capability plan path (fields intact)', async () => {
    const spotProtected = stubIntel({
      intent: (): IntentResult => ({
        intent: 'action',
        confidence: 0.9,
        language: 'en',
        order: {
          side: 'buy',
          size: '0.1',
          instrument: 'BTC/USDT',
          orderType: 'market',
          stopLossPrice: '55000',
          takeProfitPrice: '70000',
        },
      }),
    })
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: spotProtected, seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, {
      kind: 'user_text',
      text: 'buy 0.1 btc with stop at 55k and tp at 70k',
    })
    await submitDraft(app, session, {})
    expect(seam.prepares).toHaveLength(1)
    expect(seam.prepares[0]).toMatchObject({
      capability: 'spot',
      instrument: 'BTC/USDT',
      stopLossPrice: '55000',
      takeProfitPrice: '70000',
    })
    await app.close()
  })
})

describe('session symbol context', () => {
  it('mint accepts a symbol and stores it normalized; a bad symbol is ignored', async () => {
    const { app, sessions } = await testApp()
    const good = await app.inject({
      method: 'POST',
      url: '/v1/session',
      payload: { partnerKey: 'pk_demo', symbol: 'eth/usdt' },
    })
    expect(good.statusCode).toBe(200)
    const { sessionId } = good.json() as { sessionId: string }
    expect(sessions.get(sessionId)?.symbol).toBe('ETH/USDT')

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/session',
      payload: { partnerKey: 'pk_demo', symbol: 'not a symbol;;' },
    })
    expect(bad.statusCode).toBe(200) // ignored silently, mint unaffected
    const badId = (bad.json() as { sessionId: string }).sessionId
    expect(sessions.get(badId)?.symbol).toBeUndefined()
    await app.close()
  })

  it('context uplink updates the session symbol; a subsequent draft defaults to it', async () => {
    const { app, sessions } = await testApp({ intel: bareActionIntent() })
    const session = await createSession(app, sessions)
    expect(await sendTurn(app, session.id, { kind: 'context', symbol: 'sol/usdt' })).toBe(200)
    expect(session.symbol).toBe('SOL/USDT')

    // Invalid context symbol is ignored — the previous one stands.
    await sendTurn(app, session.id, { kind: 'context', symbol: '<script>' })
    expect(session.symbol).toBe('SOL/USDT')

    await sendTurn(app, session.id, { kind: 'user_text', text: 'set up a trade' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    expect(draft.instrument).toBe('SOL/USDT')
    expect(draft.sizeAsset).toBe('SOL')
    expect(draft.symbols[0]).toBe('SOL/USDT')
    await app.close()
  })
})

describe('live price ticker (transient price_tick — journal-bypassing)', () => {
  it('ticks reach a connected stream, are never journaled, and a resume replay contains zero ticks', async () => {
    process.env.PRICE_TICK_INTERVAL_MS = '25'
    try {
      const { app, sessions } = await testApp()
      const session = await createSession(app, sessions)
      await app.listen({ port: 0, host: '127.0.0.1' })
      const address = app.server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      const url = `http://127.0.0.1:${address.port}/v1/stream?session=${session.id}`

      // Connect and read until at least two ticks arrived.
      const c1 = new AbortController()
      const r1 = await fetch(url, { signal: c1.signal })
      const reader1 = r1.body?.getReader()
      if (!reader1) throw new Error('no body stream')
      const decoder = new TextDecoder()
      let buf1 = ''
      const deadline = Date.now() + 3000
      while ((buf1.match(/"price_tick"/g) ?? []).length < 2) {
        if (Date.now() > deadline) throw new Error(`no ticks; got:\n${buf1}`)
        const { value, done } = await reader1.read()
        if (done) break
        buf1 += decoder.decode(value, { stream: true })
      }
      c1.abort()

      // The tick frames are well-formed and carry the snapshot's numbers.
      const tickLine = buf1.split('\n').find((l) => l.includes('"price_tick"'))
      const tick = JSON.parse((tickLine ?? '').replace(/^data: /, ''))
      expect(tick.symbol).toBe('BTC/USDT')
      expect(tick.last).toBe(61240)
      expect(tick.lastDisplay).toBe('61,240')
      expect(tick.changePct).toBe(-4.18)
      // NO tick ever rides an `id:` line — the client's Last-Event-ID stays
      // pinned to journaled frames only.
      expect(buf1).not.toMatch(/id: \d+\ndata: [^\n]*"price_tick"/)

      // HARD requirement: the journal — the only replay source — has no ticks.
      expect(session.journal.after(0).some((e) => e.frame.type === 'price_tick')).toBe(false)

      // Reconnect with Last-Event-ID 0 → full journal replay. Every replayed
      // (id-bearing) frame must be tick-free.
      const c2 = new AbortController()
      const r2 = await fetch(url, {
        headers: { 'last-event-id': '0' },
        signal: c2.signal,
      })
      const reader2 = r2.body?.getReader()
      if (!reader2) throw new Error('no body stream')
      let buf2 = ''
      const lastSeq = session.journal.lastSeq()
      const deadline2 = Date.now() + 3000
      while (!new RegExp(`^id: ${lastSeq}$`, 'm').test(buf2)) {
        if (Date.now() > deadline2) throw new Error(`replay incomplete; got:\n${buf2}`)
        const { value, done } = await reader2.read()
        if (done) break
        buf2 += decoder.decode(value, { stream: true })
      }
      c2.abort()
      const replayed = [...buf2.matchAll(/^id: \d+\ndata: (.+)$/gm)].map(
        (m) => JSON.parse(m[1] as string) as { type: string },
      )
      expect(replayed.length).toBeGreaterThan(0)
      expect(replayed.filter((f) => f.type === 'price_tick')).toHaveLength(0)

      await app.close()
    } finally {
      delete process.env.PRICE_TICK_INTERVAL_MS
    }
  })

  it('a context symbol switch retargets the ticker to the new symbol', async () => {
    process.env.PRICE_TICK_INTERVAL_MS = '25'
    try {
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
      // Wait for a BTC tick, then switch the page context to ETH and wait for
      // an ETH tick (the stub market echoes the requested symbol back).
      while (!buf.includes('"symbol":"BTC/USDT"')) {
        if (Date.now() > deadline) throw new Error(`no BTC tick; got:\n${buf}`)
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
      }
      await sendTurn(app, session.id, { kind: 'context', symbol: 'ETH/USDT' })
      while (!buf.includes('"symbol":"ETH/USDT"')) {
        if (Date.now() > deadline) throw new Error(`no ETH tick; got:\n${buf}`)
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
      }
      ctrl.abort()
      expect(session.journal.after(0).some((e) => e.frame.type === 'price_tick')).toBe(false)
      await app.close()
    } finally {
      delete process.env.PRICE_TICK_INTERVAL_MS
    }
  })
})
