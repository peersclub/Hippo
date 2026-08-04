/**
 * Clarification card logic — pure, UI-free (cards.tsx draws it).
 *
 * The server ASKS when it isn't sure enough to act: a `clarification` frame
 * carries a question and 2–4 SERVER-AUTHORED options. Every display string
 * here belongs to the server and is rendered VERBATIM — stop-line law, the
 * same posture as AlertFrame.conditionLabel. The SDK never invents an
 * interpretation, never re-words an option, and never decides what a pick
 * means; it sends back the option's ID and nothing else.
 *
 * Settling: the card is one-shot per clarification. The picked state lives in
 * a signal map (not card component state) so it survives minimize/reopen and a
 * journal replay after a reconnect, exactly like feedbackMap and
 * hostActionMap. A second tap on a settled card sends nothing — the gateway
 * would refuse a duplicate anyway, but the card must not even ask.
 */
import { signal } from '@preact/signals'

export type ClarificationState =
  /** No pick yet — options are tappable. */
  | { phase: 'open' }
  /** Send in flight for this optionId — everything is disabled. */
  | { phase: 'sending'; optionId: string }
  /** Picked and accepted; the label reads back on the card. */
  | { phase: 'picked'; optionId: string }
  /** The send never reached the gateway — nothing was decided, tap again. */
  | { phase: 'failed' }

/** Card state per clarification, keyed by clarificationId. */
export const clarificationMap = signal<Record<string, ClarificationState>>({})

export function clarificationState(clarificationId: string): ClarificationState {
  return clarificationMap.value[clarificationId] ?? { phase: 'open' }
}

function setState(clarificationId: string, state: ClarificationState): void {
  clarificationMap.value = { ...clarificationMap.value, [clarificationId]: state }
}

/** The uplink one option tap sends. IDs only: every display string was
 * server-authored, so nothing the SDK holds needs to travel back. */
export function clarificationChoiceUplink(
  clarificationId: string,
  optionId: string,
): { kind: 'clarification_choice'; clarificationId: string; optionId: string } {
  return { kind: 'clarification_choice', clarificationId, optionId }
}

/** True while the card still accepts a pick. A settled ('picked') card is
 * terminal; 'sending' is busy; 'failed' is retryable. */
export function isAnswerable(state: ClarificationState): boolean {
  return state.phase === 'open' || state.phase === 'failed'
}

/** The option a settled/settling card is showing back, if any. */
export function chosenOptionId(state: ClarificationState): string | null {
  return state.phase === 'picked' || state.phase === 'sending' ? state.optionId : null
}

/**
 * Pick one option: claim the card, send, settle.
 *
 * One-shot by construction — the answerable check happens BEFORE the state
 * flips, so a double-tap (or a tap while a send is in flight) resolves to
 * 'ignored' and sends nothing. A send that never lands leaves the card
 * answerable again with an honest failure, so the trader is never stranded
 * with a question they can't answer.
 *
 * Like the ticket and alert chips this rides transport `send` (live-only,
 * never the offline outbox): a clarification answered minutes later, unattended
 * and out of band, is exactly what the gateway's TTL exists to refuse.
 */
export async function pickOption(
  clarificationId: string,
  optionId: string,
  sender: (u: ReturnType<typeof clarificationChoiceUplink>) => Promise<boolean>,
): Promise<'sent' | 'failed' | 'ignored'> {
  if (!isAnswerable(clarificationState(clarificationId))) return 'ignored'
  setState(clarificationId, { phase: 'sending', optionId })
  const ok = await sender(clarificationChoiceUplink(clarificationId, optionId)).catch(() => false)
  if (!ok) {
    setState(clarificationId, { phase: 'failed' })
    return 'failed'
  }
  setState(clarificationId, { phase: 'picked', optionId })
  return 'sent'
}
