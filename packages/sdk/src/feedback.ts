/**
 * Feedback state machine — pure, UI-free (the live-bar renders it).
 * Baseline §6: 👍 thanks instantly; 👎 asks ONE follow-up with three reason
 * chips. These three labels map 1:1 to the eval-harness scoring criteria,
 * so feedback labels arrive pre-categorized for the harness via Layer 2 —
 * the front end's direct contribution to the IP.
 */

export type FeedbackReason = 'inaccurate' | 'too_shallow' | 'outdated'

export const FEEDBACK_REASONS: ReadonlyArray<{ reason: FeedbackReason; label: string }> = [
  { reason: 'inaccurate', label: 'Inaccurate' },
  { reason: 'too_shallow', label: 'Too shallow' },
  { reason: 'outdated', label: 'Outdated' },
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

/** Collapsed label for terminal states. */
export function feedbackDoneLabel(state: FeedbackState): string | null {
  if (state.phase === 'thanked') return 'THANKS'
  if (state.phase === 'noted') return state.withReason ? 'NOTED — THANKS' : 'NOTED'
  return null
}
