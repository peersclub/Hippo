/**
 * Suggestion-chip logic — pure, UI-free (the chip bar renders it).
 * The bar is CONTEXTUAL: after each answer, the server's own `followups`
 * from the most recent brief/decline replace the session-config chips.
 * The server still authors every string — the client only chooses which
 * server-sent list to draw (thin-client safe).
 */
import type { ThreadItem } from './state.js'

/** Hold a chip this long to EDIT it in the composer instead of sending. */
export const LONG_PRESS_MS = 450
/** Pointer travel beyond this cancels a press (the user is scrolling). */
export const PRESS_MOVE_SLOP_PX = 8

/** The chip list to show: the latest non-empty followups win; the session
 * config's suggested queries are the floor (and the empty-thread case). */
export function resolveChips(items: ThreadItem[], sessionChips: string[]): string[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind !== 'frame') continue
    const f = item.frame
    if ((f.type === 'research_brief' || f.type === 'advice_decline') && f.followups.length > 0) {
      return f.followups
    }
  }
  return sessionChips
}

/** Classify a completed press by duration: hold = edit, tap = send. */
export function pressAction(durationMs: number): 'send' | 'edit' {
  return durationMs >= LONG_PRESS_MS ? 'edit' : 'send'
}

/**
 * Roving-tabindex arrow navigation for the chip toolbar. Arrows wrap;
 * Left/Right invert under RTL so "forward" always follows reading order.
 * Unhandled keys return the current (clamped) index.
 */
export function roveIndex(current: number, count: number, key: string, rtl: boolean): number {
  if (count <= 0) return 0
  const cur = Math.min(Math.max(current, 0), count - 1)
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight'
  const backward = rtl ? 'ArrowRight' : 'ArrowLeft'
  if (key === forward) return (cur + 1) % count
  if (key === backward) return (cur - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return cur
}
