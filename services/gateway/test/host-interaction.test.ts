/**
 * Host-interaction wave: chart control (host_action) gated on the host's
 * pageControl opt-in, and the consolidated orders blotter (orders_summary)
 * with scope filtering, truthful totals, and the empty state.
 *
 * The stub intent classifier is the real degraded-mode `guessIntent`, which now
 * detects host_action and orders_query — so these tests exercise the SAME
 * deterministic classification the production fast-path produces.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { guessIntent } from '../src/orchestrator/intelligence.js'
import type { OrderRecord } from '../src/orchestrator/seam.js'
import type { Session, SessionStore } from '../src/plugins/auth.js'
import { InMemorySessionStore } from '../src/plugins/auth.js'
import {
  createSession,
  frameOfType,
  ordersFixture,
  sendTurn,
  stubIntel,
  stubSeam,
  submitDraft,
  type TestGateway,
  testApp,
  waitForJournal,
} from './helpers.js'

const intel = () => stubIntel({ intent: (text) => guessIntent(text) })

let gw: TestGateway
let sessions: SessionStore
afterEach(async () => {
  await gw?.app.close()
})

async function boot(seam = stubSeam()) {
  sessions = new InMemorySessionStore()
  gw = await testApp({ intel: intel(), seam, sessions })
  const session = await createSession(gw.app, sessions)
  return session
}

/** Turn on host chart control for the session via a context uplink. */
async function optIn(session: Session): Promise<void> {
  await sendTurn(gw.app, session.id, { kind: 'context', pageControl: true })
}

describe('host actions — chart control gated on pageControl', () => {
  it('opted-in: emits a host_action frame with a server-authored note + ack', async () => {
    const session = await boot()
    await optIn(session)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'switch to 5m candles' })

    await waitForJournal(session, (t) => t.includes('host_action'))
    const frame = frameOfType<{
      action: string
      timeframe?: string
      note?: string
      actionId: string
    }>(session, 'host_action')
    expect(frame.action).toBe('set_timeframe')
    expect(frame.timeframe).toBe('5m')
    expect(frame.note).toBe('Chart → 5m')
    expect(frame.actionId).toMatch(/^ha_/)

    // A short user-visible acknowledgment rides alongside (the notice surface).
    const banner = frameOfType<{ kind: string; title: string }>(session, 'banner')
    expect(banner.kind).toBe('info')
    expect(banner.title).toBe('Chart updated')
  })

  it('opted-in: canonicalises an indicator phrase ("20 day moving average" → sma20)', async () => {
    const session = await boot()
    await optIn(session)
    await sendTurn(gw.app, session.id, {
      kind: 'user_text',
      text: 'apply the 20 day moving average',
    })
    await waitForJournal(session, (t) => t.includes('host_action'))
    const frame = frameOfType<{ action: string; indicator?: string; note?: string }>(
      session,
      'host_action',
    )
    expect(frame.action).toBe('apply_indicator')
    expect(frame.indicator).toBe('sma20')
    expect(frame.note).toBe('Indicator → SMA 20')
  })

  it('NOT opted-in: honest one-line notice, never a host_action frame', async () => {
    const session = await boot()
    // No context uplink → pageControl absent.
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'apply RSI' })

    const types = await waitForJournal(session, (t) => t.includes('banner'))
    expect(types).not.toContain('host_action')
    const banner = frameOfType<{ kind: string; title: string }>(session, 'banner')
    expect(banner.kind).toBe('info')
    expect(banner.title).toMatch(/chart control is off/i)
  })

  it('opted-in but unsupported indicator: honest decline, no host_action frame', async () => {
    const session = await boot()
    await optIn(session)
    await sendTurn(gw.app, session.id, {
      kind: 'user_text',
      text: 'apply the ichimoku indicator',
    })
    const types = await waitForJournal(session, (t) => t.includes('banner'))
    expect(types).not.toContain('host_action')
    const banner = frameOfType<{ kind: string; title: string }>(session, 'banner')
    expect(banner.title).toMatch(/not recognised/i)
  })

  it('pageControl:false explicitly still declines in prose', async () => {
    const session = await boot()
    await sendTurn(gw.app, session.id, { kind: 'context', pageControl: false })
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'remove the moving average' })
    const types = await waitForJournal(session, (t) => t.includes('banner'))
    expect(types).not.toContain('host_action')
  })
})

