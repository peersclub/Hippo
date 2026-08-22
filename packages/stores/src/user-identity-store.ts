/**
 * In-panel username + PIN identity (migration 015, demo-grade). Usernames are
 * unique per partner, case-insensitively; the PIN is stored scrypt-hashed
 * (password.ts `salthex:keyhex`), never in plaintext. `user_identity_links`
 * maps a host/cookie user (the session's sub) to its claimed identity so the
 * same browser auto-restores it at the next session start.
 */
import type pg from 'pg'

/** The list API's bound — an operator review surface, not an export. */
export const IDENTITIES_LIST_CAP = 200

export type UserIdentity = {
  partnerId: string
  /** Case-insensitive uniqueness key — always username.toLowerCase(). */
  usernameLower: string
  /** Display casing as first claimed. */
  username: string
  /** scrypt `salthex:keyhex` (password.ts). Never a raw PIN. */
  pinHash: string
  createdAt: number
  lastSeenAt: number
}

export interface UserIdentityStore {
  /** Claim a username. Returns the identity, or null when already taken. */
  create(partnerId: string, username: string, pinHash: string): Promise<UserIdentity | null>
  get(partnerId: string, usernameLower: string): Promise<UserIdentity | undefined>
  /** Refresh last_seen_at (signin / session restore). */
  touch(partnerId: string, usernameLower: string, now?: number): Promise<void>
  /** Upsert the sub→identity link (one link per sub; a re-claim replaces it). */
  link(partnerId: string, sub: string, usernameLower: string): Promise<void>
  unlink(partnerId: string, sub: string): Promise<void>
  /** The identity linked to this sub, or undefined when none/orphaned. */
  linkedIdentity(partnerId: string, sub: string): Promise<UserIdentity | undefined>
  /** A partner's identities, most recently seen first, bounded (default
   * IDENTITIES_LIST_CAP) — the operator read. */
  listByPartner(partnerId: string, limit?: number): Promise<UserIdentity[]>
  /** GDPR purge: hard-delete one identity AND every sub→identity link pointing
   * at it, so no browser can auto-restore the erased identity. Returns rows
   * removed (identity + links). */
  deleteByUser(partnerId: string, usernameLower: string): Promise<number>
}

const key = (partnerId: string, id: string) => `${partnerId}:${id}`

export class InMemoryUserIdentityStore implements UserIdentityStore {
  private identities = new Map<string, UserIdentity>()
  private links = new Map<string, string>() // partnerId:sub → usernameLower

  async create(partnerId: string, username: string, pinHash: string): Promise<UserIdentity | null> {
    const usernameLower = username.toLowerCase()
    if (this.identities.has(key(partnerId, usernameLower))) return null
    const now = Date.now()
    const identity: UserIdentity = {
      partnerId,
      usernameLower,
      username,
      pinHash,
      createdAt: now,
      lastSeenAt: now,
    }
    this.identities.set(key(partnerId, usernameLower), identity)
    return identity
  }

  async get(partnerId: string, usernameLower: string): Promise<UserIdentity | undefined> {
    return this.identities.get(key(partnerId, usernameLower))
  }

  async touch(partnerId: string, usernameLower: string, now = Date.now()): Promise<void> {
    const identity = this.identities.get(key(partnerId, usernameLower))
    if (identity) identity.lastSeenAt = now
  }

  async link(partnerId: string, sub: string, usernameLower: string): Promise<void> {
    this.links.set(key(partnerId, sub), usernameLower)
  }

  async unlink(partnerId: string, sub: string): Promise<void> {
    this.links.delete(key(partnerId, sub))
  }

  async linkedIdentity(partnerId: string, sub: string): Promise<UserIdentity | undefined> {
    const usernameLower = this.links.get(key(partnerId, sub))
    return usernameLower ? this.identities.get(key(partnerId, usernameLower)) : undefined
  }

