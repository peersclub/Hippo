/**
 * Implicit misunderstanding signals (migration 018) — the accuracy evidence a
 * trader hands us for free when the classifier misreads them: a rapid
 * rephrase, an abandoned order ticket, a dismissed draft, a thumbs-down joined
 * to the intent we assigned. Detection lives in the gateway
 * (services/gateway/src/accuracy-signals.ts); this store is the durable record
 * behind the operator read and the eval export.
 *
 * PRIVACY. `originalText` is real trader text and is OPTIONAL by design — the
 * recorder drops it for anyone who turned auto-learning off (the
 * users_memory.learn_opt_out flag from migration 012), keeping the count and
 * discarding the words. Both implementations additionally clamp whatever they
 * are handed to INTENT_SIGNAL_TEXT_CAP characters, so no code path can widen
 * the retention envelope by accident.
 */
import type pg from 'pg'

/** The four implicit signals. A closed set: each one is a distinct,
 * independently-interpretable piece of evidence, and the export's row shape
 * names it verbatim. */
export const INTENT_SIGNAL_KINDS = [
  'rephrase',
  'ticket_abandoned',
  'draft_dismissed',
  'negative_feedback',
] as const

export type IntentSignalKind = (typeof INTENT_SIGNAL_KINDS)[number]

/** Hard bound on stored trader text — enough to review a misread question,
 * far short of a transcript. Applied in BOTH store implementations. */
export const INTENT_SIGNAL_TEXT_CAP = 280

/** The list API's bound — an operator review surface, not a dump. */
export const INTENT_SIGNALS_LIST_CAP = 100

export type IntentSignal = {
  id: string
  partnerId: string
  /** Effective per-user key at signal time (identity-aware, like memory). */
  userKey: string
  sessionId?: string
  signal: IntentSignalKind
  /** The trader text we may have misread. ABSENT when the user opted out of
   * learning — the signal still counts, the words are not retained. */
  originalText?: string
  /** The intent we assigned to that text, when we had one. */
  classifiedIntent?: string
  confidence?: number
  /** Non-text context: gap timings, order side/instrument, feedback reason. */
  detail?: Record<string, unknown>
  createdAt: number
}

export type IntentSignalQuery = {
  partnerId: string
  limit?: number
  /** Only signals recorded at/after this epoch-ms. */
  since?: number
  signal?: IntentSignalKind
}

export type IntentSignalSummary = {
  total: number
  /** Count per signal — every kind present, including honest zeros. */
  bySignal: Record<IntentSignalKind, number>
  /** Count per classified intent (rows we never classified are omitted). */
  byIntent: Record<string, number>
}

export interface IntentSignalStore {
  /** Persist one signal. Idempotent per id. */
  record(signal: IntentSignal): Promise<void>
  /** Recent signals for a partner, newest first, bounded. */
  list(query: IntentSignalQuery): Promise<IntentSignal[]>
  /** Counts by signal and by classified intent — the "Understanding" tiles. */
  summary(partnerId: string): Promise<IntentSignalSummary>
}

/** Bound trader text to INTENT_SIGNAL_TEXT_CAP; '' and undefined both mean
 * "no text retained" so an empty string can never masquerade as evidence. */
export function clampSignalText(text: string | undefined): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, INTENT_SIGNAL_TEXT_CAP)
}

function emptyBySignal(): Record<IntentSignalKind, number> {
  return { rephrase: 0, ticket_abandoned: 0, draft_dismissed: 0, negative_feedback: 0 }
}

/** Fold rows into the summary shape. Shared by both implementations so the
 * in-memory and Postgres surfaces can never drift. Pure. */
export function summarize(rows: IntentSignal[]): IntentSignalSummary {
  const bySignal = emptyBySignal()
  const byIntent: Record<string, number> = {}
  for (const row of rows) {
    bySignal[row.signal] += 1
    if (row.classifiedIntent)
      byIntent[row.classifiedIntent] = (byIntent[row.classifiedIntent] ?? 0) + 1
  }
  return { total: rows.length, bySignal, byIntent }
}

