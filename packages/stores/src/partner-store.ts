/**
 * Partner registry store — the `partners` table the gateway's auth.ts always
 * anticipated. In-memory impl seeds the koinbx-dev partner so dev and tests
 * run unchanged without Postgres.
 */
import type pg from 'pg'
import type { PartnerCreate, PartnerRecord, PartnerStatus, PartnerUpdate } from './types.js'

export interface PartnerStore {
  get(partnerId: string): Promise<PartnerRecord | undefined>
  getByKey(partnerKey: string): Promise<PartnerRecord | undefined>
  list(): Promise<PartnerRecord[]>
  create(partner: PartnerCreate): Promise<PartnerRecord>
  update(partnerId: string, update: PartnerUpdate): Promise<PartnerRecord | undefined>
  setStatus(partnerId: string, status: PartnerStatus): Promise<PartnerRecord | undefined>
  assignPlan(partnerId: string, planId: string | null): Promise<PartnerRecord | undefined>
}

/** The dev partner the gateway has always shipped with. */
export function devPartner(): PartnerRecord {
  return {
    partnerId: 'koinbx-dev',
    partnerKey: 'pk_demo',
    jwtSecret: process.env.KOINBX_DEV_JWT_SECRET ?? 'koinbx-dev-secret-not-for-production',
    venueName: 'KoinBX',
    locales: ['en', 'hi', 'hinglish'],
    suggestedQueries: [
      "What's driving SOL volume?",
      'My positions & P&L',
      'ETH funding rate',
      'Explain liquidations',
    ],
    planId: null,
    status: 'active',
    createdAt: 0,
  }
}

export class InMemoryPartnerStore implements PartnerStore {
  private partners = new Map<string, PartnerRecord>()

  constructor(seed: PartnerRecord[] = [devPartner()]) {
    for (const p of seed) this.partners.set(p.partnerId, p)
  }

  async get(partnerId: string): Promise<PartnerRecord | undefined> {
    return this.partners.get(partnerId)
  }

  async getByKey(partnerKey: string): Promise<PartnerRecord | undefined> {
    for (const p of this.partners.values()) if (p.partnerKey === partnerKey) return p
    return undefined
  }

  async list(): Promise<PartnerRecord[]> {
    return [...this.partners.values()].sort((a, b) => a.partnerId.localeCompare(b.partnerId))
  }

  async create(partner: PartnerCreate): Promise<PartnerRecord> {
    if (this.partners.has(partner.partnerId))
      throw new Error(`partner ${partner.partnerId} already exists`)
    if (await this.getByKey(partner.partnerKey))
      throw new Error(`partner key ${partner.partnerKey} already in use`)
    const record: PartnerRecord = {
      ...partner,
      planId: partner.planId ?? null,
      status: partner.status ?? 'active',
      createdAt: Date.now(),
    }
    this.partners.set(record.partnerId, record)
    return record
  }

  async update(partnerId: string, update: PartnerUpdate): Promise<PartnerRecord | undefined> {
    const existing = this.partners.get(partnerId)
    if (!existing) return undefined
    const next = { ...existing, ...update }
    this.partners.set(partnerId, next)
    return next
  }

  async setStatus(partnerId: string, status: PartnerStatus): Promise<PartnerRecord | undefined> {
    const existing = this.partners.get(partnerId)
    if (!existing) return undefined
    const next = { ...existing, status }
    this.partners.set(partnerId, next)
    return next
  }

  async assignPlan(partnerId: string, planId: string | null): Promise<PartnerRecord | undefined> {
    const existing = this.partners.get(partnerId)
    if (!existing) return undefined
    const next = { ...existing, planId }
    this.partners.set(partnerId, next)
    return next
  }
}

function rowToPartner(r: Record<string, unknown>): PartnerRecord {
  return {
    partnerId: r.partner_id as string,
    partnerKey: r.partner_key as string,
    jwtSecret: r.jwt_secret as string,
    venueName: r.venue_name as string,
    locales: r.locales as string[],
    suggestedQueries: r.suggested_queries as string[],
    planId: (r.plan_id as string | null) ?? null,
    status: r.status as PartnerStatus,
    createdAt: Number(r.created_at),
  }
}

export class PostgresPartnerStore implements PartnerStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(partnerId: string): Promise<PartnerRecord | undefined> {
    const res = await this.pool.query('SELECT * FROM partners WHERE partner_id = $1', [partnerId])
    return res.rows[0] ? rowToPartner(res.rows[0]) : undefined
  }

  async getByKey(partnerKey: string): Promise<PartnerRecord | undefined> {
    const res = await this.pool.query('SELECT * FROM partners WHERE partner_key = $1', [partnerKey])
    return res.rows[0] ? rowToPartner(res.rows[0]) : undefined
  }

  async list(): Promise<PartnerRecord[]> {
    const res = await this.pool.query('SELECT * FROM partners ORDER BY partner_id')
    return res.rows.map(rowToPartner)
  }

  async create(partner: PartnerCreate): Promise<PartnerRecord> {
    const record: PartnerRecord = {
      ...partner,
      planId: partner.planId ?? null,
      status: partner.status ?? 'active',
      createdAt: Date.now(),
    }
    await this.pool.query(
      `INSERT INTO partners (partner_id, partner_key, jwt_secret, venue_name, locales, suggested_queries, plan_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.partnerId,
        record.partnerKey,
        record.jwtSecret,
        record.venueName,
        JSON.stringify(record.locales),
        JSON.stringify(record.suggestedQueries),
        record.planId,
        record.status,
        record.createdAt,
      ],
    )
    return record
  }

  async update(partnerId: string, update: PartnerUpdate): Promise<PartnerRecord | undefined> {
    const existing = await this.get(partnerId)
    if (!existing) return undefined
    const next = { ...existing, ...update }
    await this.pool.query(
      `UPDATE partners SET jwt_secret = $2, venue_name = $3, locales = $4, suggested_queries = $5
       WHERE partner_id = $1`,
      [
        partnerId,
        next.jwtSecret,
        next.venueName,
        JSON.stringify(next.locales),
        JSON.stringify(next.suggestedQueries),
      ],
    )
    return next
  }

  async setStatus(partnerId: string, status: PartnerStatus): Promise<PartnerRecord | undefined> {
    const res = await this.pool.query(
      'UPDATE partners SET status = $2 WHERE partner_id = $1 RETURNING *',
      [partnerId, status],
    )
    return res.rows[0] ? rowToPartner(res.rows[0]) : undefined
  }

  async assignPlan(partnerId: string, planId: string | null): Promise<PartnerRecord | undefined> {
    const res = await this.pool.query(
      'UPDATE partners SET plan_id = $2 WHERE partner_id = $1 RETURNING *',
      [partnerId, planId],
    )
    return res.rows[0] ? rowToPartner(res.rows[0]) : undefined
  }
}
