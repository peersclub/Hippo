/**
 * The conformance battery. Drives a ConformanceDriver through the Canonical
 * Trading Interface contract and returns a structured report. Deterministic
 * orchestration; the only time-dependent parts (waiting for a lifecycle event)
 * are bounded by an explicit timeout so a silent adapter fails rather than
 * hangs — the same failure mode the seam's own reconciler guards against.
 */
import type {
  ConformanceDriver,
  LifecycleEventShape,
  PreparedTicketShape,
  PrepareInput,
} from './contract.js'
import { TERMINAL_PHASES } from './contract.js'
import type { CheckId, CheckResult, ConformanceReport, Verdict } from './types.js'

export interface ConformanceOptions {
  /** How long to wait for a terminal lifecycle event after confirm. */
  lifecycleTimeoutMs?: number
  /** Poll cadence while waiting. */
  pollMs?: number
  /** Instrument to exercise; defaults to a spot-major pair. */
  instrument?: string
  /** Wall-clock stamp (injected so the pure suite stays deterministic in tests). */
  now?: string
}

const CONSEQUENCE: Record<CheckId, string> = {
  'prepare-market':
    'Market tickets cannot be prepared — the core prepare→confirm flow is unavailable for this venue.',
  'prepare-limit':
    'Limit tickets cannot be prepared — users can only place market orders through Hippo.',
  'ticket-display-strings':
    'Ticket values are not render-ready strings — the SDK would have to compute money, violating the thin-client contract.',
  'reject-bad-size':
    'The adapter does not reject invalid sizes — Hippo could forward a nonsensical order to the venue.',
  'confirm-lifecycle':
    'No terminal lifecycle event after confirm — the thread goes silent after handoff; fills are never reported back.',
  'cancel-preconfirm': 'A prepared ticket cannot be abandoned cleanly — stale tickets accumulate.',
  'cancel-postconfirm':
    'In-thread cancel does not stop the order — users must cancel on the venue UI.',
  'portfolio-shape':
    'Portfolio cannot be read in the canonical shape — positions/open-orders context is unavailable in conversation.',
}

const LABEL: Record<CheckId, string> = {
  'prepare-market': 'Prepare market order',
  'prepare-limit': 'Prepare limit order',
  'ticket-display-strings': 'Ticket values are display strings',
  'reject-bad-size': 'Reject invalid order size',
  'confirm-lifecycle': 'Confirm reaches a terminal lifecycle event',
  'cancel-preconfirm': 'Cancel before confirm',
  'cancel-postconfirm': 'Cancel after confirm stops the order',
  'portfolio-shape': 'Portfolio returns the canonical shape',
}

/** Collects lifecycle events and lets a check await one matching a predicate. */
class LifecycleCollector {
  readonly events: LifecycleEventShape[] = []
  constructor(driver: ConformanceDriver) {
    driver.onLifecycle((e) => this.events.push(e))
  }
  eventsFor(ticketId: string): LifecycleEventShape[] {
    return this.events.filter((e) => e.ticketId === ticketId)
  }
  async waitFor(
    ticketId: string,
    predicate: (e: LifecycleEventShape) => boolean,
    timeoutMs: number,
    pollMs: number,
  ): Promise<LifecycleEventShape | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = this.eventsFor(ticketId).find(predicate)
      if (hit) return hit
      await sleep(pollMs)
    }
    return this.eventsFor(ticketId).find(predicate) ?? null
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const baseInput = (instrument: string): PrepareInput => ({
  partnerId: 'conformance',
  userId: 'conformance-user',
  side: 'buy',
  size: '0.01',
  instrument,
  orderType: 'market',
})

function pass(id: CheckId, detail: string): CheckResult {
  return { id, label: LABEL[id], status: 'pass', detail, consequence: CONSEQUENCE[id] }
}
function fail(id: CheckId, detail: string): CheckResult {
  return { id, label: LABEL[id], status: 'fail', detail, consequence: CONSEQUENCE[id] }
}
function skip(id: CheckId, detail: string): CheckResult {
  return { id, label: LABEL[id], status: 'skip', detail, consequence: CONSEQUENCE[id] }
}

function assertTicketShape(t: PreparedTicketShape): string | null {
  if (!t || typeof t.ticketId !== 'string' || t.ticketId.length === 0) return 'missing ticketId'
  if (typeof t.sideLabel !== 'string' || t.sideLabel.length === 0) return 'missing sideLabel'
  if (!Array.isArray(t.rows) || t.rows.length === 0) return 'no display rows'
  return null
}

