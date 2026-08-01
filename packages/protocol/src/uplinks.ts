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

/**
 * Interactive order draft (additive, July 2026) — the trader edited the
 * order_draft card's controls (leverage slider, price input, symbol /
 * order-type / margin dropdowns) and submitted, or dismissed the card.
 * `params` echoes the edited values on submit; the gateway NEVER trusts them
 * blindly — it re-validates against venue capabilities (max leverage, margin
 * modes, listed symbols) before running the normal prepare → ticket flow.
 */
/**
 * In-panel identity claim (additive, July 2026) — demo-grade username +
 * 4-digit PIN so a trader is identified across browsers/devices and memory
 * follows the person. `create` registers, `signin` verifies, `signout`
 * reverts the session to its anonymous host-minted identity. The gateway
 * validates per-mode (username/pin required except for signout), hashes PINs
 * (scrypt), and rate-limits attempts. Responds with an `identity` frame.
 */
export const IdentityClaimUplink = z.object({
  ...base,
  kind: z.literal('identity_claim'),
  mode: z.enum(['create', 'signin', 'signout']),
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{3,24}$/)
    .optional(),
  pin: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
})

export const DraftActionUplink = z.object({
  ...base,
  kind: z.literal('draft_action'),
  draftId: z.string(),
  action: z.enum(['submit', 'dismiss']),
  params: z
    .object({
      instrument: z.string(),
      orderType: z.enum(['market', 'limit']),
      size: z.string().min(1),
      limitPrice: z.string().optional(),
      /** Protective exits (additive, August 2026) — echo the draft card's
       * stop-loss / take-profit inputs on submit. Money as STRINGS. The
       * gateway re-validates against venue capabilities (protectiveExits
       * presence) like every other edited param — never trusted blindly. */
      stopLossPrice: z.string().optional(),
      takeProfitPrice: z.string().optional(),
      leverage: z.number().int().min(1).optional(),
      marginMode: z.enum(['isolated', 'cross']).optional(),
    })
    .optional(),
})

/**
 * Page context (additive, July 2026) — the host tells the embed which market
 * the trader is looking at (via data-hippo-symbol / the postMessage bridge),
 * and the SDK forwards it here. The gateway uses it as the session's default
 * symbol: order drafts, research and the live price tick key off it instead
 * of guessing BTC/USDT. Context, never a command — nothing executes from it.
 */
export const ContextUplink = z.object({
  ...base,
  kind: z.literal('context'),
  symbol: z.string().min(3).max(20).optional(), // e.g. "BTC/USDT"
  /**
   * Host page-control opt-in (additive, July 2026): true when the embed set
   * data-hippo-page-control, i.e. the host accepts host_action frames (chart
   * timeframe / indicator commands) over the postMessage bridge. The gateway
   * only emits host_action when this arrived true — a host that never opted
   * in is answered in prose instead of silently no-opping.
   */
  pageControl: z.boolean().optional(),
  /**
   * Host-action verb declaration (additive, August 2026): the host_action
   * verbs this host page supports (well-known: set_timeframe, apply_indicator,
   * remove_indicator, navigate, set_symbol, prefill_ticket — open vocabulary,
   * hosts may declare more). The gateway only emits verbs the host declared.
   * Back-compat: pageControl true with NO hostActions = legacy chart verbs
   * only (set_timeframe / apply_indicator / remove_indicator).
   */
  hostActions: z.array(z.string().min(1).max(40)).max(24).optional(),
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
  // Phase B: wipe the auto-learned facts (durable USER + current SESSION) —
  // the "what Hippo remembers about you" one-tap clear. Distinct from
  // clearMemory, which wipes the structured persona.
  clearLearnedMemory: z.boolean().optional(),
  // Phase C: the trader's "Remember my preferences" toggle. true = allow
  // auto-learning, false = opt out (no extraction, no learned-fact compose).
  // Default behaviour when unset stays ON for entitled partners (opt-out model).
  learnedMemoryOptIn: z.boolean().optional(),
})

/**
 * Stop-streaming (additive, July 2026): the trader halts an in-flight
 * streaming research brief. Base envelope only — the gateway knows the
 * session's in-flight stream, and the SERVER decides what the stopped
 * answer looks like (the SDK only signals intent, never invents content).
 * No active stream server-side → silent no-op.
 */
export const StreamStopUplink = z.object({
  ...base,
  kind: z.literal('stream_stop'),
})

/**
 * Alert cancel (additive, August 2026) — the trader tapped CANCEL on an alert
 * card chip. Creation stays conversational (user_text — the server parses the
 * condition), so cancel is the only alert verb that needs a wire uplink.
 * `action` is a closed enum ON PURPOSE (unlike growth vocabularies): each
 * value is a distinct SDK affordance, and a new one ships with the SDK that
 * renders it. The gateway answers with an `alert` frame (state 'cancelled').
 */
export const AlertActionUplink = z.object({
  ...base,
  kind: z.literal('alert_action'),
  alertId: z.string().min(1).max(64),
  action: z.enum(['cancel']),
})

export const Uplink = z.discriminatedUnion('kind', [
  UserTextUplink,
  ChipTapUplink,
  TicketActionUplink,
  DraftActionUplink,
  ContextUplink,
  IdentityClaimUplink,
  FeedbackUplink,
  ConsentUplink,
  SettingsUplink,
  StreamStopUplink,
  AlertActionUplink,
])

export type Uplink = z.infer<typeof Uplink>
export type UplinkKind = Uplink['kind']
