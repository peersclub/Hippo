import { z } from 'zod'

/** Card protocol v1 — UP messages (SDK → server). */

const base = {
  v: z.literal(1),
  sessionId: z.string().min(1),
  ts: z.number().int().nonnegative(),
}

export const UserTextUplink = z.object({
  ...base,
  kind: z.literal('user_text'),
  text: z.string().min(1).max(2000),
})

export const ChipTapUplink = z.object({
  ...base,
  kind: z.literal('chip_tap'),
  text: z.string().min(1),
})

export const TicketActionUplink = z.object({
  ...base,
  kind: z.literal('ticket_action'),
  ticketId: z.string(),
  action: z.enum(['confirm_handoff', 'cancel']),
})

export const FeedbackUplink = z.object({
  ...base,
  kind: z.literal('feedback'),
  frameId: z.string(),
  vote: z.enum(['up', 'down']),
  /** Maps 1:1 to eval scoring criteria — labels arrive pre-categorized. */
  reason: z.enum(['inaccurate', 'too_shallow', 'outdated']).optional(),
})

export const ConsentUplink = z.object({
  ...base,
  kind: z.literal('consent'),
  memoryOptIn: z.boolean(),
  l2Acknowledged: z.boolean(),
})

export const SettingsUplink = z.object({
  ...base,
  kind: z.literal('settings'),
  language: z.enum(['en', 'hi', 'hinglish', 'ar']).optional(),
  memoryOptIn: z.boolean().optional(),
  clearMemory: z.boolean().optional(),
})

export const Uplink = z.discriminatedUnion('kind', [
  UserTextUplink,
  ChipTapUplink,
  TicketActionUplink,
  FeedbackUplink,
  ConsentUplink,
  SettingsUplink,
])

export type Uplink = z.infer<typeof Uplink>
export type UplinkKind = Uplink['kind']
