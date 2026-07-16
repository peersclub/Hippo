/**
 * End-user registry — lazily populated by the gateway on authenticated
 * session create. Only real venueUserIds land here; anonymous dev sessions
 * are ephemeral by design and never recorded.
 */
import type pg from 'pg'
import type { Page, UserRecord, UserStatus } from './types.js'

export type UserListOpts = {
  partnerId?: string
  /** Case-insensitive substring match on userId. */
  q?: string
  offset?: number
  limit?: number
}

export interface UserStore {
  upsertSeen(partnerId: string, userId: string, now?: number): Promise<UserRecord>
  get(partnerId: string, userId: string): Promise<UserRecord | undefined>
  list(opts: UserListOpts): Promise<Page<UserRecord>>
  setStatus(partnerId: string, userId: string, status: UserStatus): Promise<UserRecord | undefined>
}

const key = (partnerId: string, userId: string) => `${partnerId}:${userId}`

export class InMemoryUserStore implements UserStore {
  private users = new Map<string, UserRecord>()

  async upsertSeen(partnerId: string, userId: string, now = Date.now()): Promise<UserRecord> {
    const existing = this.users.get(key(partnerId, userId))
    const record: UserRecord = existing
      ? { ...existing, lastSeen: now }
      : { partnerId, userId, firstSeen: now, lastSeen: now, status: 'active' }
    this.users.set(key(partnerId, userId), record)
    return record
  }

  async get(partnerId: string, userId: string): Promise<UserRecord | undefined> {
    return this.users.get(key(partnerId, userId))
  }

  async list({ partnerId, q, offset = 0, limit = 50 }: UserListOpts): Promise<Page<UserRecord>> {
    const needle = q?.toLowerCase()
    const all = [...this.users.values()]
      .filter((u) => !partnerId || u.partnerId === partnerId)
      .filter((u) => !needle || u.userId.toLowerCase().includes(needle))
      .sort((a, b) => b.lastSeen - a.lastSeen)
    return { rows: all.slice(offset, offset + limit), total: all.length }
  }

  async setStatus(
    partnerId: string,
    userId: string,
    status: UserStatus,
  ): Promise<UserRecord | undefined> {
    const existing = this.users.get(key(partnerId, userId))
    if (!existing) return undefined
    const next = { ...existing, status }
    this.users.set(key(partnerId, userId), next)
    return next
  }
}

function rowToUser(r: Record<string, unknown>): UserRecord {
  return {
    partnerId: r.partner_id as string,
    userId: r.user_id as string,
    firstSeen: Number(r.first_seen),
    lastSeen: Number(r.last_seen),
    status: r.status as UserStatus,
  }
}

/** Escape LIKE wildcards so a literal % or _ in the query stays literal. */
function likeEscape(q: string): string {
  return q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

export class PostgresUserStore implements UserStore {
  constructor(private readonly pool: pg.Pool) {}

  async upsertSeen(partnerId: string, userId: string, now = Date.now()): Promise<UserRecord> {
    const res = await this.pool.query(
      `INSERT INTO users (partner_id, user_id, first_seen, last_seen, status)
       VALUES ($1, $2, $3, $3, 'active')
       ON CONFLICT (partner_id, user_id) DO UPDATE SET last_seen = $3
       RETURNING *`,
      [partnerId, userId, now],
    )
    return rowToUser(res.rows[0])
  }

  async get(partnerId: string, userId: string): Promise<UserRecord | undefined> {
    const res = await this.pool.query(
      'SELECT * FROM users WHERE partner_id = $1 AND user_id = $2',
      [partnerId, userId],
    )
    return res.rows[0] ? rowToUser(res.rows[0]) : undefined
  }

  async list({ partnerId, q, offset = 0, limit = 50 }: UserListOpts): Promise<Page<UserRecord>> {
    const conds: string[] = []
    const filterParams: unknown[] = []
    if (partnerId) {
      filterParams.push(partnerId)
      conds.push(`partner_id = $${filterParams.length}`)
    }
    if (q) {
      filterParams.push(`%${likeEscape(q)}%`)
      conds.push(`user_id ILIKE $${filterParams.length}`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

    const total = await this.pool.query(`SELECT count(*) FROM users ${where}`, filterParams)
    const rows = await this.pool.query(
      `SELECT * FROM users ${where} ORDER BY last_seen DESC
       LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
      [...filterParams, limit, offset],
    )
    return { rows: rows.rows.map(rowToUser), total: Number(total.rows[0].count) }
  }

  async setStatus(
    partnerId: string,
    userId: string,
    status: UserStatus,
  ): Promise<UserRecord | undefined> {
    const res = await this.pool.query(
      'UPDATE users SET status = $3 WHERE partner_id = $1 AND user_id = $2 RETURNING *',
      [partnerId, userId, status],
    )
    return res.rows[0] ? rowToUser(res.rows[0]) : undefined
  }
}
