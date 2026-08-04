/**
 * Implicit misunderstanding signals — the accuracy evidence we were throwing
 * away.
 *
 * When the classifier misreads a trader, the trader tells us: immediately,
 * implicitly, for free. Four tells, all of them already flowing through the
 * gateway and none of them previously recorded:
 *
 *   rephrase          a second `user_text` within REPHRASE_WINDOW_MS of a turn
 *                     that was CLASSIFIED and ANSWERED. Not a signal after a
 *                     clarification, a decline, or an unclassified nudge —
 *                     there the system already said "I'm not sure", so asking
 *                     again is the flow working, not evidence against it.
 *   ticket_abandoned  we prepared an order ticket and the trader cancelled it
 *                     BEFORE confirming — nothing reached the venue. Evidence
 *                     the order intent was misparsed (side/size/instrument).
 *   draft_dismissed   the same for the editable order draft.
 *   negative_feedback the existing thumbs-down uplink, finally JOINED to the
 *                     intent we assigned that turn (it used to be a bare
 *                     counter with no idea what we thought the user wanted).
 *
 * SOURCE OF TRUTH. Everything is derived from the session's frame journal —
 * the same log `assembleHistory` reads. No parallel per-turn bookkeeping, so
 * there is nothing to keep in sync and a cold-resumed session (journal
 * replayed from Redis) detects exactly what a live one does. The one coupling
 * to respect: `onUserText` MUST be called BEFORE the turn's own `user_echo` is
 * emitted, so the journal's last exchange is still the PREVIOUS turn. Called
 * later it degrades to "no signal", never to a false one.
 *
 * ANSWER DETECTION IS AN ALLOWLIST (`ANSWER_FRAMES`) on purpose: a frame type
 * nobody has written yet — a clarification card, say — is NOT an answer until
 * someone adds it here, so a new orchestrator branch can never silently
 * manufacture rephrase signals.
 *
 * PRIVACY / RETENTION. `originalText` is real trader text. Three rules:
 *   1. The learn opt-out wins. A trader who turned auto-learning off
 *      (users_memory.learn_opt_out, migration 012 — the same
 *      `persona.learnOptOut` flag `learnFromTurn` checks) has their text
 *      dropped here. The signal is still counted: the tally is operational
 *      truth, the words are not ours to keep. If the persona read fails we
 *      cannot CONFIRM consent, so the text is dropped then too.
 *   2. Bounded — INTENT_SIGNAL_TEXT_CAP (280) chars, enforced again in the
 *      store. Enough to review a misread question, never a transcript.
 *   3. Scoped — text is stored for these four signals and nothing else. The
 *      second (rephrased) message is never stored; only the text we may have
 *      misread, which is the only text an eval row needs.
 *
 * Recording is fire-and-forget: a turn never waits on it and never fails
 * because of it. Failures are LOGGED (`log.warn`) rather than swallowed —
 * silent fire-and-forget is how this codebase has hidden bugs before.
 */
import { randomUUID } from 'node:crypto'
import {
  clampSignalText,
  type IntentSignal,
  type IntentSignalKind,
  type IntentSignalStore,
  type IntentSignalSummary,
} from '@hippo/stores'
import { userKey } from './orchestrator/index.js'
import type { MemoryClient } from './orchestrator/memory.js'
import type { DraftFields, Session } from './plugins/auth.js'
import type { JournalEntry } from './plugins/sse.js'

/** A second question this soon after an answered turn reads as a rephrase, not
 * a new thought. Deliberately short: past ~25s the trader has read the answer,
 * and "ask a follow-up" is the product working. */
export const REPHRASE_WINDOW_MS = 25_000

/** Frame types that ANSWER a turn. Allowlist — see the module docstring. */
const ANSWER_FRAMES: ReadonlySet<string> = new Set([
  'research_brief',
  'order_ticket',
  'order_draft',
  'positions',
  'orders_summary',
  'alert',
  'host_action',
  'lifecycle',
])

/** Frame types that explicitly did NOT answer: the no-advice decline, any
 * honest rejection, and a clarification card (a turn that ASKED rather than
 * answered — asking again is then expected, not evidence). */
