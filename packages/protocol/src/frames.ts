import { z } from 'zod'
import { CAPABILITIES } from './orders.js'

/**
 * Card protocol v1 — DOWN frames (server → SDK).
 *
 * Rules:
 *  - Additive-only. Never remove or repurpose a field within v1.
 *  - Every frame carries an optional `fallback` so SDKs that don't know the
 *    type can still render something meaningful (prose + optional link).
 *  - Display strings are formatted server-side. The SDK draws; it never
 *    computes money.
 */

export const PROTOCOL_VERSION = 1

const base = {
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  fallback: z.object({ text: z.string(), href: z.string().url().optional() }).optional(),
}

export const StatCell = z.object({
  k: z.string(),
  v: z.string(),
  tone: z.enum(['pos', 'neg', 'neutral']).default('neutral'),
})

export const Sparkline = z.object({
  points: z.array(z.number()).min(2),
  captionLeft: z.string().optional(),
  captionRight: z.string().optional(),
})

export const LiveBar = z.object({
  asOf: z.string(), // display string, e.g. "AS OF 14:32:05 IST"
  asOfIso: z.string(),
  refreshable: z.boolean().default(true),
  shareable: z.boolean().default(true),
  feedback: z.boolean().default(true),
  cached: z.boolean().default(false),
  cacheAge: z.string().optional(), // e.g. "updated 6 min ago"
})

export const ResearchBriefFrame = z.object({
  ...base,
  type: z.literal('research_brief'),
  eyebrow: z.string(), // e.g. "MARKET BRIEF"
  live: z.boolean().default(false),
  headline: z.string(),
  paragraphs: z.array(z.string()),
  stats: z.array(StatCell).max(6).default([]),
  spark: Sparkline.optional(),
  sources: z.array(z.string()).default([]),
  liveBar: LiveBar.optional(),
  followups: z.array(z.string()).default([]),
  // Real model id (e.g. "anthropic/claude-haiku-4.5") that generated this
  // prose, or "mock" when the LLM was unreachable/unset. Absent on frames
  // that never call a model (degraded-mode, nudges, stopped streams).
  model: z.string().optional(),
  // Frame id of an earlier research_brief this one supersedes (additive,
  // July 2026 — the REFRESH re-run). SDKs that know the field update the
  // referenced card in place; older SDKs simply append, which stays correct.
  replaces: z.string().optional(),
})

export const OrderTicketFrame = z.object({
  ...base,
  type: z.literal('order_ticket'),
  ticketId: z.string(),
  title: z.string().default('Order prepared'),
  sideLabel: z.string(), // e.g. "BUY · MKT" or "LONG 13× · ISOLATED"
  side: z.enum(['buy', 'sell']),
  /** Which trade type this ticket is (spot default). Lets the SDK render
   * feature-aware chrome (leverage/direction, liquidation row) while the
   * money rows stay server-formatted. Additive — omitted reads as spot. */
  capability: z.enum(CAPABILITIES).optional(),
  rows: z.array(z.object({ label: z.string(), value: z.string() })).min(1),
  cta: z.string(), // e.g. "Review & confirm in Assetworks →"
  footnote: z.string(), // restates the seam
})

export const LifecycleFrame = z.object({
  ...base,
  type: z.literal('lifecycle'),
  ticketId: z.string(),
  phase: z.enum(['awaiting_confirm', 'filled', 'partial', 'cancelled', 'expired']),
  statusLine: z.string(), // e.g. "WAITING FOR YOUR CONFIRM ON KOINBX"
  venueOrderId: z.string().optional(),
  fillPct: z.number().min(0).max(100).optional(),
  rows: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
  cancellable: z.boolean().default(false),
})

export const AdviceDeclineFrame = z.object({
  ...base,
  type: z.literal('advice_decline'),
  badge: z.string().default('◇ NO ADVICE — BY DESIGN'),
  message: z.string(),
  pivotTitle: z.string(), // e.g. "What's true about BTC right now"
  facts: z.array(z.object({ icon: z.string(), text: z.string() })),
  followups: z.array(z.string()).default([]),
})

export const PositionsFrame = z.object({
  ...base,
  type: z.literal('positions'),
  rows: z.array(
    z.object({
      instrument: z.string(),
      size: z.string(),
      entry: z.string(),
      mark: z.string(),
      pnl: z.string(),
      tone: z.enum(['pos', 'neg', 'neutral']).default('neutral'),
    }),
  ),
})

