/**
 * Feedback state machine — pure, UI-free (the live-bar renders it).
 * Baseline §6: 👍 thanks instantly; 👎 asks ONE follow-up with three reason
 * chips. These three labels map 1:1 to the eval-harness scoring criteria,
 * so feedback labels arrive pre-categorized for the harness via Layer 2 —
 * the front end's direct contribution to the IP.
 */

import type { MessageKey } from './i18n.js'

export type FeedbackReason = 'inaccurate' | 'too_shallow' | 'outdated'

/** Reason CHIPS carry catalog keys, never words — the card localizes them at
 * render. The `reason` values are the wire enum and stay English. */
export const FEEDBACK_REASONS: ReadonlyArray<{ reason: FeedbackReason; labelKey: MessageKey }> = [
  { reason: 'inaccurate', labelKey: 'feedback_reason_inaccurate' },
  { reason: 'too_shallow', labelKey: 'feedback_reason_shallow' },
  { reason: 'outdated', labelKey: 'feedback_reason_outdated' },
]

export type FeedbackState =
  | { phase: 'idle' } // 👍/👎 visible
  | { phase: 'thanked' } // after 👍 — "THANKS"
  | { phase: 'asking' } // after 👎 — "What was off?" + reason chips
  | { phase: 'noted'; withReason: boolean } // collapsed — "NOTED — THANKS" / "NOTED"

export type FeedbackEvent =
  | { type: 'vote'; vote: 'up' | 'down' }
  | { type: 'reason'; reason: FeedbackReason }
  | { type: 'skip' }

/** Uplink payload the caller should send (frameId is stamped by the caller). */
export type FeedbackUplinkPayload = { vote: 'up' | 'down'; reason?: FeedbackReason }

export type FeedbackTransition = { state: FeedbackState; uplink?: FeedbackUplinkPayload }

/**
 * Reduce one event. Invalid events for the current phase are no-ops (never
 * throw, never double-send). A 👎 sends the vote-only uplink immediately —
 * the reason chip fires a SECOND uplink carrying the reason; "skip" sends
 * nothing further because the initial vote already went.
 */
export function feedbackTransition(state: FeedbackState, event: FeedbackEvent): FeedbackTransition {
  switch (state.phase) {
    case 'idle':
      if (event.type === 'vote') {
        return event.vote === 'up'
          ? { state: { phase: 'thanked' }, uplink: { vote: 'up' } }
          : { state: { phase: 'asking' }, uplink: { vote: 'down' } }
      }
      return { state }
    case 'asking':
      if (event.type === 'reason') {
        return {
          state: { phase: 'noted', withReason: true },
          uplink: { vote: 'down', reason: event.reason },
        }
      }
      if (event.type === 'skip') return { state: { phase: 'noted', withReason: false } }
      return { state }
    default:
      // thanked / noted are terminal — feedback is one-shot per brief.
      return { state }
  }
}

/** Collapsed label for terminal states — a catalog key, localized by the card. */
export function feedbackDoneKey(state: FeedbackState): MessageKey | null {
  if (state.phase === 'thanked') return 'feedback_thanks'
  if (state.phase === 'noted') return state.withReason ? 'feedback_noted_thanks' : 'feedback_noted'
  return null
}