const NON_ANSWER_FRAMES: ReadonlySet<string> = new Set([
  'advice_decline',
  'rejection_ticket',
  'clarification',
])

export type TurnOutcome =
  /** At least one answer frame and nothing that contradicts it. */
  | 'answered'
  /** We declined or rejected. */
  | 'declined'
  /** We asked the trader something back instead of answering. */
  | 'clarified'
  /** Nothing conclusive landed (in-flight turn, nudge, banner-only). */
  | 'none'

/** One exchange as the journal recorded it: what the trader said, when, what
 * we classified it as, and how the turn ended. */
export type TurnRecord = {
  text: string
  /** Emit timestamp of the `user_echo` — when the turn arrived. */
  ts: number
  /** The classifier's verdict, from the `interpretation` frame. Absent when
   * the turn never got that far (smalltalk / low-confidence nudge). */
  intent?: string
  outcome: TurnOutcome
}

/** Group a journal into per-turn frame runs, each starting at a `user_echo`.
 * Frames before the first echo (orders_snapshot, identity…) are dropped. Pure. */
function splitExchanges(entries: JournalEntry[]): JournalEntry[][] {
  const groups: JournalEntry[][] = []
  for (const entry of entries) {
    if (entry.frame.type === 'user_echo') {
      groups.push([entry])
      continue
    }
    groups[groups.length - 1]?.push(entry)
  }
  return groups
}

/** Fold one exchange's frames into a TurnRecord. Pure. */
function toTurnRecord(group: JournalEntry[]): TurnRecord | null {
  const first = group[0]
  const echo = first?.frame as ({ type: string; ts: number; text?: string } & object) | undefined
  if (echo?.type !== 'user_echo' || typeof echo.text !== 'string') return null
  let intent: string | undefined
  let answered = false
  let declined = false
  let clarified = false
  for (const { frame } of group.slice(1)) {
    const f = frame as { type: string } & Record<string, unknown>
    if (f.type === 'interpretation' && typeof f.intent === 'string') intent = f.intent
    else if (f.type === 'clarification') clarified = true
    else if (NON_ANSWER_FRAMES.has(f.type)) declined = true
    else if (ANSWER_FRAMES.has(f.type)) answered = true
  }
  const outcome: TurnOutcome = clarified
    ? 'clarified'
    : declined
      ? 'declined'
      : answered
        ? 'answered'
        : 'none'
  return { text: echo.text, ts: echo.ts, ...(intent ? { intent } : {}), outcome }
}

/** Every completed exchange in the journal, oldest first. Pure. */
export function turnsFromJournal(entries: JournalEntry[]): TurnRecord[] {
  const out: TurnRecord[] = []
  for (const group of splitExchanges(entries)) {
    const record = toTurnRecord(group)
    if (record) out.push(record)
  }
  return out
}

/** The most recent exchange — the PREVIOUS turn when called before this
 * turn's echo is emitted. Pure. */
export function previousTurn(entries: JournalEntry[]): TurnRecord | null {
  const turns = turnsFromJournal(entries)
  return turns[turns.length - 1] ?? null
}

/** The turn that produced a matching frame (newest first) — how a ticket
 * cancel or a thumbs-down finds the question behind it. Pure. */
export function turnContaining(
  entries: JournalEntry[],
  match: (frame: Record<string, unknown>) => boolean,
): TurnRecord | null {
  const groups = splitExchanges(entries)
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]
    if (!group) continue
    if (group.some((e) => match(e.frame as unknown as Record<string, unknown>))) {
      return toTurnRecord(group)
    }
  }
  return null
}

/**
 * Is a new user_text at `at` a rapid rephrase of `prev`? Only when the
 * previous turn was CLASSIFIED (we committed to a reading) and ANSWERED (we
 * acted on it) and the trader came back inside the window. A clarification, a
 * decline or an unclassified nudge all mean the system already flagged its own
 * uncertainty — asking again there is the flow working. Pure.
 */
export function isRapidRephrase(
  prev: TurnRecord | null,
  at: number,
  windowMs: number = REPHRASE_WINDOW_MS,
): boolean {
  if (prev?.outcome !== 'answered' || !prev.intent) return false
  const gap = at - prev.ts
  return gap >= 0 && gap <= windowMs
}

