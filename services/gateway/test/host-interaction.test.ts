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

/** The wave-2 host: page control + a declared verb vocabulary. */
const WIDE_VERBS = [
  'set_timeframe',
  'apply_indicator',
  'remove_indicator',
  'set_symbol',
  'navigate',
  'prefill_ticket',
]
async function optInWide(session: Session, hostActions: string[] = WIDE_VERBS): Promise<void> {
  await sendTurn(gw.app, session.id, { kind: 'context', pageControl: true, hostActions })
}

type HostActionFrame = {
  action: string
  timeframe?: string
  indicator?: string
  params?: Record<string, string>
  note?: string
  actionId: string
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

describe('wider host verbs — gated on the host-declared vocabulary', () => {
  it('set_symbol: "switch to eth" → params.symbol normalized to ETH/USDT', async () => {
    const session = await boot()
    await optInWide(session)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'switch to eth' })
    await waitForJournal(session, (t) => t.includes('host_action'))
    const frame = frameOfType<HostActionFrame>(session, 'host_action')
    expect(frame.action).toBe('set_symbol')
    expect(frame.params).toEqual({ symbol: 'ETH/USDT' })
    expect(frame.note).toBe('Market → ETH/USDT')
    const banner = frameOfType<{ title: string }>(session, 'banner')
    expect(banner.title).toBe('Market switched')
  })

  it('set_symbol: an explicit pair rides through ("show me sol/usdt")', async () => {
    const session = await boot()
    await optInWide(session)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'show me sol/usdt' })
    await waitForJournal(session, (t) => t.includes('host_action'))
    expect(frameOfType<HostActionFrame>(session, 'host_action').params).toEqual({
      symbol: 'SOL/USDT',
    })
  })

  it('set_symbol: an invalid symbol from stage-1 is re-validated and declined', async () => {
    sessions = new InMemorySessionStore()
    gw = await testApp({
      intel: stubIntel({
        intent: () => ({
          intent: 'host_action',
          confidence: 0.9,
          language: 'en',
          hostAction: { action: 'set_symbol', params: { symbol: 'DROP TABLE;' } },
        }),
      }),
      seam: stubSeam(),
      sessions,
    })
    const session = await createSession(gw.app, sessions)
    await optInWide(session)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'switch to whatever' })
    const types = await waitForJournal(session, (t) => t.includes('banner'))
    expect(types).not.toContain('host_action')
    expect(frameOfType<{ title: string }>(session, 'banner').title).toMatch(/not recognised/i)
  })

  it('navigate: "go to settings" → params.target, server-authored note', async () => {
    const session = await boot()
    await optInWide(session)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'go to settings' })
    await waitForJournal(session, (t) => t.includes('host_action'))
    const frame = frameOfType<HostActionFrame>(session, 'host_action')
    expect(frame.action).toBe('navigate')
    expect(frame.params).toEqual({ target: 'settings' })
    expect(frame.note).toBe('Page → settings')
  })

  it('navigate: "open the trade page" → target trade', async () => {
    const session = await boot()
    await optInWide(session)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'open the trade page' })
    await waitForJournal(session, (t) => t.includes('host_action'))
    expect(frameOfType<HostActionFrame>(session, 'host_action').params).toEqual({
      target: 'trade',
    })
  })

  it('prefill_ticket: side+qty as strings, NO invented price', async () => {
    const session = await boot()
    await optInWide(session)
    await sendTurn(gw.app, session.id, {
      kind: 'user_text',
      text: 'fill the ticket to buy 0.1 btc',
    })
    await waitForJournal(session, (t) => t.includes('host_action'))
    const frame = frameOfType<HostActionFrame>(session, 'host_action')
    expect(frame.action).toBe('prefill_ticket')
    // The server must NOT invent a price the trader never said.
    expect(frame.params).toEqual({ side: 'buy', qty: '0.1' })
    expect(frame.note).toBe('Ticket → BUY 0.1')
    // The ack must say nothing was submitted — prefill never trades.
    const banner = frameOfType<{ title: string; text: string }>(session, 'banner')
    expect(banner.title).toBe('Ticket prefilled')
    expect(banner.text).toMatch(/nothing was submitted/i)
  })

  it('prefill_ticket: a trader-stated price rides along as a string', async () => {
    const session = await boot()
    await optInWide(session)
    await sendTurn(gw.app, session.id, {
      kind: 'user_text',
      text: 'fill the ticket to sell 2 eth at 3,150',
    })
    await waitForJournal(session, (t) => t.includes('host_action'))
    const frame = frameOfType<HostActionFrame>(session, 'host_action')
    expect(frame.params).toEqual({ side: 'sell', qty: '2', price: '3150' })
    expect(frame.note).toBe('Ticket → SELL 2 @ 3150')
  })

  it('prefill_ticket: missing side/qty → honest decline, no frame', async () => {
    const session = await boot()
    await optInWide(session)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'fill in the ticket' })
    const types = await waitForJournal(session, (t) => t.includes('banner'))
    expect(types).not.toContain('host_action')
    expect(frameOfType<{ title: string }>(session, 'banner').title).toBe('Ticket not prefilled')
  })

  it('LEGACY session (pageControl only): a new verb is declined, never emitted', async () => {
    const session = await boot()
    await optIn(session) // no hostActions declared → chart trio only
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'switch to eth' })
    const types = await waitForJournal(session, (t) => t.includes('banner'))
    expect(types).not.toContain('host_action')
    expect(frameOfType<{ title: string }>(session, 'banner').title).toBe(
      'Not supported on this page',
    )
  })

  it('LEGACY session: the chart trio still works exactly as before', async () => {
    const session = await boot()
    await optIn(session)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'switch to 5m candles' })
    await waitForJournal(session, (t) => t.includes('host_action'))
    const frame = frameOfType<HostActionFrame>(session, 'host_action')
    expect(frame.action).toBe('set_timeframe')
    expect(frame.timeframe).toBe('5m')
    expect(frame.params).toBeUndefined()
  })

  it('a NARROW declaration gates even chart verbs off the list', async () => {
    const session = await boot()
    await optInWide(session, ['set_timeframe']) // host only speaks timeframes
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'apply RSI' })
    const types = await waitForJournal(session, (t) => t.includes('banner'))
    expect(types).not.toContain('host_action')
    expect(frameOfType<{ title: string }>(session, 'banner').title).toBe(
      'Not supported on this page',
    )
  })

  it('a declared FUTURE verb passes through with its params untouched', async () => {
    sessions = new InMemorySessionStore()
    gw = await testApp({
      intel: stubIntel({
        intent: () => ({
          intent: 'host_action',
          confidence: 0.9,
          language: 'en',
          hostAction: { action: 'toggle_depth_view', params: { mode: 'full' } },
        }),
      }),
      seam: stubSeam(),
      sessions,
    })
    const session = await createSession(gw.app, sessions)
    await optInWide(session, ['toggle_depth_view'])
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'expand the depth view' })
    await waitForJournal(session, (t) => t.includes('host_action'))
    const frame = frameOfType<HostActionFrame>(session, 'host_action')
    expect(frame.action).toBe('toggle_depth_view')
    expect(frame.params).toEqual({ mode: 'full' })
    expect(frame.note).toBe('toggle depth view')
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
