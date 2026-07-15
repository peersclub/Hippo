import { describe, expect, it } from 'vitest'
import type {
  ConformanceDriver,
  LifecycleEventShape,
  PreparedTicketShape,
  PrepareInput,
} from '../src/conform/contract.js'
import { renderConformanceReport } from '../src/conform/report.js'
import { runConformance } from '../src/conform/suite.js'
import type { CheckId } from '../src/conform/types.js'

/**
 * Configurable in-process driver — a stand-in for a real adapter behind a
 * driver. Flags flip individual contract violations so each check can be shown
 * to catch exactly its own failure.
 */
interface MockFlags {
  acceptBadSize?: boolean
  numericRows?: boolean
  silentConfirm?: boolean
  fillAfterCancel?: boolean
  brokenPortfolio?: boolean
  fillDelayMs?: number
}

function makeMockDriver(flags: MockFlags = {}): ConformanceDriver {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let handler: (e: LifecycleEventShape) => void = () => {}
  let seq = 0
  const fillDelay = flags.fillDelayMs ?? 20

  return {
    target: 'mock',
    async prepare(input: PrepareInput): Promise<PreparedTicketShape> {
      const n = Number(input.size)
      if (!flags.acceptBadSize && (!Number.isFinite(n) || n <= 0))
        throw new Error('invalid order size')
      const isLimit = input.orderType === 'limit'
      const priceRow = isLimit
        ? {
            label: 'Limit price',
            value: flags.numericRows ? (30000 as unknown as string) : '30,000',
          }
        : {
            label: 'Est. price',
            value: flags.numericRows ? (61240 as unknown as string) : '61,240',
          }
      seq += 1
      return {
        ticketId: `mock_${seq}`,
        sideLabel: `${input.side.toUpperCase()} · ${isLimit ? 'LMT' : 'MKT'}`,
        instrument: input.instrument,
        orderType: input.orderType,
        rows: [{ label: 'Instrument', value: input.instrument }, priceRow],
      }
    },
    async confirm(ticketId: string): Promise<void> {
      if (flags.silentConfirm) return
      const t = setTimeout(() => {
        handler({ ticketId, phase: 'filled', statusLine: 'FILLED', venueOrderId: 'MOCK-1' })
        timers.delete(ticketId)
      }, fillDelay)
      timers.set(ticketId, t)
    },
    async cancel(ticketId: string): Promise<boolean> {
      if (!flags.fillAfterCancel) {
        const t = timers.get(ticketId)
        if (t) clearTimeout(t)
        timers.delete(ticketId)
      }
      return true
    },
    async portfolio() {
      if (flags.brokenPortfolio) return {} as never
      return {
        positions: [{ instrument: 'BTC', size: '0.31 BTC' }],
        openOrders: [
          { orderId: 'o1', side: 'sell' as const, summary: 'SELL 12 SOL', status: 'OPEN' },
        ],
      }
    },
    onLifecycle(h) {
      handler = h
    },
  }
}

const FAST = { lifecycleTimeoutMs: 200, pollMs: 5 }
const statusOf = (checks: { id: CheckId; status: string }[], id: CheckId) =>
  checks.find((c) => c.id === id)?.status

describe('conformance suite — conformant adapter', () => {
  it('passes every check', async () => {
    const report = await runConformance(makeMockDriver(), FAST)
    expect(report.verdict.level).toBe('Conformant')
    expect(report.verdict.failed).toBe(0)
    expect(report.verdict.passed).toBe(report.verdict.total)
  })
})

describe('conformance suite — catches specific violations', () => {
  it('flags a silent confirm (thread would hang)', async () => {
    const report = await runConformance(makeMockDriver({ silentConfirm: true }), FAST)
    expect(statusOf(report.checks, 'confirm-lifecycle')).toBe('fail')
    expect(report.verdict.level).toBe('Non-conformant')
  })

  it('flags an adapter that accepts an invalid size', async () => {
    const report = await runConformance(makeMockDriver({ acceptBadSize: true }), FAST)
    expect(statusOf(report.checks, 'reject-bad-size')).toBe('fail')
  })

  it('flags non-string ticket values (SDK would compute money)', async () => {
    const report = await runConformance(makeMockDriver({ numericRows: true }), FAST)
    expect(statusOf(report.checks, 'ticket-display-strings')).toBe('fail')
  })

  it('flags a fill that arrives after cancel', async () => {
    const report = await runConformance(makeMockDriver({ fillAfterCancel: true }), FAST)
    expect(statusOf(report.checks, 'cancel-postconfirm')).toBe('fail')
  })

  it('flags a malformed portfolio', async () => {
    const report = await runConformance(makeMockDriver({ brokenPortfolio: true }), FAST)
    expect(statusOf(report.checks, 'portfolio-shape')).toBe('fail')
  })
})

describe('conformance report rendering', () => {
  it('renders verdict, a row per check, and gap consequences', async () => {
    const report = await runConformance(makeMockDriver({ silentConfirm: true }), {
      ...FAST,
      now: '2026-07-15T00:00:00.000Z',
    })
    const md = renderConformanceReport(report)
    expect(md).toContain('# Hippo CTI Conformance — mock')
    expect(md).toContain('**Non-conformant**')
    expect(md).toContain('Confirm reaches a terminal lifecycle event')
    // failing check's consequence appears in the gaps section
    expect(md).toContain('the thread goes silent after handoff')
  })
})
