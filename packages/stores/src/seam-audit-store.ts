/**
 * Seam audit trail — the durable home (migration 013) for the compliance
 * record the seam used to keep only in memory. The seam mints `ts` and the
 * idempotency key on the trade path and writes fire-and-forget: an audit
 * write must never block or fail an order, so `append` takes the finished
 * entry verbatim and the caller handles rejection by logging, not throwing.
 */
import type pg from 'pg'
import type { Page, SeamAuditEntry, SeamAuditKind } from './types.js'

/** In-memory tail cap — mirrors the seam's historical MAX_AUDIT_ENTRIES: a
 * steady-state pod without Postgres must not grow with order flow. */
const MAX_SEAM_AUDIT_ENTRIES = 5_000

export interface SeamAuditStore {
  append(entry: Omit<SeamAuditEntry, 'id'>): Promise<void>
  /** ticketId filters to one order's lifecycle; omitted = the full trail.
   * Rows come back newest first (ts DESC, id DESC), like admin_audit. */
  list(opts: { offset?: number; limit?: number; ticketId?: string }): Promise<Page<SeamAuditEntry>>
}

export class InMemorySeamAuditStore implements SeamAuditStore {
  private entries: SeamAuditEntry[] = []
  private nextId = 1

  async append(entry: Omit<SeamAuditEntry, 'id'>): Promise<void> {
    this.entries.push({ ...entry, id: this.nextId++ })
    if (this.entries.length > MAX_SEAM_AUDIT_ENTRIES) this.entries.shift()
  }

  async list({
    offset = 0,
    limit = 50,
    ticketId,
  }: {
    offset?: number
    limit?: number
    ticketId?: string
  }): Promise<Page<SeamAuditEntry>> {
    // Tie-break on id so same-millisecond entries order like Postgres (ts DESC, id DESC).
    const filtered = ticketId ? this.entries.filter((e) => e.ticketId === ticketId) : this.entries
    const sorted = [...filtered].sort((a, b) => b.ts - a.ts || b.id - a.id)
    return { rows: sorted.slice(offset, offset + limit), total: sorted.length }
  }
}

export class PostgresSeamAuditStore implements SeamAuditStore {
  constructor(private readonly pool: pg.Pool) {}

  async append(entry: Omit<SeamAuditEntry, 'id'>): Promise<void> {
    await this.pool.query(
      'INSERT INTO seam_audit (ts, kind, ticket_id, idempotency_key, detail) VALUES ($1, $2, $3, $4, $5)',
      [entry.ts, entry.kind, entry.ticketId, entry.idempotencyKey, entry.detail ?? null],
    )
  }

  async list({
    offset = 0,
    limit = 50,
    ticketId,
  }: {
    offset?: number
    limit?: number
    ticketId?: string
  }): Promise<Page<SeamAuditEntry>> {
    const where = ticketId ? 'WHERE ticket_id = $3' : ''
    const params: unknown[] = ticketId ? [limit, offset, ticketId] : [limit, offset]
    const rows = await this.pool.query(
      `SELECT * FROM seam_audit ${where} ORDER BY ts DESC, id DESC LIMIT $1 OFFSET $2`,
      params,
    )
    const total = await this.pool.query(
      ticketId
        ? 'SELECT count(*) FROM seam_audit WHERE ticket_id = $1'
        : 'SELECT count(*) FROM seam_audit',
      ticketId ? [ticketId] : [],
    )
    return {
      rows: rows.rows.map((r) => ({
        id: Number(r.id),
        ts: Number(r.ts),
        kind: r.kind as SeamAuditKind,
        ticketId: r.ticket_id as string,
        idempotencyKey: r.idempotency_key as string,
        ...(r.detail == null ? {} : { detail: r.detail as string }),
      })),
      total: Number(total.rows[0].count),
    }
  }
}
