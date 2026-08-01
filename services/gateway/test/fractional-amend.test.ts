/**
 * Fractional position sizing + conversational amend.
 *
 * Fractional ("sell half my SOL position"): the intent carries sizeFraction
 * and an empty size; the orchestrator resolves the fraction against the LIVE
 * position via the seam's portfolio and flows into the existing close/reduce
 * prepare path. No position → an honest decline, never a zero-size order.
 *
 * Amend ("move my limit to 61k"): v1 is a replacement ticket. Exactly one
 * open order → a new ticket carrying a server-authored "Replaces order #id"
 * row; its confirm cancels the OLD venue order first, then places the new
 * one — and every failure mode says the whole truth (cancel failed → nothing
 * placed; place failed after cancel → both facts in the status line).
 */
import { describe, expect, it } from 'vitest'
import type { IntentResult } from '../src/orchestrator/intelligence.js'
import type { OrderRecord, SeamPortfolio } from '../src/orchestrator/seam.js'
import {
  createSession,
  frameOfType,
  ordersFixture,
  sendTurn,
  stubIntel,
  stubSeam,
  testApp,
  waitForJournal,
} from './helpers.js'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Spot fractional reduce ("sell half my SOL position") as stage-1 emits it:
 * sizeFraction set, size empty, action close marking the reduce path. */
const spotFractionIntent = (fraction: number, instrument = 'SOL/USDT') =>
  stubIntel({
    intent: (): IntentResult => ({
      intent: 'action',
      confidence: 0.95,
      language: 'en',
      order: {
        side: 'sell',
        action: 'close',
        size: '',
        sizeFraction: fraction,
        instrument,
        orderType: 'market',
      },
    }),
  })

/** Perp fractional close ("close half my long") — no asset named, so the
 * instrument is empty and the orchestrator falls back to the page symbol. */
const perpFractionIntent = (fraction: number) =>
  stubIntel({
    intent: (): IntentResult => ({
      intent: 'action',
      confidence: 0.95,
      language: 'en',
      order: {
        capability: 'futures_perp',
        side: 'sell',
        direction: 'long',
        action: 'close',
        leverage: 10,
        marginMode: 'isolated',
        reduceOnly: true,
        size: '',
        sizeFraction: fraction,
        instrument: '',
        orderType: 'market',
      },
    }),
  })

/** Amend intent ("move my limit to 61k" / "change my order to 0.2"). */
const amendIntent = (amend: { price?: string; size?: string }) =>
  stubIntel({
    intent: (): IntentResult => ({ intent: 'action', confidence: 0.95, language: 'en', amend }),
  })

/** Portfolio with a known SOL position for fraction resolution. */
const solPortfolio: SeamPortfolio = {
  positions: [
    {
      instrument: 'SOL/USDT',
      size: '10 SOL',
      entry: '150',
      mark: '160',
      pnl: '+100.00 USDT',
      tone: 'pos',
    },
  ],
  openOrders: [],
}

const lifecycleLines = (session: Awaited<ReturnType<typeof createSession>>) =>
  session.journal
    .after(0)
    .filter((e) => e.frame.type === 'lifecycle')
    .map((e) => e.frame as unknown as { phase: string; statusLine: string })

