/**
 * Partner-staff identities for the partner portal. Same Postgres-or-memory
 * seam as every other store. Lookups by invite-token HASH only — the
 * plaintext token never reaches a store.
 */
import type pg from 'pg'
import type { PartnerAdminRecord, PartnerAdminRole } from './types.js'

export interface PartnerAdminStore {
  get(email: string): Promise<PartnerAdminRecord | undefined>
  getByInviteTokenHash(hash: string): Promise<PartnerAdminRecord | undefined>
  listByPartner(partnerId: string): Promise<PartnerAdminRecord[]>
  create(admin: Omit<PartnerAdminRecord, 'createdAt' | 'passwordHash'>): Promise<PartnerAdminRecord>
  /** Claim: set the password and burn the invite token. */
  setPassword(email: string, passwordHash: string): Promise<PartnerAdminRecord | undefined>
  delete(email: string): Promise<boolean>
}

export class InMemoryPartnerAdminStore implements PartnerAdminStore {
  private admins = new Map<string, PartnerAdminRecord>()

  async get(email: string): Promise<PartnerAdminRecord | undefined> {
    return this.admins.get(email)
  }

  async getByInviteTokenHash(hash: string): Promise<PartnerAdminRecord | undefined> {
    for (const a of this.admins.values()) if (a.inviteTokenHash === hash) return a
    return undefined
  }

  async listByPartner(partnerId: string): Promise<PartnerAdminRecord[]> {
    return [...this.admins.values()]
      .filter((a) => a.partnerId === partnerId)
      .sort((a, b) => a.email.localeCompare(b.email))
  }

  async create(
    admin: Omit<PartnerAdminRecord, 'createdAt' | 'passwordHash'>,
  ): Promise<PartnerAdminRecord> {
    if (this.admins.has(admin.email)) throw new Error(`partner admin ${admin.email} already exists`)
    const record: PartnerAdminRecord = { ...admin, passwordHash: null, createdAt: Date.now() }
    this.admins.set(record.email, record)
    return record
  }

  async setPassword(email: string, passwordHash: string): Promise<PartnerAdminRecord | undefined> {
    const existing = this.admins.get(email)
    if (!existing) return undefined
    const updated: PartnerAdminRecord = {
      ...existing,
      passwordHash,
      inviteTokenHash: null,
      inviteExpiresAt: null,
    }
    this.admins.set(email, updated)
    return updated
  }

  async delete(email: string): Promise<boolean> {
    return this.admins.delete(email)
  }
}

function rowToRecord(r: Record<string, unknown>): PartnerAdminRecord {
  return {
    email: r.email as string,
    partnerId: r.partner_id as string,
    passwordHash: (r.password_hash as string | null) ?? null,
    role: r.role as PartnerAdminRole,
    inviteTokenHash: (r.invite_token_hash as string | null) ?? null,
    inviteExpiresAt: r.invite_expires_at === null ? null : Number(r.invite_expires_at),
    createdAt: Number(r.created_at),
  }
}

export class PostgresPartnerAdminStore implements PartnerAdminStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(email: string): Promise<PartnerAdminRecord | undefined> {
    const res = await this.pool.query('SELECT * FROM partner_admins WHERE email = $1', [email])
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined
  }

  async getByInviteTokenHash(hash: string): Promise<PartnerAdminRecord | undefined> {
    const res = await this.pool.query('SELECT * FROM partner_admins WHERE invite_token_hash = $1', [
      hash,
    ])
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined
  }

  async listByPartner(partnerId: string): Promise<PartnerAdminRecord[]> {
    const res = await this.pool.query(
      'SELECT * FROM partner_admins WHERE partner_id = $1 ORDER BY email',
      [partnerId],
    )
    return res.rows.map(rowToRecord)
  }

  async create(
    admin: Omit<PartnerAdminRecord, 'createdAt' | 'passwordHash'>,
  ): Promise<PartnerAdminRecord> {
    const record: PartnerAdminRecord = { ...admin, passwordHash: null, createdAt: Date.now() }
    await this.pool.query(
      `INSERT INTO partner_admins
         (email, partner_id, password_hash, role, invite_token_hash, invite_expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.email,
        record.partnerId,
        record.passwordHash,
        record.role,
        record.inviteTokenHash,
        record.inviteExpiresAt,
        record.createdAt,
      ],
    )
    return record
  }

  async setPassword(email: string, passwordHash: string): Promise<PartnerAdminRecord | undefined> {
    const res = await this.pool.query(
      `UPDATE partner_admins
         SET password_hash = $2, invite_token_hash = NULL, invite_expires_at = NULL
       WHERE email = $1 RETURNING *`,
      [email, passwordHash],
    )
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined
  }

  async delete(email: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM partner_admins WHERE email = $1', [email])
    return (res.rowCount ?? 0) > 0
  }
}