export class InMemoryIntentSignalStore implements IntentSignalStore {
  private signals = new Map<string, IntentSignal>()

  async record(signal: IntentSignal): Promise<void> {
    if (this.signals.has(signal.id)) return
    const { originalText: _raw, ...rest } = signal
    const text = clampSignalText(signal.originalText)
    this.signals.set(signal.id, { ...rest, ...(text !== undefined ? { originalText: text } : {}) })
  }

  private rowsFor(partnerId: string): IntentSignal[] {
    return [...this.signals.values()]
      .filter((s) => s.partnerId === partnerId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async list(query: IntentSignalQuery): Promise<IntentSignal[]> {
    const { partnerId, limit = INTENT_SIGNALS_LIST_CAP, since, signal } = query
    return this.rowsFor(partnerId)
      .filter(
        (s) => (since === undefined || s.createdAt >= since) && (!signal || s.signal === signal),
      )
      .slice(0, limit)
      .map((s) => ({ ...s }))
  }

  async summary(partnerId: string): Promise<IntentSignalSummary> {
    return summarize(this.rowsFor(partnerId))
  }
}

function rowToSignal(r: Record<string, unknown>): IntentSignal {
  return {
    id: r.id as string,
    partnerId: r.partner_id as string,
    userKey: r.user_key as string,
    ...(r.session_id != null ? { sessionId: r.session_id as string } : {}),
    signal: r.signal as IntentSignalKind,
    ...(r.original_text != null ? { originalText: r.original_text as string } : {}),
    ...(r.classified_intent != null ? { classifiedIntent: r.classified_intent as string } : {}),
    ...(r.confidence != null ? { confidence: Number(r.confidence) } : {}),
    ...(r.detail != null ? { detail: r.detail as Record<string, unknown> } : {}),
    createdAt: Number(r.created_at),
  }
}

export class PostgresIntentSignalStore implements IntentSignalStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(signal: IntentSignal): Promise<void> {
    await this.pool.query(
      `INSERT INTO intent_signals
         (id, partner_id, user_key, session_id, signal, original_text,
          classified_intent, confidence, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        signal.id,
        signal.partnerId,
        signal.userKey,
        signal.sessionId ?? null,
        signal.signal,
        clampSignalText(signal.originalText) ?? null,
        signal.classifiedIntent ?? null,
        signal.confidence ?? null,
        signal.detail ? JSON.stringify(signal.detail) : null,
        signal.createdAt,
      ],
    )
  }

  async list(query: IntentSignalQuery): Promise<IntentSignal[]> {
    const { partnerId, limit = INTENT_SIGNALS_LIST_CAP, since, signal } = query
    const res = await this.pool.query(
      `SELECT * FROM intent_signals
       WHERE partner_id = $1
         AND ($2::bigint IS NULL OR created_at >= $2)
         AND ($3::text IS NULL OR signal = $3)
       ORDER BY created_at DESC
       LIMIT $4`,
      [partnerId, since ?? null, signal ?? null, limit],
    )
    return res.rows.map(rowToSignal)
  }

  async summary(partnerId: string): Promise<IntentSignalSummary> {
    // Two grouped counts in one round trip — the table is small and the
    // (partner_id, created_at) index covers the scan.
    const res = await this.pool.query(
      `SELECT signal, classified_intent, count(*)::int AS n
       FROM intent_signals
       WHERE partner_id = $1
       GROUP BY signal, classified_intent`,
      [partnerId],
    )
    const bySignal = emptyBySignal()
    const byIntent: Record<string, number> = {}
    let total = 0
    for (const row of res.rows as Array<{
      signal: IntentSignalKind
      classified_intent: string | null
      n: number
    }>) {
      total += row.n
      bySignal[row.signal] += row.n
      if (row.classified_intent) {
        byIntent[row.classified_intent] = (byIntent[row.classified_intent] ?? 0) + row.n
      }
    }
    return { total, bySignal, byIntent }
  }
}