// ── eval export ────────────────────────────────────────────────────────────

/**
 * One JSONL row in the eval harness's shape (evals/queries/*.jsonl).
 * `expected_intent` is ALWAYS null: this is observed production confusion, not
 * labeled truth — a human reviews the row and fills the label in before it
 * becomes a test case. `category: 'observed'` marks the provenance so a
 * promoted row is never confused with a hand-written one.
 */
export type EvalRow = {
  text: string
  lang?: string
  category: 'observed'
  expected_intent: null
  observed_intent: string | null
  signal: IntentSignalKind
}

/** Signals → eval rows. Rows without retained text (opted-out users) are
 * DROPPED: a row with no question is not a test case. Pure. */
export function toEvalRows(signals: IntentSignal[]): EvalRow[] {
  const rows: EvalRow[] = []
  for (const s of signals) {
    if (!s.originalText) continue
    const lang = s.detail?.lang
    rows.push({
      text: s.originalText,
      ...(typeof lang === 'string' && lang ? { lang } : {}),
      category: 'observed',
      expected_intent: null,
      observed_intent: s.classifiedIntent ?? null,
      signal: s.signal,
    })
  }
  return rows
}

/** JSONL body (trailing newline, one object per line). Pure. */
export function toJsonl(rows: EvalRow[]): string {
  return rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : ''
}

/** Sum per-partner summaries into the cross-partner view. Pure. */
export function mergeSummaries(summaries: IntentSignalSummary[]): IntentSignalSummary {
  const merged: IntentSignalSummary = {
    total: 0,
    bySignal: { rephrase: 0, ticket_abandoned: 0, draft_dismissed: 0, negative_feedback: 0 },
    byIntent: {},
  }
  for (const s of summaries) {
    merged.total += s.total
    for (const kind of Object.keys(merged.bySignal) as IntentSignalKind[]) {
      merged.bySignal[kind] += s.bySignal[kind] ?? 0
    }
    for (const [intent, n] of Object.entries(s.byIntent)) {
      merged.byIntent[intent] = (merged.byIntent[intent] ?? 0) + n
    }
  }
  return merged
}

// ── recorder ───────────────────────────────────────────────────────────────

type Log = {
  warn: (obj: object, msg?: string) => void
}

export type AccuracySignalsDeps = {
  store: IntentSignalStore
  /** Persona reader — ONLY used for the learn opt-out gate (migration 012).
   * A `Pick` on purpose: this module has no business with anything else in
   * memory. */
  memory: Pick<MemoryClient, 'get'>
  log: Log
  /** Clock override (tests). */
  now?: () => number
  /** Rephrase window override (tests). */
  rephraseWindowMs?: number
}

/** The orchestrator's whole surface onto this module: four void hooks. Each
 * one is synchronous at the call site (it snapshots what it needs from the
 * live session) and defers the write. */
export type AccuracySignals = {
  /** A `user_text` uplink arrived. Call BEFORE emitting its `user_echo`. */
  onUserText(session: Session, text: string): void
  /** A prepared ticket was cancelled pre-confirm. Call BEFORE the ticket is
   * removed from `session.tickets` — the quote is the evidence. */
  onTicketCancelled(session: Session, ticketId: string): void
  /** An interactive order draft was dismissed. */
  onDraftDismissed(session: Session, draftId: string, fields?: DraftFields): void
  /** A feedback uplink arrived; only thumbs-DOWN is a signal. */
  onFeedback(session: Session, feedback: { frameId: string; vote: string; reason?: string }): void
}

