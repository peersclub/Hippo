/**
 * Alert card presentation logic — pure, UI-free (cards.tsx draws it).
 *
 * The server owns every alert fact: `conditionLabel` is server-authored and
 * rendered VERBATIM (the SDK never re-formats or recomputes a condition), and
 * state changes only arrive as fresh `alert` frames (the store collapses them
 * in place by alertId). The only thing the SDK ever says back is CANCEL — a
 * live-only alert_action uplink, mirroring the ticket-action chips.
 */
import type { MessageKey } from './i18n.js'

export type AlertState = 'armed' | 'triggered' | 'cancelled'

/** State badge label key — chrome, so it localizes with the panel. */
export const ALERT_STATE_KEY: Record<AlertState, MessageKey> = {
  armed: 'alert_state_armed',
  triggered: 'alert_state_triggered',
  cancelled: 'alert_state_cancelled',
}

/** Card state modifier: armed = amber pulse, triggered = up-accent,
 * cancelled = dim. Matches the .alertcard.* styles 1:1. */
export function alertStateClass(state: AlertState): string {
  return state
}

/** The CANCEL chip exists ONLY on armed cards — a triggered or cancelled
 * alert has nothing left to cancel. */
export function showCancelChip(state: AlertState): boolean {
  return state === 'armed'
}

/** The alert_action uplink the CANCEL chip sends (transport `send`, never the
 * outbox — cancelling an alert minutes later, unattended, is not acceptable). */
export function cancelAlertUplink(alertId: string): {
  kind: 'alert_action'
  alertId: string
  action: 'cancel'
} {
  return { kind: 'alert_action', alertId, action: 'cancel' }
}