export const RejectionTicketFrame = z.object({
  ...base,
  type: z.literal('rejection_ticket'),
  ticketId: z.string().optional(),
  title: z.string(),
  reason: z.string(), // plain words, never a bare error code
  fix: z.object({ label: z.string(), action: z.string() }).optional(),
})

export const ThinkingFrame = z.object({
  ...base,
  type: z.literal('thinking'),
  lines: z.array(z.string()).min(1), // rotating status lines, server-authored
})

export const SkeletonFrame = z.object({
  ...base,
  type: z.literal('skeleton'),
  shape: z.enum(['brief', 'ticket', 'positions']),
})

export const BannerFrame = z.object({
  ...base,
  type: z.literal('banner'),
  kind: z.enum(['degraded', 'offline', 'info']),
  title: z.string(),
  text: z.string(),
})

/**
 * Ambient market pulse (pill glow + mono event tag). Currently produced only
 * by the mock gateway and tests — the production gateway has no market
 * watcher yet, so no prod trader sees this frame. Documented decision, not
 * drift: the SDK surface stays wired so a gateway producer can ship without
 * an SDK release.
 */
export const PulseFrame = z.object({
  ...base,
  type: z.literal('pulse'),
  tag: z.string(), // e.g. "· BTC −4.2%"
})

export const OrdersSnapshotFrame = z.object({
  ...base,
  type: z.literal('orders_snapshot'),
  open: z.array(
    z.object({
      orderId: z.string(),
      side: z.enum(['buy', 'sell']),
      summary: z.string(), // mono pill text, e.g. "BUY 0.05 BTC · MKT"
      status: z.string(), // e.g. "FILLING 40%"
    }),
  ),
  positionsCount: z.number().int().nonnegative().default(0),
})

export const UserEchoFrame = z.object({
  ...base,
  type: z.literal('user_echo'),
  text: z.string(),
})

/**
 * Streaming research prose (additive, July 2026): while the research engine
 * generates, the gateway forwards readable prose chunks so the pending brief
 * fills in live instead of sitting on a skeleton. The SDK accumulates
 * consecutive brief_delta frames into one growing card; the eventual
 * research_brief frame is authoritative and REPLACES the accumulated text.
 * SDKs that predate this frame simply keep showing the skeleton until the
 * research_brief lands — graceful by construction, no fallback needed.
 */
export const BriefDeltaFrame = z.object({
  ...base,
  type: z.literal('brief_delta'),
  text: z.string(),
  // Same provenance contract as research_brief.model (additive, July 2026):
  // the id of the model generating THIS stream, or "mock". Carried on every
  // delta so the streaming card can show provenance before the final brief.
  model: z.string().optional(),
})

export const Frame = z.discriminatedUnion('type', [
  ResearchBriefFrame,
  OrderTicketFrame,
  LifecycleFrame,
  AdviceDeclineFrame,
  PositionsFrame,
  RejectionTicketFrame,
  ThinkingFrame,
  SkeletonFrame,
  BannerFrame,
  PulseFrame,
  OrdersSnapshotFrame,
  UserEchoFrame,
  BriefDeltaFrame,
])

/** Loose envelope: enough to render a FallbackCard for unknown future types. */
export const FrameEnvelope = z.object({ ...base, type: z.string() }).loose()

export type Frame = z.infer<typeof Frame>
export type FrameType = Frame['type']
export type ResearchBrief = z.infer<typeof ResearchBriefFrame>
export type OrderTicket = z.infer<typeof OrderTicketFrame>
export type Lifecycle = z.infer<typeof LifecycleFrame>
export type AdviceDecline = z.infer<typeof AdviceDeclineFrame>
export type Positions = z.infer<typeof PositionsFrame>
export type RejectionTicket = z.infer<typeof RejectionTicketFrame>
export type Thinking = z.infer<typeof ThinkingFrame>
export type Skeleton = z.infer<typeof SkeletonFrame>
export type Banner = z.infer<typeof BannerFrame>
export type Pulse = z.infer<typeof PulseFrame>
export type OrdersSnapshot = z.infer<typeof OrdersSnapshotFrame>
export type UserEcho = z.infer<typeof UserEchoFrame>
export type BriefDelta = z.infer<typeof BriefDeltaFrame>
export type UnknownFrame = z.infer<typeof FrameEnvelope>
