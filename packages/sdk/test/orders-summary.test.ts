import { describe, expect, it } from 'vitest'
import type { OrdersSummary } from '@hippo/protocol'
import {
  emptyLabelKey,
  hasFill,
  orderedRows,
  scopeLabelKey,
  totalCells,
} from '../src/orders-summary.js'

type OrderRow = OrdersSummary['orders'][number]

const row = (extra: Partial<OrderRow>): OrderRow => ({
  orderId: 'o1',
  symbol: 'BTC/USDT',
  side: 'buy',
  kind: 'MKT',
  qty: '0.05',
  status: 'WORKING',
  ...extra,
})

describe('scope + empty labels', () => {
  it('titles the card by scope', () => {
    expect(scopeLabelKey('all')).toBe('orders_summary_all')
    expect(scopeLabelKey('session')).toBe('orders_summary_session')
  })
  it('picks a scope-specific honest empty state', () => {
    expect(emptyLabelKey('all')).toBe('orders_summary_empty_all')
    expect(emptyLabelKey('session')).toBe('orders_summary_empty_session')
  })
})

describe('totalCells', () => {
  it('maps totals to Working / Filled / Cancelled in order', () => {
    expect(totalCells({ open: 3, filled: 5, cancelled: 1 })).toEqual([
      { key: 'orders_total_working', value: 3 },
      { key: 'orders_total_filled', value: 5 },
      { key: 'orders_total_cancelled', value: 1 },
    ])
  })
})

describe('orderedRows — newest-first', () => {
  it('sorts by tsIso descending', () => {
    const rows = [
      row({ orderId: 'old', tsIso: '2026-07-01T00:00:00Z' }),
      row({ orderId: 'new', tsIso: '2026-07-31T00:00:00Z' }),
      row({ orderId: 'mid', tsIso: '2026-07-15T00:00:00Z' }),
    ]
    expect(orderedRows(rows).map((r) => r.orderId)).toEqual(['new', 'mid', 'old'])
  })
  it('keeps server order for rows without a timestamp and never mutates input', () => {
    const rows = [row({ orderId: 'a' }), row({ orderId: 'b' })]
    expect(orderedRows(rows).map((r) => r.orderId)).toEqual(['a', 'b'])
    expect(rows.map((r) => r.orderId)).toEqual(['a', 'b'])
  })
})

describe('hasFill — fill bar only when filledPct is set', () => {
  it('true for any numeric percent, including 0 and 100', () => {
    expect(hasFill(0)).toBe(true)
    expect(hasFill(40)).toBe(true)
    expect(hasFill(100)).toBe(true)
  })
  it('false when absent', () => {
    expect(hasFill(undefined)).toBe(false)
  })
})
