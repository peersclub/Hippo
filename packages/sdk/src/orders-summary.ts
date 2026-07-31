/**
 * Consolidated orders view — presentation logic for the `orders_summary` card
 * (the full answer to "show all my orders" / "orders this session"). Kept pure
 * and separate from the card component so the scope label, totals, newest-first
 * ordering and empty state are unit-testable, matching the codebase pattern
 * (draft.ts, lifecycle-view.ts). The card in cards.tsx only draws.
 */

import type { OrdersSummary } from '@hippo/protocol'
import type { MessageKey } from './i18n.js'

type Scope = OrdersSummary['scope']
type OrderRow = OrdersSummary['orders'][number]
type Totals = OrdersSummary['totals']

/** Card title key — the scope, spelled out. */
export function scopeLabelKey(scope: Scope): MessageKey {
  return scope === 'all' ? 'orders_summary_all' : 'orders_summary_session'
}

/** Honest empty-state key — scope-specific ("No orders yet" vs "…this session"). */
export function emptyLabelKey(scope: Scope): MessageKey {
  return scope === 'all' ? 'orders_summary_empty_all' : 'orders_summary_empty_session'
}

export type TotalCell = { key: MessageKey; value: number }

/** The compact header counts, in a fixed order (Working / Filled / Cancelled). */
export function totalCells(totals: Totals): TotalCell[] {
  return [
    { key: 'orders_total_working', value: totals.open },
    { key: 'orders_total_filled', value: totals.filled },
    { key: 'orders_total_cancelled', value: totals.cancelled },
  ]
}

/**
 * Rows newest-first. Sorts by `tsIso` descending when present; rows without a
 * timestamp keep the server's order (Array.prototype.sort is stable, and the
 * comparator returns 0 for any pair it can't compare). Never mutates the input.
 */
export function orderedRows(orders: OrderRow[]): OrderRow[] {
  return [...orders].sort((a, b) => {
    if (a.tsIso && b.tsIso) return a.tsIso < b.tsIso ? 1 : a.tsIso > b.tsIso ? -1 : 0
    return 0
  })
}

/** Whether to draw a fill bar for a row — only when the server set filledPct. */
export function hasFill(filledPct?: number): boolean {
  return typeof filledPct === 'number'
}