  async listByPartner(partnerId: string, limit = IDENTITIES_LIST_CAP): Promise<UserIdentity[]> {
    return [...this.identities.values()]
      .filter((i) => i.partnerId === partnerId)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, limit)
      .map((i) => ({ ...i }))
  }

  async deleteByUser(partnerId: string, usernameLower: string): Promise<number> {
    let n = 0
    for (const [k, linked] of this.links) {
      if (k.startsWith(`${partnerId}:`) && linked === usernameLower) {
        this.links.delete(k)
        n += 1
      }
    }
    if (this.identities.delete(key(partnerId, usernameLower))) n += 1
    return n
  }
}

function rowToIdentity(r: Record<string, unknown>): UserIdentity {
  return {
    partnerId: r.partner_id as string,
    usernameLower: r.username_lower as string,
    username: r.username as string,
    pinHash: r.pin_hash as string,
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
  }
}

export class PostgresUserIdentityStore implements UserIdentityStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(partnerId: string, username: string, pinHash: string): Promise<UserIdentity | null> {
    // ON CONFLICT DO NOTHING makes the claim race-safe: whoever inserts first
    // owns the name; the loser sees no row back and reports "taken".
    const now = Date.now()
    const res = await this.pool.query(
      `INSERT INTO user_identities (partner_id, username_lower, username, pin_hash, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (partner_id, username_lower) DO NOTHING
       RETURNING *`,
      [partnerId, username.toLowerCase(), username, pinHash, now],
    )
    return res.rows[0] ? rowToIdentity(res.rows[0]) : null
  }

  async get(partnerId: string, usernameLower: string): Promise<UserIdentity | undefined> {
    const res = await this.pool.query(
      'SELECT * FROM user_identities WHERE partner_id = $1 AND username_lower = $2',
      [partnerId, usernameLower],
    )
    return res.rows[0] ? rowToIdentity(res.rows[0]) : undefined
  }

  async touch(partnerId: string, usernameLower: string, now = Date.now()): Promise<void> {
    await this.pool.query(
      'UPDATE user_identities SET last_seen_at = $3 WHERE partner_id = $1 AND username_lower = $2',
      [partnerId, usernameLower, now],
    )
  }

  async link(partnerId: string, sub: string, usernameLower: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_identity_links (partner_id, sub, username_lower)
       VALUES ($1, $2, $3)
       ON CONFLICT (partner_id, sub) DO UPDATE SET username_lower = EXCLUDED.username_lower`,
      [partnerId, sub, usernameLower],
    )
  }

  async unlink(partnerId: string, sub: string): Promise<void> {
    await this.pool.query('DELETE FROM user_identity_links WHERE partner_id = $1 AND sub = $2', [
      partnerId,
      sub,
    ])
  }

  async linkedIdentity(partnerId: string, sub: string): Promise<UserIdentity | undefined> {
    const res = await this.pool.query(
      `SELECT i.* FROM user_identity_links l
       JOIN user_identities i
         ON i.partner_id = l.partner_id AND i.username_lower = l.username_lower
       WHERE l.partner_id = $1 AND l.sub = $2`,
      [partnerId, sub],
    )
    return res.rows[0] ? rowToIdentity(res.rows[0]) : undefined
  }

  async listByPartner(partnerId: string, limit = IDENTITIES_LIST_CAP): Promise<UserIdentity[]> {
    const res = await this.pool.query(
      `SELECT * FROM user_identities
       WHERE partner_id = $1
       ORDER BY last_seen_at DESC
       LIMIT $2`,
      [partnerId, limit],
    )
    return res.rows.map(rowToIdentity)
  }

  async deleteByUser(partnerId: string, usernameLower: string): Promise<number> {
    // Links first, then the identity — the same erase is complete either way,
    // but this order never leaves a link pointing at a deleted identity.
    const links = await this.pool.query(
      'DELETE FROM user_identity_links WHERE partner_id = $1 AND username_lower = $2',
      [partnerId, usernameLower],
    )
    const identity = await this.pool.query(
      'DELETE FROM user_identities WHERE partner_id = $1 AND username_lower = $2',
      [partnerId, usernameLower],
    )
    return (links.rowCount ?? 0) + (identity.rowCount ?? 0)
  }
}
