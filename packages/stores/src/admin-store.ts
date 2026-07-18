/**
 * Operator identity + audit trail for the admin panel. Password hashes are
 * scrypt (`salthex:keyhex`) — hashing itself lives in services/admin next to
 * login; these stores only ever see the hash.
 */
import type pg from 'pg'
import type { AuditEntry, OperatorRecord, OperatorRole, Page } from './types.js'

export interface OperatorStore {
  get(email: string): Promise<OperatorRecord | undefined>
  create(op: Omit<OperatorRecord, 'createdAt'>): Promise<OperatorRecord>
  list(): Promise<OperatorRecord[]>
  delete(email: string): Promise<boolean>
  count(): Promise<number>
}

export interface AuditStore {
  append(entry: Omit<AuditEntry, 'id' | 'ts'>): Promise<void>
  /** partnerId filters to entries whose detail.partnerId matches — the
   * partner portal's own-activity view. Omitted = the operator's full view. */
  list(opts: { offset?: number; limit?: number; partnerId?: string }): Promise<Page<AuditEntry>>
}

export class InMemoryOperatorStore implements OperatorStore {
  private ops = new Map<string, OperatorRecord>()

  async get(email: string): Promise<OperatorRecord | undefined> {
    return this.ops.get(email)
  }

  async create(op: Omit<OperatorRecord, 'createdAt'>): Promise<OperatorRecord> {
    if (this.ops.has(op.email)) throw new Error(`operator ${op.email} already exists`)
    const record: OperatorRecord = { ...op, createdAt: Date.now() }
    this.ops.set(record.email, record)
    return record
  }

  async list(): Promise<OperatorRecord[]> {
    return [...this.ops.values()].sort((a, b) => a.email.localeCompare(b.email))
  }

  async delete(email: string): Promise<boolean> {
    return this.ops.delete(email)
  }

  async count(): Promise<number> {
    return this.ops.size
  }
}

export class InMemoryAuditStore implements AuditStore {
  private entries: AuditEntry[] = []
  private nextId = 1

  async append(entry: Omit<AuditEntry, 'id' | 'ts'>): Promise<void> {
    this.entries.push({ ...entry, id: this.nextId++, ts: Date.now() })
  }

  async list({
    offset = 0,
    limit = 50,
    partnerId,
  }: {
    offset?: number
    limit?: number
    partnerId?: string
  }): Promise<Page<AuditEntry>> {
    // Tie-break on id so same-millisecond entries order like Postgres (ts DESC, id DESC).
    const filtered = partnerId
      ? this.entries.filter((e) => e.detail.partnerId === partnerId)
      : this.entries
    const sorted = [...filtered].sort((a, b) => b.ts - a.ts || b.id - a.id)
    return { rows: sorted.slice(offset, offset + limit), total: sorted.length }
  }
}

export class PostgresOperatorStore implements OperatorStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(email: string): Promise<OperatorRecord | undefined> {
    const res = await this.pool.query('SELECT * FROM admin_operators WHERE email = $1', [email])
    const r = res.rows[0]
    if (!r) return undefined
    return {
      email: r.email as string,
      passwordHash: r.password_hash as string,
      role: r.role as OperatorRole,
      createdAt: Number(r.created_at),
    }
  }

  async create(op: Omit<OperatorRecord, 'createdAt'>): Promise<OperatorRecord> {
    const record: OperatorRecord = { ...op, createdAt: Date.now() }
    await this.pool.query(
      'INSERT INTO admin_operators (email, password_hash, role, created_at) VALUES ($1, $2, $3, $4)',
      [record.email, record.passwordHash, record.role, record.createdAt],
    )
    return record
  }

  async list(): Promise<OperatorRecord[]> {
    const res = await this.pool.query('SELECT * FROM admin_operators ORDER BY email')
    return res.rows.map((r) => ({
      email: r.email as string,
      passwordHash: r.password_hash as string,
      role: r.role as OperatorRole,
      createdAt: Number(r.created_at),
    }))
  }

  async delete(email: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM admin_operators WHERE email = $1', [email])
    return (res.rowCount ?? 0) > 0
  }

  async count(): Promise<number> {
    const res = await this.pool.query('SELECT count(*) FROM admin_operators')
    return Number(res.rows[0].count)
  }
}

export class PostgresAuditStore implements AuditStore {
  constructor(private readonly pool: pg.Pool) {}

  async append(entry: Omit<AuditEntry, 'id' | 'ts'>): Promise<void> {
    await this.pool.query(
      'INSERT INTO admin_audit (operator_email, action, target, detail, ts) VALUES ($1, $2, $3, $4, $5)',
      [entry.operatorEmail, entry.action, entry.target, JSON.stringify(entry.detail), Date.now()],
    )
  }

  async list({
    offset = 0,
    limit = 50,
    partnerId,
  }: {
    offset?: number
    limit?: number
    partnerId?: string
  }): Promise<Page<AuditEntry>> {
    const where = partnerId ? "WHERE detail->>'partnerId' = $3" : ''
    const params: unknown[] = partnerId ? [limit, offset, partnerId] : [limit, offset]
    const rows = await this.pool.query(
      `SELECT * FROM admin_audit ${where} ORDER BY ts DESC, id DESC LIMIT $1 OFFSET $2`,
      params,
    )
    const total = await this.pool.query(
      partnerId
        ? "SELECT count(*) FROM admin_audit WHERE detail->>'partnerId' = $1"
        : 'SELECT count(*) FROM admin_audit',
      partnerId ? [partnerId] : [],
    )
    return {
      rows: rows.rows.map((r) => ({
        id: Number(r.id),
        operatorEmail: r.operator_email as string,
        action: r.action as string,
        target: r.target as string,
        detail: r.detail as Record<string, unknown>,
        ts: Number(r.ts),
      })),
      total: Number(total.rows[0].count),
    }
  }
}
