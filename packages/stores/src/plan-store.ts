/**
 * Plan store — B2B tiers partners subscribe to. Deleting a plan while any
 * partner is assigned to it is refused at the store layer (both impls), so
 * route handlers cannot forget the check.
 */
import type pg from 'pg'
import type { PlanCreate, PlanRecord, PlanUpdate } from './types.js'

export interface PlanStore {
  get(planId: string): Promise<PlanRecord | undefined>
  list(): Promise<PlanRecord[]>
  create(plan: PlanCreate): Promise<PlanRecord>
  update(planId: string, update: PlanUpdate): Promise<PlanRecord | undefined>
  /** Throws if any partner is currently assigned to the plan. */
  delete(planId: string): Promise<boolean>
}

export class InMemoryPlanStore implements PlanStore {
  private plans = new Map<string, PlanRecord>()

  /** Partner-assignment lookup injected to enforce delete safety. */
  constructor(
    private readonly isAssigned: (planId: string) => Promise<boolean> = async () => false,
  ) {}

  async get(planId: string): Promise<PlanRecord | undefined> {
    return this.plans.get(planId)
  }

  async list(): Promise<PlanRecord[]> {
    return [...this.plans.values()].sort((a, b) => a.planId.localeCompare(b.planId))
  }

  async create(plan: PlanCreate): Promise<PlanRecord> {
    if (this.plans.has(plan.planId)) throw new Error(`plan ${plan.planId} already exists`)
    const record: PlanRecord = { ...plan, createdAt: Date.now() }
    this.plans.set(record.planId, record)
    return record
  }

  async update(planId: string, update: PlanUpdate): Promise<PlanRecord | undefined> {
    const existing = this.plans.get(planId)
    if (!existing) return undefined
    const next = { ...existing, ...update }
    this.plans.set(planId, next)
    return next
  }

  async delete(planId: string): Promise<boolean> {
    if (!this.plans.has(planId)) return false
    if (await this.isAssigned(planId)) throw new Error(`plan ${planId} is assigned to a partner`)
    return this.plans.delete(planId)
  }
}

function rowToPlan(r: Record<string, unknown>): PlanRecord {
  return {
    planId: r.plan_id as string,
    name: r.name as string,
    tier: r.tier as string,
    mauQuota: r.mau_quota === null ? null : Number(r.mau_quota),
    priceMonthlyUsd: r.price_monthly_usd === null ? null : Number(r.price_monthly_usd),
    entitlements: r.entitlements as Record<string, unknown>,
    createdAt: Number(r.created_at),
  }
}

export class PostgresPlanStore implements PlanStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(planId: string): Promise<PlanRecord | undefined> {
    const res = await this.pool.query('SELECT * FROM plans WHERE plan_id = $1', [planId])
    return res.rows[0] ? rowToPlan(res.rows[0]) : undefined
  }

  async list(): Promise<PlanRecord[]> {
    const res = await this.pool.query('SELECT * FROM plans ORDER BY plan_id')
    return res.rows.map(rowToPlan)
  }

  async create(plan: PlanCreate): Promise<PlanRecord> {
    const record: PlanRecord = { ...plan, createdAt: Date.now() }
    await this.pool.query(
      `INSERT INTO plans (plan_id, name, tier, mau_quota, price_monthly_usd, entitlements, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.planId,
        record.name,
        record.tier,
        record.mauQuota,
        record.priceMonthlyUsd,
        JSON.stringify(record.entitlements),
        record.createdAt,
      ],
    )
    return record
  }

  async update(planId: string, update: PlanUpdate): Promise<PlanRecord | undefined> {
    const existing = await this.get(planId)
    if (!existing) return undefined
    const next = { ...existing, ...update }
    await this.pool.query(
      `UPDATE plans SET name = $2, tier = $3, mau_quota = $4, price_monthly_usd = $5, entitlements = $6
       WHERE plan_id = $1`,
      [
        planId,
        next.name,
        next.tier,
        next.mauQuota,
        next.priceMonthlyUsd,
        JSON.stringify(next.entitlements),
      ],
    )
    return next
  }

  async delete(planId: string): Promise<boolean> {
    const assigned = await this.pool.query('SELECT 1 FROM partners WHERE plan_id = $1 LIMIT 1', [
      planId,
    ])
    if (assigned.rows.length > 0) throw new Error(`plan ${planId} is assigned to a partner`)
    const res = await this.pool.query('DELETE FROM plans WHERE plan_id = $1', [planId])
    return (res.rowCount ?? 0) > 0
  }
}