describe('consolidated orders — orders_summary', () => {
  it('scope "all": every order, totals over the full set, newest first', async () => {
    const session = await boot()
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'show all my orders' })
    await waitForJournal(session, (t) => t.includes('orders_summary'))
    const frame = frameOfType<{
      scope: string
      orders: Array<{ orderId: string }>
      totals: { open: number; filled: number; cancelled: number }
    }>(session, 'orders_summary')
    expect(frame.scope).toBe('all')
    expect(frame.orders).toHaveLength(3)
    expect(frame.totals).toEqual({ open: 1, filled: 1, cancelled: 1 })
    // Newest first by tsIso (t_open01 @ 09:00 > t_fill01 @ 08:00 > t_cxl01 @ 07:00).
    expect(frame.orders.map((o) => o.orderId)).toEqual(['t_open01', 't_fill01', 't_cxl01'])
  })

  it('scope "session": only orders this session created', async () => {
    // The blotter includes an extra order carrying the session ticketId the
    // draft flow will mint (t_fixture001), plus the three unrelated fixtures.
    const sessionOrder: OrderRecord = {
      orderId: 't_fixture001',
      symbol: 'BTC/USDT',
      side: 'buy',
      kind: 'MKT',
      qty: '0.05',
      status: 'WORKING',
      statusClass: 'open',
      tsIso: '2026-07-31T10:00:00.000Z',
    }
    const session = await boot(stubSeam(undefined, [sessionOrder, ...ordersFixture]))

    // Create an order this session → its ticketId lands in createdTicketIds.
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    await submitDraft(gw.app, session)
    expect(session.createdTicketIds?.has('t_fixture001')).toBe(true)

    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'my orders in this session' })
    await waitForJournal(session, (t) => t.includes('orders_summary'))
    const frame = frameOfType<{
      scope: string
      orders: Array<{ orderId: string }>
      totals: { open: number; filled: number; cancelled: number }
    }>(session, 'orders_summary')
    expect(frame.scope).toBe('session')
    expect(frame.orders.map((o) => o.orderId)).toEqual(['t_fixture001'])
    expect(frame.totals).toEqual({ open: 1, filled: 0, cancelled: 0 })
  })

  it('empty result still emits the frame (empty orders + zero totals)', async () => {
    const session = await boot(stubSeam(undefined, []))
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'show all my orders' })
    await waitForJournal(session, (t) => t.includes('orders_summary'))
    const frame = frameOfType<{ orders: unknown[]; totals: Record<string, number> }>(
      session,
      'orders_summary',
    )
    expect(frame.orders).toEqual([])
    expect(frame.totals).toEqual({ open: 0, filled: 0, cancelled: 0 })
  })

  it('bounds to 50 rows but totals stay true over the full set', async () => {
    const many: OrderRecord[] = Array.from({ length: 55 }, (_, i) => ({
      orderId: `t_${i}`,
      symbol: 'BTC/USDT',
      side: 'buy',
      kind: 'MKT',
      qty: '0.01',
      status: 'FILLED',
      statusClass: 'filled',
      filledPct: 100,
      tsIso: new Date(Date.UTC(2026, 6, 31, 0, 0, i)).toISOString(),
    }))
    const session = await boot(stubSeam(undefined, many))
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'show all my orders' })
    await waitForJournal(session, (t) => t.includes('orders_summary'))
    const frame = frameOfType<{
      orders: unknown[]
      totals: { filled: number }
    }>(session, 'orders_summary')
    expect(frame.orders).toHaveLength(50)
    expect(frame.totals.filled).toBe(55)
  })

  it('seam down: honest rejection, never a fabricated blotter', async () => {
    const seam = stubSeam()
    seam.listOrders = async () => {
      throw new Error('seam unreachable')
    }
    const session = await boot(seam)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'show all my orders' })
    const types = await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(types).not.toContain('orders_summary')
  })
})