export async function runConformance(
  driver: ConformanceDriver,
  opts: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const instrument = opts.instrument ?? 'BTC/USDT'
  const timeout = opts.lifecycleTimeoutMs ?? 8_000
  const pollMs = opts.pollMs ?? 50
  const collector = new LifecycleCollector(driver)
  const checks: CheckResult[] = []

  // 1. prepare market
  let marketTicket: PreparedTicketShape | null = null
  try {
    marketTicket = await driver.prepare(baseInput(instrument))
    const bad = assertTicketShape(marketTicket)
    checks.push(
      bad
        ? fail('prepare-market', bad)
        : pass(
            'prepare-market',
            `ticket ${marketTicket.ticketId}, ${marketTicket.rows.length} rows`,
          ),
    )
  } catch (err) {
    checks.push(fail('prepare-market', `threw: ${errText(err)}`))
  }

  // 2. prepare limit
  try {
    const limit = await driver.prepare({
      ...baseInput(instrument),
      orderType: 'limit',
      limitPrice: '30000',
    })
    const bad = assertTicketShape(limit)
    const mentionsLimit = limit.rows.some((r) => /limit/i.test(r.label))
    if (bad) checks.push(fail('prepare-limit', bad))
    else if (!mentionsLimit)
      checks.push(
        fail('prepare-limit', 'no limit-price row — limit price not reflected in the ticket'),
      )
    else checks.push(pass('prepare-limit', `limit ticket ${limit.ticketId}`))
  } catch (err) {
    checks.push(fail('prepare-limit', `threw: ${errText(err)}`))
  }

  // 3. ticket values are display strings (SDK computes no money)
  if (marketTicket) {
    const nonString = marketTicket.rows.find((r) => typeof r.value !== 'string')
    checks.push(
      nonString
        ? fail(
            'ticket-display-strings',
            `row "${nonString.label}" value is ${typeof nonString.value}, not string`,
          )
        : pass('ticket-display-strings', 'all row values are strings'),
    )
  } else {
    checks.push(skip('ticket-display-strings', 'prepare failed, nothing to inspect'))
  }

  // 4. reject bad size (never guess size)
  try {
    await driver.prepare({ ...baseInput(instrument), size: '-1' })
    checks.push(fail('reject-bad-size', 'prepared a ticket for size -1 instead of rejecting'))
  } catch {
    checks.push(pass('reject-bad-size', 'rejected size -1'))
  }

  // 5. confirm reaches a terminal lifecycle event
  try {
    const t = await driver.prepare(baseInput(instrument))
    await driver.confirm(t.ticketId)
    const terminal = await collector.waitFor(
      t.ticketId,
      (e) => TERMINAL_PHASES.has(e.phase),
      timeout,
      pollMs,
    )
    if (!terminal)
      checks.push(
        fail('confirm-lifecycle', `no terminal event within ${timeout}ms (thread would hang)`),
      )
    else if (typeof terminal.statusLine !== 'string' || terminal.statusLine.length === 0)
      checks.push(fail('confirm-lifecycle', `terminal '${terminal.phase}' event has no statusLine`))
    else
      checks.push(
        pass('confirm-lifecycle', `reached '${terminal.phase}' — "${terminal.statusLine}"`),
      )
  } catch (err) {
    checks.push(fail('confirm-lifecycle', `threw: ${errText(err)}`))
  }

  // 6. cancel before confirm
  try {
    const t = await driver.prepare(baseInput(instrument))
    const ok = await driver.cancel(t.ticketId)
    checks.push(
      ok
        ? pass('cancel-preconfirm', 'cancelled an unconfirmed ticket')
        : fail('cancel-preconfirm', 'cancel returned false for a known unconfirmed ticket'),
    )
  } catch (err) {
    checks.push(fail('cancel-preconfirm', `threw: ${errText(err)}`))
  }

  // 7. cancel after confirm stops the order (no fill after cancel)
  try {
    const t = await driver.prepare(baseInput(instrument))
    await driver.confirm(t.ticketId)
    const cancelled = await driver.cancel(t.ticketId)
    const before = collector.eventsFor(t.ticketId).length
    await sleep(Math.min(timeout, 300))
    const filledAfter = collector
      .eventsFor(t.ticketId)
      .slice(before)
      .some((e) => e.phase === 'filled')
    if (!cancelled) checks.push(fail('cancel-postconfirm', 'cancel returned false after confirm'))
    else if (filledAfter)
      checks.push(fail('cancel-postconfirm', 'order filled after it was cancelled'))
    else checks.push(pass('cancel-postconfirm', 'no fill emitted after cancel'))
  } catch (err) {
    checks.push(fail('cancel-postconfirm', `threw: ${errText(err)}`))
  }

  // 8. portfolio shape
  try {
    const pf = await driver.portfolio('conformance', 'conformance-user')
    if (!pf || !Array.isArray(pf.positions) || !Array.isArray(pf.openOrders))
      checks.push(fail('portfolio-shape', 'missing positions[]/openOrders[]'))
    else
      checks.push(
        pass(
          'portfolio-shape',
          `${pf.positions.length} positions, ${pf.openOrders.length} open orders`,
        ),
      )
  } catch (err) {
    checks.push(fail('portfolio-shape', `threw: ${errText(err)}`))
  }

  await driver.close?.()
  return { target: driver.target, ranAt: opts.now ?? '', checks, verdict: verdictFor(checks) }
}

function verdictFor(checks: CheckResult[]): Verdict {
  const passed = checks.filter((c) => c.status === 'pass').length
  const failed = checks.filter((c) => c.status === 'fail').length
  const skipped = checks.filter((c) => c.status === 'skip').length
  const level = failed === 0 ? (skipped === 0 ? 'Conformant' : 'Partial') : 'Non-conformant'
  return { level, passed, failed, skipped, total: checks.length }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
