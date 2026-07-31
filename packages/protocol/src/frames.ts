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

/**
 * Interactive order DRAFT (additive, July 2026) — the editable stage BEFORE a
 * ticket. Where OrderTicketFrame is a display-only prepared quote, the draft
 * carries NUMERIC fields + venue bounds so the SDK can render real controls:
 * a leverage slider (bounded by maxLeverage), a price input (market/limit),
 * and symbol / order-type / margin-mode dropdowns. The trader edits, then
 * submits via the draft_action uplink; the gateway re-validates against venue
 * capabilities and runs the normal prepare → order_ticket → confirm flow.
 * Money/size stay strings (protocol law); bounds are numbers because they
 * parameterize controls, not money. Old SDKs render this via FallbackCard.
 */
export const OrderDraftFrame = z.object({
  ...base,
  type: z.literal('order_draft'),
  draftId: z.string(),
  capability: z.enum(['spot', 'futures_perp']),
  title: z.string(), // server-authored, e.g. "Set up your LONG BTC order"
  instrument: z.string(), // "BTC/USDT" — current selection
  /** Symbol dropdown options (includes `instrument`). Empty = no dropdown. */
  symbols: z.array(z.string()).default([]),
  side: z.enum(['buy', 'sell']),
  direction: z.enum(['long', 'short']).optional(), // perp only
  /** Prefill from the parsed text; '' = trader must fill it in. */
  size: z.string().default(''),
  sizeAsset: z.string(), // unit label for the size input, e.g. "BTC"
  orderType: z.enum(['market', 'limit']).default('market'),
  limitPrice: z.string().optional(),
  leverage: z.number().int().min(1).optional(), // perp only — slider position
  maxLeverage: z.number().int().min(1).optional(), // slider bound (venue caps)
  marginMode: z.enum(['isolated', 'cross']).optional(),
  marginModes: z.array(z.enum(['isolated', 'cross'])).default([]),
  cta: z.string(), // e.g. "Review order →"
  footnote: z.string().optional(),
})