describe('fractional position sizing resolves against the live position', () => {
  it('"sell half my SOL" → size = 0.5 × live position, straight to the ticket (no draft)', async () => {
    const seam = stubSeam()
    seam.portfolio = async () => solPortfolio
    const { app, sessions } = await testApp({ intel: spotFractionIntent(0.5), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'sell half my sol position' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))

    const types = session.journal.after(0).map((e) => e.frame.type)
    expect(types).not.toContain('order_draft')
    expect(types).not.toContain('rejection_ticket')
    expect(seam.prepares).toHaveLength(1)
    expect(seam.prepares[0]).toMatchObject({
      side: 'sell',
      size: '5',
      instrument: 'SOL/USDT',
      orderType: 'market',
    })
    await app.close()
  })

  it('fraction 1.0 ("sell all") uses the full live position — existing close behavior', async () => {
    const seam = stubSeam()
    seam.portfolio = async () => solPortfolio
    const { app, sessions } = await testApp({ intel: spotFractionIntent(1.0), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'sell all my sol' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    expect(seam.prepares[0]).toMatchObject({ size: '10', instrument: 'SOL/USDT' })
    await app.close()
  })

  it('odd fractions round to the venue precision (8dp, trimmed) — never floating-point noise', async () => {
    const seam = stubSeam()
    seam.portfolio = async () => solPortfolio
    // third ≈ 0.333 of 10 SOL → 3.33, not 3.3299999….
    const { app, sessions } = await testApp({ intel: spotFractionIntent(0.333), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'sell a third of my sol' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    expect(seam.prepares[0]).toMatchObject({ size: '3.33' })
    await app.close()
  })

  it('perp "close half my long" with no asset → page symbol + reduce-only plan at half size', async () => {
    const seam = stubSeam()
    // Default portfolio fixture holds 0.31 BTC; the session symbol defaults
    // to BTC/USDT, so the empty instrument resolves there.
    const { app, sessions } = await testApp({ intel: perpFractionIntent(0.5), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'close half my long' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    expect(seam.prepares).toHaveLength(1)
    expect(seam.prepares[0]).toMatchObject({
      capability: 'futures_perp',
      instrument: 'BTC/USDT',
      action: 'close',
      reduceOnly: true,
      size: '0.155',
    })
    const types = session.journal.after(0).map((e) => e.frame.type)
    expect(types).not.toContain('order_draft')
    await app.close()
  })

  it('no open position → honest decline, nothing sent to the venue', async () => {
    const seam = stubSeam()
    seam.portfolio = async () => ({ positions: [], openOrders: [] })
    const { app, sessions } = await testApp({ intel: spotFractionIntent(0.5), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'sell half my sol position' })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))

    const rejection = frameOfType<{ title: string; reason: string }>(session, 'rejection_ticket')
    expect(rejection.title).toBe('No position to reduce')
    expect(rejection.reason).toContain('no open SOL position')
    await delay(20)
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })

  it('portfolio unreachable → honest decline (no guessed size), nothing sent', async () => {
    const seam = stubSeam()
    seam.portfolio = async () => {
      throw new Error('seam portfolio down')
    }
    const { app, sessions } = await testApp({ intel: spotFractionIntent(0.5), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'sell half my sol position' })
    // The connect-time orders snapshot also reads the portfolio and is
    // best-effort; the turn's decline is the rejection_ticket.
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })
})

describe('conversational amend: replacement ticket over the single open order', () => {
  it('one open order + price amend → ticket with a server-authored "Replaces" row', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: amendIntent({ price: '61000' }), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'move my limit to 61k' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))

    // Replacement terms: the fixture's open order is BUY 0.05 BTC MKT; the
    // amended price makes the replacement a LIMIT at 61000, same size/side.
    expect(seam.prepares).toHaveLength(1)
    expect(seam.prepares[0]).toMatchObject({
      side: 'buy',
      size: '0.05',
      instrument: 'BTC/USDT',
      orderType: 'limit',
      limitPrice: '61000',
    })
    const ticket = frameOfType<{ ticketId: string; rows: Array<{ label: string; value: string }> }>(
      session,
      'order_ticket',
    )
    expect(ticket.rows).toContainEqual({ label: 'Replaces', value: 'Order #t_open01' })
    await app.close()
  })

  it('confirm cancels the OLD order first, THEN places the new one (ordering asserted)', async () => {
    const ops: string[] = []
    const seam = stubSeam()
    const baseCancel = seam.cancel.bind(seam)
    const baseConfirm = seam.confirm.bind(seam)
    seam.cancel = async (id) => {
      ops.push(`cancel:${id}`)
      return baseCancel(id)
    }
    seam.confirm = async (id) => {
      ops.push(`confirm:${id}`)
      return baseConfirm(id)
    }
    const { app, sessions } = await testApp({ intel: amendIntent({ price: '61000' }), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'move my limit to 61k' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    const ticket = frameOfType<{ ticketId: string }>(session, 'order_ticket')

    await sendTurn(app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'confirm_handoff',
    })
    await waitForJournal(session, (t) => t.filter((x) => x === 'lifecycle').length >= 2)
    expect(ops).toEqual([`cancel:t_open01`, `confirm:${ticket.ticketId}`])
    const lines = lifecycleLines(session)
    expect(lines[0]?.statusLine).toContain('CANCELLING ORDER #T_OPEN01')
    expect(lines[1]?.statusLine).toContain('CANCELLED — SENDING REPLACEMENT')
    await app.close()
  })

  it('zero open orders → honest "no working order to amend" notice, no ticket', async () => {
    const noOpen: OrderRecord[] = ordersFixture.filter((r) => r.statusClass !== 'open')
    const seam = stubSeam(undefined, noOpen)
    const { app, sessions } = await testApp({ intel: amendIntent({ price: '61000' }), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'move my limit to 61k' })
    await waitForJournal(session, (t) => t.includes('banner'))

    const banner = frameOfType<{ kind: string; title: string; text: string }>(session, 'banner')
    expect(banner.title).toBe('No working order')
    expect(banner.text).toContain('no working order')
    await delay(20)
    expect(seam.prepares).toHaveLength(0)
    const types = session.journal.after(0).map((e) => e.frame.type)
    expect(types).not.toContain('order_ticket')
    await app.close()
  })

  it('several open orders → asks which one, listing them; nothing prepared', async () => {
    const twoOpen: OrderRecord[] = [
      ...ordersFixture,
      {
        orderId: 't_open02',
        symbol: 'ETH/USDT',
        side: 'sell',
        kind: 'LMT 3,200',
        qty: '1.5',
        price: '3,200',
        status: 'WORKING',
        statusClass: 'open',
        tsIso: '2026-07-31T10:00:00.000Z',
      },
    ]
    const seam = stubSeam(undefined, twoOpen)
    const { app, sessions } = await testApp({ intel: amendIntent({ size: '0.2' }), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'change my order to 0.2' })
    await waitForJournal(session, (t) => t.includes('banner'))

    const banner = frameOfType<{ title: string; text: string }>(session, 'banner')
    expect(banner.title).toBe('Which order?')
    expect(banner.text).toContain('#t_open01')
    expect(banner.text).toContain('#t_open02')
    await delay(20)
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })

  it('size amend of a working limit order keeps its price', async () => {
    const openLimit: OrderRecord[] = [
      {
        orderId: 't_lmt01',
        symbol: 'ETH/USDT',
        side: 'sell',
        kind: 'LMT 3,100',
        qty: '2 ETH',
        price: '3,100',
        status: 'WORKING',
        statusClass: 'open',
        tsIso: '2026-07-31T09:00:00.000Z',
      },
    ]
    const seam = stubSeam(undefined, openLimit)
    const { app, sessions } = await testApp({ intel: amendIntent({ size: '0.2' }), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'change my order to 0.2' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    expect(seam.prepares[0]).toMatchObject({
      side: 'sell',
      size: '0.2',
      instrument: 'ETH/USDT',
      orderType: 'limit',
      limitPrice: '3100',
    })
    await app.close()
  })

  it('cancel succeeds but placement fails → the thread says BOTH facts', async () => {
    const ops: string[] = []
    const seam = stubSeam()
    seam.cancel = async (id) => {
      ops.push(`cancel:${id}`)
    }
    seam.confirm = async (id) => {
      ops.push(`confirm:${id}`)
      throw new Error('venue rejected the replacement')
    }
    const { app, sessions } = await testApp({ intel: amendIntent({ price: '61000' }), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'move my limit to 61k' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    const ticket = frameOfType<{ ticketId: string }>(session, 'order_ticket')

    await sendTurn(app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'confirm_handoff',
    })
    await waitForJournal(session, (t) => t.filter((x) => x === 'lifecycle').length >= 3)
    const last = lifecycleLines(session).at(-1)
    expect(last?.phase).toBe('expired')
    // Honest half-done: the old order IS cancelled AND the replacement failed.
    expect(last?.statusLine).toContain('#T_OPEN01 WAS CANCELLED')
    expect(last?.statusLine).toContain('REJECTED THE REPLACEMENT')
    expect(ops[0]).toBe('cancel:t_open01')
    await app.close()
  })

  it('cancel leg fails → old order untouched in copy, replacement never sent', async () => {
    const seam = stubSeam()
    seam.cancel = async () => {
      throw new Error('venue cancel failed')
    }
    const { app, sessions } = await testApp({ intel: amendIntent({ price: '61000' }), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'move my limit to 61k' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    const ticket = frameOfType<{ ticketId: string }>(session, 'order_ticket')

    await sendTurn(app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'confirm_handoff',
    })
    await waitForJournal(session, (t) => t.filter((x) => x === 'lifecycle').length >= 2)
    const last = lifecycleLines(session).at(-1)
    expect(last?.phase).toBe('expired')
    expect(last?.statusLine).toContain("COULDN'T CANCEL ORDER #T_OPEN01")
    expect(last?.statusLine).toContain('NO REPLACEMENT WAS PLACED')
    expect(seam.confirms).toHaveLength(0)
    await app.close()
  })

  it('seam listOrders down → honest rejection, working order untouched', async () => {
    const seam = stubSeam()
    seam.listOrders = async () => {
      throw new Error('seam orders down')
    }
    const { app, sessions } = await testApp({ intel: amendIntent({ price: '61000' }), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'move my limit to 61k' })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    const rejection = frameOfType<{ title: string }>(session, 'rejection_ticket')
    expect(rejection.title).toBe('Order not amended')
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })
})
