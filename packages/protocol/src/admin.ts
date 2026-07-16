/**
 * Admin-panel wire contract: request bodies the admin service validates and
 * the record shapes apps/admin renders. Kept beside frames/uplinks so there
 * is exactly one source of truth for every wire surface in the system.
 */
import { z } from 'zod'

export const PlanBody = z.object({
  planId: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(80),
  tier: z.string().min(1).max(40),
  mauQuota: z.number().int().positive().nullable(),
  priceMonthlyUsd: z.number().nonnegative().nullable(),
  entitlements: z.record(z.string(), z.unknown()).default({}),
})
export type PlanBody = z.infer<typeof PlanBody>

export const PlanPatch = PlanBody.omit({ planId: true }).partial()
export type PlanPatch = z.infer<typeof PlanPatch>

export const PartnerBody = z.object({
  partnerId: z.string().regex(/^[a-z0-9-]{2,40}$/),
  partnerKey: z.string().regex(/^pk_[A-Za-z0-9_-]{2,60}$/),
  jwtSecret: z.string().min(8).max(200),
  venueName: z.string().min(1).max(80),
  locales: z.array(z.string().min(2).max(10)).default(['en']),
  suggestedQueries: z.array(z.string().min(1).max(200)).max(8).default([]),
  planId: z.string().nullable().optional(),
})
export type PartnerBody = z.infer<typeof PartnerBody>

export const PartnerPatch = PartnerBody.omit({ partnerId: true, partnerKey: true })
  .partial()
  .omit({ planId: true })
export type PartnerPatch = z.infer<typeof PartnerPatch>

export const AssignPlanBody = z.object({ planId: z.string().nullable() })
export type AssignPlanBody = z.infer<typeof AssignPlanBody>

export const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
})
export type LoginBody = z.infer<typeof LoginBody>

/** Admin persona edit — superset of the end-user PersonaUpdate: the panel may
 * also set experienceLevel directly (no user-facing write path exists). */
export const PersonaAdminUpdate = z.object({
  optIn: z.boolean().optional(),
  experienceLevel: z.enum(['new', 'intermediate', 'pro']).nullable().optional(),
  followAsset: z
    .string()
    .regex(/^[A-Za-z]{2,10}$/)
    .optional(),
  openThread: z
    .object({ text: z.string().min(1).max(300), symbol: z.string().optional() })
    .optional(),
})
export type PersonaAdminUpdate = z.infer<typeof PersonaAdminUpdate>
