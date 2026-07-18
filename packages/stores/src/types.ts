/**
 * Domain records for admin-managed entities.
 *
 * PartnerRecord is a superset of the gateway's PartnerConfig — same embed/auth
 * fields, plus the plan/status columns the admin panel manages. The gateway
 * consumes PartnerRecord directly (it ignores the extra fields), so swapping
 * its hardcoded PARTNERS array for a PartnerStore is type-compatible.
 */

/** sandbox = self-provisioned via `hippo register`, not yet operator-approved
 * for production; behaves like active for session mint, excluded from quota
 * alerts, and visually distinct in the panel. Going active is operator-gated. */
export type PartnerStatus = 'active' | 'suspended' | 'sandbox'

export type PartnerRecord = {
  partnerId: string
  /** Public embed key the loader ships with (`data-hippo-key`). */
  partnerKey: string
  /** HS256 shared secret for partner-signed JWTs. */
  jwtSecret: string
  venueName: string
  locales: string[]
  suggestedQueries: string[]
  /** Assigned plan; null = unassigned (no quota enforcement). */
  planId: string | null
  status: PartnerStatus
  createdAt: number
}

export type PartnerCreate = Omit<PartnerRecord, 'createdAt' | 'status' | 'planId'> &
  Partial<Pick<PartnerRecord, 'status' | 'planId'>>

export type PartnerUpdate = Partial<
  Pick<PartnerRecord, 'jwtSecret' | 'venueName' | 'locales' | 'suggestedQueries'>
>

export type PlanRecord = {
  planId: string
  name: string
  /** Free-form tier label ("pilot", "growth", "enterprise"). */
  tier: string
  /** Monthly-active-user ceiling; null = unlimited. */
  mauQuota: number | null
  priceMonthlyUsd: number | null
  /** Feature flags the gateway passes through to session config. */
  entitlements: Record<string, unknown>
  createdAt: number
}

export type PlanCreate = Omit<PlanRecord, 'createdAt'>
export type PlanUpdate = Partial<Omit<PlanRecord, 'planId' | 'createdAt'>>

export type UserStatus = 'active' | 'blocked'

/**
 * Lazily-populated end-user registry: one row per authenticated venueUserId,
 * upserted by the gateway on session create. Anonymous dev sessions are
 * deliberately never recorded — they are ephemeral by design.
 */
export type UserRecord = {
  partnerId: string
  userId: string
  firstSeen: number
  lastSeen: number
  status: UserStatus
}

export type Page<T> = { rows: T[]; total: number }

export type OperatorRole = 'owner' | 'operator'

export type OperatorRecord = {
  email: string
  /** scrypt hash, `salthex:keyhex` — never a plaintext password. */
  passwordHash: string
  role: OperatorRole
  createdAt: number
}

export type AuditEntry = {
  id: number
  operatorEmail: string
  action: string
  target: string
  detail: Record<string, unknown>
  ts: number
}