export const LifecycleFrame = z.object({
  ...base,
  type: z.literal('lifecycle'),
  ticketId: z.string(),
  phase: z.enum(['awaiting_confirm', 'filled', 'partial', 'cancelled', 'expired']),
  statusLine: z.string(), // e.g. "SENDING ORDER TO ASSETWORKS…"
  /** Progress stage riding INSIDE the phase — an open string vocabulary, not
   * an enum: a new phase value would fail old-SDK parse, and a new stage enum
   * member would fail NEW-SDK parse the same way one level down. Servers may
   * grow this set freely; clients map the values they know ('placing',
   * 'working', 'cancel_pending') and MUST render unknown stages as the bare
   * phase — ignore, never fail. */
  stage: z.string().optional(),
  /** Side of the underlying ticket so receipts can read "BUY · FILLED".
   * Mirrors OrderTicketFrame.side — a stable closed set. */
  side: z.enum(['buy', 'sell']).optional(),
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

/**
 * Stage-1 "understanding" — the fast interpret pass restated for the trader,
 * research-view style. PERSISTENT (not ephemeral): it stays above the answer,
 * collapsed by default, so the reasoning is reviewable after the answer lands.
 * `intent` is the classifier verdict; `memoryScopes` (the memory levels that
 * were applied) is populated only under the pre-prod inspector entitlement.
 */
export const InterpretationFrame = z.object({
  ...base,
  type: z.literal('interpretation'),
  summary: z.string(), // one-line "here's what I understood"
  intent: z.string().optional(), // research | advice | action | …
  detail: z.string().optional(), // expanded reasoning (optional)
  memoryScopes: z.array(z.string()).default([]), // e.g. ['platform','venue','user']
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

/**
 * Live market price tick (additive, July 2026) — realtime price for the
 * embed's current symbol, kept in sync with the host page. TRANSIENT by
 * contract: ticks update the panel's price surface (order-draft price, header
 * pulse) and are never part of the conversation thread; the gateway emits
 * them outside the resume journal (a reconnect just waits for the next tick)
 * so they can never bloat a Last-Event-ID replay. `last` is a number because
 * it drives a live display, not a money row the trader confirms.
 */
export const PriceTickFrame = z.object({
  ...base,
  type: z.literal('price_tick'),
  symbol: z.string(), // "BTC/USDT"
  last: z.number(),
  lastDisplay: z.string(), // server-formatted, e.g. "63,631.63"
  changePct: z.number().optional(), // 12h move, when known
  asOfIso: z.string(),
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

/**
 * "What Hippo remembers about you" (Phase B, pre-prod). The trading facts Hippo
 * has learned for this trader — DURABLE ones (scope 'user', kept across
 * sessions) and CURRENT ones (scope 'session', this conversation only) — so the
 * trader can see and clear them. Server-pushed on stream connect and again
 * whenever the set changes; the SDK keeps only the latest. Emitted only under
 * the memoryLab entitlement; SDKs that predate this frame ignore it. Clearing
 * is the `clearLearnedMemory` flag on SettingsUplink.
 */
export const LearnedMemoryFrame = z.object({
  ...base,
  type: z.literal('learned_memory'),
  facts: z
    .array(
      z.object({
        label: z.string(), // human phrase, e.g. "Follows BTC"
        type: z.string(), // machine key, e.g. "followed_asset"
        value: z.string(), // e.g. "BTC"
        scope: z.enum(['user', 'session']), // durable vs this-session
      }),
    )
    .default([]),
  // Phase C: whether auto-learning is currently ON for this trader. The SDK's
  // "Remember my preferences" toggle reflects + flips this (via SettingsUplink
  // .learnedMemoryOptIn). Default true = on when entitled (opt-OUT model).
  optIn: z.boolean().default(true),
})

/**
 * Panel identity (additive, July 2026) — the demo-grade in-panel username +
 * 4-digit-PIN identity. The gateway emits this after an identity_claim uplink
 * (and on stream connect when a session is already claimed) so the panel can
 * show "signed in as …" and key memory to the person, not the browser. PINs
 * are demo-grade by design (scrypt-hashed, rate-limited, per-partner) — a
 * partner in production owns identity via its own token endpoint instead.
 */
export const IdentityFrame = z.object({
  ...base,
  type: z.literal('identity'),
  status: z.enum(['ok', 'taken', 'wrong_pin', 'invalid', 'rate_limited', 'signed_out']),
  /** Present when status is ok — the display username now bound to the session. */
  username: z.string().optional(),
  /** Server-authored one-line detail for non-ok states. */
  note: z.string().optional(),
})

/**
 * File upload lifecycle (additive, July 2026) — server-side phases of an
 * uploaded file (the client renders its own byte-progress bar during the HTTP
 * upload; these frames take over once the gateway has the bytes). The
 * analysis answer itself still lands as a normal research_brief, so the
 * result card is the same trusted shape as every other answer (guardrail
 * included). Phase semantics split by durability, like lifecycle vs
 * price_tick: `received`/`analyzing` are TRANSIENT progress (live socket
 * only, never journaled), while the terminal `analyzed`/`failed` phases are
 * journaled so the file chip survives a resume/reload.
 */
export const UploadStatusFrame = z.object({
  ...base,
  type: z.literal('upload_status'),
  fileId: z.string(),
  name: z.string(), // display filename, server-sanitized
  sizeDisplay: z.string(), // e.g. "184 KB"
  phase: z.enum(['received', 'analyzing', 'analyzed', 'failed']),
  /** Server-authored reason when phase is failed (too large, unsupported…). */
  reason: z.string().optional(),
  /** File classification — lets the SDK pick the chip icon. Absent when the
   * file failed before classification (unsupported type). Additive. */
  kind: z.enum(['csv', 'image']).optional(),
})

/**
 * Host page action (additive, July 2026) — the server asking the HOST PAGE to
 * change something on screen ("switch the chart to 5m", "apply RSI"). The SDK
 * never touches the host DOM: it forwards a validated action over the existing
 * postMessage bridge and the host applies it — or ignores it. Only flows when
 * the host opted in (embed attr → ContextUplink.pageControl), so a page that
 * never asked can never be driven. `action` is a closed set (the SDK must know
 * how to forward each); `indicator` is an open slug the HOST validates against
 * what its chart actually supports — growth on the host side breaks nothing.
 */
export const HostActionFrame = z.object({
  ...base,
  type: z.literal('host_action'),
  actionId: z.string(), // correlates the host's ack back to this frame
  action: z.enum(['set_timeframe', 'apply_indicator', 'remove_indicator']),
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).optional(),
  indicator: z
    .string()
    .regex(/^[a-z0-9_-]{1,24}$/)
    .optional(),
  /** Server-authored one-liner for the in-panel chip, e.g. "Chart → 5m". */
  note: z.string().optional(),
})

/**
 * Consolidated orders view (additive, July 2026) — the full answer to "show
 * all my orders" / "orders this session". Distinct from OrdersSnapshotFrame
 * (the compact open-orders pill): this is a scope-labeled card with totals and
 * per-order rows. `status` and `kind` are open strings by design (stage
 * precedent — venue vocabulary grows without breaking a parser); money stays
 * strings per the canonical order model.
 */
export const OrdersSummaryFrame = z.object({
  ...base,
  type: z.literal('orders_summary'),
  scope: z.enum(['all', 'session']),
  asOfIso: z.string(),
  orders: z
    .array(
      z.object({
        orderId: z.string(),
        symbol: z.string(), // "BTC/USDT"
        side: z.enum(['buy', 'sell']),
        kind: z.string(), // e.g. "MKT", "LMT 60,000", "CLOSE LONG 10×"
        qty: z.string(),
        price: z.string().optional(),
        status: z.string(), // e.g. "WORKING", "FILLED", "CANCELLED"
        filledPct: z.number().min(0).max(100).optional(),
        tsIso: z.string().optional(),
      }),
    )
    .max(50),
  totals: z.object({
    open: z.number().int().nonnegative(),
    filled: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
})

export const Frame = z.discriminatedUnion('type', [
  ResearchBriefFrame,
  OrderTicketFrame,
  OrderDraftFrame,
  PriceTickFrame,
  LifecycleFrame,
  AdviceDeclineFrame,
  PositionsFrame,
  RejectionTicketFrame,
  ThinkingFrame,
  InterpretationFrame,
  SkeletonFrame,
  BannerFrame,
  PulseFrame,
  OrdersSnapshotFrame,
  UserEchoFrame,
  BriefDeltaFrame,
  LearnedMemoryFrame,
  IdentityFrame,
  UploadStatusFrame,
  HostActionFrame,
  OrdersSummaryFrame,
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
export type Interpretation = z.infer<typeof InterpretationFrame>
export type LearnedMemory = z.infer<typeof LearnedMemoryFrame>
export type Identity = z.infer<typeof IdentityFrame>
export type UploadStatus = z.infer<typeof UploadStatusFrame>
export type HostAction = z.infer<typeof HostActionFrame>
export type OrdersSummary = z.infer<typeof OrdersSummaryFrame>
export type OrderDraft = z.infer<typeof OrderDraftFrame>
export type PriceTick = z.infer<typeof PriceTickFrame>
export type Skeleton = z.infer<typeof SkeletonFrame>
export type Banner = z.infer<typeof BannerFrame>
export type Pulse = z.infer<typeof PulseFrame>
export type OrdersSnapshot = z.infer<typeof OrdersSnapshotFrame>
export type UserEcho = z.infer<typeof UserEchoFrame>
export type BriefDelta = z.infer<typeof BriefDeltaFrame>
export type UnknownFrame = z.infer<typeof FrameEnvelope>