export function createAccuracySignals(deps: AccuracySignalsDeps): AccuracySignals {
  const { store, memory, log } = deps
  const now = deps.now ?? Date.now
  const rephraseWindowMs = deps.rephraseWindowMs ?? REPHRASE_WINDOW_MS

  /**
   * The retention gate. Returns the bounded text only when we can CONFIRM the
   * trader hasn't opted out of learning; `undefined` otherwise (opted out, or
   * the persona read failed and consent is unknown). The signal is recorded
   * either way — this decides the words, never the count.
   */
  async function retainableText(session: Session, text?: string): Promise<string | undefined> {
    const bounded = clampSignalText(text)
    if (!bounded) return undefined
    let persona: Awaited<ReturnType<MemoryClient['get']>> = null
    try {
      persona = await memory.get(session.partner.partnerId, userKey(session))
    } catch {
      return undefined // memory unreachable — consent unconfirmed, keep nothing
    }
    // null = memory service down (it answers a DEFAULT persona for an unseen
    // user, so null is never "no record"). Same fail-closed choice.
    if (persona === null || persona.learnOptOut === true) return undefined
    return bounded
  }

  function write(
    session: Session,
    signal: IntentSignalKind,
    fields: {
      text?: string
      intent?: string
      confidence?: number
      detail?: Record<string, unknown>
    },
  ): void {
    void (async () => {
      try {
        const originalText = await retainableText(session, fields.text)
        const detail = {
          ...(fields.detail ?? {}),
          ...(session.language ? { lang: session.language } : {}),
        }
        await store.record({
          id: `is_${randomUUID()}`,
          partnerId: session.partner.partnerId,
          userKey: userKey(session),
          sessionId: session.id,
          signal,
          ...(originalText ? { originalText } : {}),
          ...(fields.intent ? { classifiedIntent: fields.intent } : {}),
          ...(fields.confidence !== undefined ? { confidence: fields.confidence } : {}),
          ...(Object.keys(detail).length ? { detail } : {}),
          createdAt: now(),
        })
      } catch (err) {
        // Visible, never silent: a fire-and-forget that swallows its own
        // failures is how this surface would rot without anyone noticing.
        log.warn({ err, signal, sessionId: session.id }, 'intent signal not recorded')
      }
    })()
  }

  return {
    onUserText(session, _text) {
      const prev = previousTurn(session.journal.after(0))
      if (!prev || !isRapidRephrase(prev, now(), rephraseWindowMs)) return
      // The stored text is the PREVIOUS (possibly misread) question — the one
      // an eval row needs. The rephrase itself is never stored.
      write(session, 'rephrase', {
        text: prev.text,
        ...(prev.intent ? { intent: prev.intent } : {}),
        detail: { gapMs: now() - prev.ts },
      })
    },

    onTicketCancelled(session, ticketId) {
      const quote = session.tickets.get(ticketId)
      const turn = turnContaining(
        session.journal.after(0),
        (f) => f.type === 'order_ticket' && f.ticketId === ticketId,
      )
      write(session, 'ticket_abandoned', {
        ...(turn ? { text: turn.text } : {}),
        intent: turn?.intent ?? 'action',
        detail: {
          ticketId,
          ...(quote ? { side: quote.side, instrument: quote.instrument } : {}),
          ...(quote ? { size: quote.sizeDisplay } : {}),
        },
      })
    },

    onDraftDismissed(session, draftId, fields) {
      const turn = turnContaining(
        session.journal.after(0),
        (f) => f.type === 'order_draft' && f.draftId === draftId,
      )
      // The draft carries the originating turn text verbatim; the journal is
      // the fallback when the draft aged out of the session map.
      const text = fields?.userText ?? turn?.text
      write(session, 'draft_dismissed', {
        ...(text ? { text } : {}),
        intent: turn?.intent ?? 'action',
        detail: {
          draftId,
          ...(fields ? { side: fields.side, capability: fields.capability } : {}),
          ...(fields?.direction ? { direction: fields.direction } : {}),
        },
      })
    },

    onFeedback(session, feedback) {
      if (feedback.vote !== 'down') return
      // Join the vote to the turn that produced the frame — the whole point:
      // a thumbs-down means nothing without the reading we committed to.
      const turn = turnContaining(session.journal.after(0), (f) => f.id === feedback.frameId)
      write(session, 'negative_feedback', {
        ...(turn ? { text: turn.text } : {}),
        ...(turn?.intent ? { intent: turn.intent } : {}),
        detail: {
          frameId: feedback.frameId,
          ...(feedback.reason ? { reason: feedback.reason } : {}),
        },
      })
    },
  }
}
