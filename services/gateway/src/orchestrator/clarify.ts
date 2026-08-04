/**
 * Confidence-aware clarification — the gateway ASKING instead of guessing.
 *
 * The intent classifier has always emitted a confidence and the orchestrator
 * has always ignored it above the nudge floor: a low-confidence guess at a
 * COSTLY intent (placing an order, arming an alert, mutating the trader's
 * page) executed anyway. This module owns the policy that stops that — when a
 * costly intent lands under CLARIFY_CONFIDENCE the turn's risky execution is
 * REPLACED by a question, and nothing is placed, armed or posted to the host
 * until the trader picks.
 *
 * Everything here is pure: the option labels are SERVER-AUTHORED display
 * strings (stop-line law — the SDK renders them verbatim and never invents an
 * interpretation), and every option resolves to an IntentResult the
 * orchestrator replays through its EXISTING execution paths. No order, alert
 * or host logic is duplicated here.
 */
import type { IntentKind, IntentResult } from './intelligence.js'

/**
 * Below this intent confidence a COSTLY reading is a GUESS, not a parse.
 *
 * No tuning went into 0.85 and none is needed: the classifier's numbers are
 * bimodal by construction (services/intelligence/intent.py). Every
 * deterministic fast path returns 0.92–0.97 ("we parsed this") and every
 * rule_classify fallback returns 0.6–0.8 ("we guessed this"). 0.85 sits in the
 * empty gap between those two clusters, so it separates parse from guess
 * exactly — and no fast-path hit can ever fall below it, which is why the
 * high-confidence path stays byte-identical.
 */
export const CLARIFY_CONFIDENCE = 0.85

/**
 * How long an open clarification stays answerable.
 *
 * A clarification asks "what did you mean just now?" — all of its context is
 * the sentence the trader typed seconds ago and the market they were looking
 * at while typing it. Two minutes is comfortably long enough to read four
 * one-line options and pick (and to survive a glance away at the chart), and
 * short enough that "Close your BTC position (market)" still means the same
 * trade it meant when we asked. Past the window the pick is refused with an
 * honest notice instead of firing a stale order into a moved market.
 */
export const CLARIFICATION_TTL_MS = 2 * 60_000

/** Open clarifications kept per session (oldest evicted beyond this). Asking
 * more than a handful of unanswered questions is a bug, not a feature. */
export const CLARIFICATIONS_CAP = 4

/**
 * The intents worth asking about: each one SPENDS something the trader can't
 * take back cheaply — money (`action`), durable server state (`alert`), or the
 * page under their hands (`host_action`). Being wrong about research, concept,
 * smalltalk, portfolio or orders_query costs a re-ask, so those NEVER clarify:
 * a question there is friction for nothing.
 */
export const COSTLY_INTENTS: ReadonlySet<string> = new Set(['action', 'alert', 'host_action'])

export type ClarificationOption = { id: string; label: string; hint?: string }

/** One clarification the gateway asked and is still willing to act on. */
export type OpenClarification = {
  /** The options actually offered — the set an optionId is re-validated against. */
  options: ClarificationOption[]
  /** optionId → the interpretation to re-run. Keys mirror `options`. */
  resolutions: Record<string, IntentResult>
  /** The turn text every resolution re-runs against (never re-classified). */
  text: string
  expiresAt: number
}

/** What the orchestrator needs to emit one clarification frame. */
export type ClarificationPlan = {
  question: string
  note: string
  options: ClarificationOption[]
  resolutions: Record<string, IntentResult>
}

/** Facts about the session the labels need. Passed in so this stays pure. */
export type ClarifyContext = { symbol: string; venueName: string }

/** Option ids are stable slugs, never generated — the gateway re-validates the
 * id it gets back against the set it sent, and stable ids keep that readable. */
const ID_AS_ASKED = 'as_asked'
const ID_ORDERS = 'show_orders'
const ID_POSITIONS = 'show_positions'
const ID_BRIEF = 'show_brief'

function baseOf(symbol: string): string {
  return symbol.split('/')[0] ?? symbol
}

/** Protocol bound: labels are 1..120 chars, hints 0..160, note/originalText
 * 0..280. Server-authored copy is well inside these; clamp anyway so a long
 * venue name or instrument can never produce a frame the schema rejects. */
function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** The page-mutation being proposed, in plain words. `action` is a
 * server-derived verb slug (never raw trader text), but unknown future verbs
 * still get a generic label rather than an echoed slug. */
function hostActionLabel(intentRes: IntentResult, base: string): string {
  const ha = intentRes.hostAction
  if (!ha) return 'Change something on this page'
  const indicator = (ha.indicator ?? '').toUpperCase()
  switch (ha.action) {
    case 'set_timeframe':
      return `Switch the chart to ${ha.timeframe ?? ''} candles`
    case 'apply_indicator':
      return indicator ? `Add ${indicator} to the chart` : 'Add that indicator to the chart'
    case 'remove_indicator':
      return indicator
        ? `Remove ${indicator} from the chart`
        : 'Remove that indicator from the chart'
    case 'set_symbol':
      return `Switch this page to ${ha.params?.symbol ?? base}`
    case 'navigate':
      return ha.params?.target ? `Open the ${ha.params.target} page` : 'Open another page here'
    case 'prefill_ticket':
      return "Fill in the page's order ticket"
    default:
      return 'Send that command to this page'
  }
}

/** The alert being proposed, in plain words. */
function alertLabel(intentRes: IntentResult, base: string): string {
  const ai = intentRes.alertIntent
  if (ai?.action === 'cancel') return `Cancel your ${ai.symbol ? baseOf(ai.symbol) : base} alerts`
  if (ai?.action === 'create' && ai.price !== undefined && ai.direction) {
    const symbol = ai.symbol ? baseOf(ai.symbol) : base
    const word = ai.direction === 'cross' ? 'reaches' : ai.direction
    return `Alert me when ${symbol} ${word} ${ai.price}`
  }
  return `Set a price alert on ${base}`
}

/** The order being proposed, in plain words. */
function actionLabel(intentRes: IntentResult, base: string): string {
  if (intentRes.amend) {
    const what = intentRes.amend.price !== undefined ? 'price' : 'size'
    return `Change the ${what} of my working order`
  }
  const order = intentRes.order
  if (!order) return `Set up a ${base} order`
  const symbol = order.instrument ? baseOf(order.instrument) : base
  if (order.action === 'close' || order.reduceOnly === true) {
    return `Close your ${symbol} position (market)`
  }
  const side = order.side === 'sell' ? 'SELL' : 'BUY'
  const size = order.size ? `${order.size} ` : ''
  return `Set up a ${side} ${size}${symbol} order`
}

/** The risky reading: exactly what this turn WOULD have done. */
function riskyOption(intentRes: IntentResult, ctx: ClarifyContext): ClarificationOption {
  const base = baseOf(ctx.symbol)
  switch (intentRes.intent) {
    case 'alert':
      return {
        id: ID_AS_ASKED,
        label: clamp(alertLabel(intentRes, base), 120),
        hint: clamp('Arms a durable alert — it watches the price until it fires.', 160),
      }
    case 'host_action':
      return {
        id: ID_AS_ASKED,
        label: clamp(hostActionLabel(intentRes, base), 120),
        hint: clamp('Changes the page you are looking at.', 160),
      }
    default:
      return {
        id: ID_AS_ASKED,
        label: clamp(actionLabel(intentRes, base), 120),
        hint: clamp(
          `You review and confirm on ${ctx.venueName} — nothing executes from here.`,
          160,
        ),
      }
  }
}

/**
 * The CHEAP readings, each a genuine, non-mutating interpretation of the same
 * sentence. One of these is always used as the escape, so the trader can
 * always pick something safe.
 */
function cheapOption(kind: IntentKind, ctx: ClarifyContext): ClarificationOption | null {
  const base = baseOf(ctx.symbol)
  switch (kind) {
    case 'orders_query':
      return {
        id: ID_ORDERS,
        label: 'Show me my orders first',
        hint: 'Your working and recent orders — nothing is placed.',
      }
    case 'portfolio':
      return {
        id: ID_POSITIONS,
        label: 'Show my positions and P&L',
        hint: 'What you actually hold — nothing is placed.',
      }
    case 'research':
      return {
        id: ID_BRIEF,
        label: clamp(`Just tell me what ${base} is doing`, 120),
        hint: 'A market brief — nothing is placed or changed.',
      }
    default:
      return null
  }
}

/** The IntentResult a cheap option re-runs as. Confidence is pinned to 1: the
 * trader told us what they meant, so this can never re-clarify. */
function cheapResolution(
  kind: IntentKind,
  intentRes: IntentResult,
  label: string,
  ctx: ClarifyContext,
): IntentResult {
  const base = baseOf(ctx.symbol)
  return {
    intent: kind,
    confidence: 1,
    language: intentRes.language,
    interpretation: label,
    ...(kind === 'orders_query' ? { ordersQuery: { scope: 'all' as const } } : {}),
    // The research engine is history-blind and caches on the question, so give
    // it a self-contained one rather than the ambiguous sentence we just asked
    // about. Server-authored, like every other string on this card.
    ...(kind === 'research' ? { restructuredQuery: `What is ${base} doing right now?` } : {}),
  }
}

/** Escape preference per costly intent, in order — the first one not already
 * offered becomes the escape. Always non-mutating by construction. */
const ESCAPE_ORDER: Record<string, IntentKind[]> = {
  action: ['portfolio', 'research', 'orders_query'],
  alert: ['research', 'portfolio'],
  host_action: ['research', 'portfolio'],
}

const QUESTION: Record<string, string> = {
  action: 'Before I touch an order — which did you mean?',
  alert: 'Before I arm an alert — which did you mean?',
  host_action: 'Before I change your page — which did you mean?',
}

function noteFor(intent: string, venueName: string): string {
  switch (intent) {
    case 'alert':
      return "I'd rather ask than guess. No alert is armed."
    case 'host_action':
      return "I'd rather ask than guess. Your page is untouched."
    default:
      return `I'd rather ask than guess. Nothing was sent to ${venueName}.`
  }
}

/**
 * The policy. Returns the clarification to ask INSTEAD of executing, or null
 * when this turn should run exactly as it always has.
 *
 * Null for: any cheap intent (a wrong research answer costs a re-ask), any
 * confidence at or above the threshold, and any turn the caller already
 * resolved. The caller also skips this entirely in degraded mode — the
 * deterministic fallback classifier pins confidence at 0.5, and its parse is a
 * parse, not a guess.
 */
export function buildClarification(
  intentRes: IntentResult,
  ctx: ClarifyContext,
): ClarificationPlan | null {
  if (!COSTLY_INTENTS.has(intentRes.intent)) return null
  if (intentRes.confidence >= CLARIFY_CONFIDENCE) return null

  const options: ClarificationOption[] = [riskyOption(intentRes, ctx)]
  const resolutions: Record<string, IntentResult> = {
    // The risky reading replays the ORIGINAL classification untouched (same
    // order/alert/hostAction payload) — so it lands in exactly the execution
    // path it would have taken without the question. Confidence pinned to 1
    // so the re-run can't ask again.
    [ID_AS_ASKED]: {
      ...intentRes,
      confidence: 1,
      interpretation: options[0]?.label ?? intentRes.interpretation,
    },
  }

  const add = (kind: IntentKind): void => {
    if (options.length >= 4) return
    const option = cheapOption(kind, ctx)
    if (!option || resolutions[option.id]) return
    options.push(option)
    resolutions[option.id] = cheapResolution(kind, intentRes, option.label, ctx)
  }

  // The classifier's own alternative readings first — it saw the words. Every
  // one of them is a CHEAP intent, so any of them doubles as the escape. The
  // field is raw wire data (the intent response is cast, not parsed), so the
  // shape is checked here and `add` ignores anything it can't render.
  if (Array.isArray(intentRes.alternatives)) for (const alt of intentRes.alternatives) add(alt)
  // Guarantee the escape: if the classifier named nothing (or named nothing
  // renderable), fall back to this intent's own safe reading. The card must
  // never be a single-answer "question".
  for (const kind of ESCAPE_ORDER[intentRes.intent] ?? ['research']) {
    if (options.length >= 2) break
    add(kind)
  }
  // Defensive: the loop above always lands one, but a future intent with an
  // empty escape list must produce no card rather than an invalid frame.
  if (options.length < 2) return null

  return {
    question: QUESTION[intentRes.intent] ?? 'Which did you mean?',
    note: clamp(noteFor(intentRes.intent, ctx.venueName), 280),
    options,
    resolutions,
  }
}

/** Drop everything past its window. Called before every read and write, so a
 * session that stops answering can't accumulate stale entries. */
function sweep(store: Map<string, OpenClarification>, now: number): void {
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id)
  }
}

/** Record an asked clarification, bounded (oldest evicted first). */
export function rememberClarification(
  store: Map<string, OpenClarification>,
  clarificationId: string,
  entry: OpenClarification,
  now: number = Date.now(),
): void {
  sweep(store, now)
  store.set(clarificationId, entry)
  while (store.size > CLARIFICATIONS_CAP) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

export type ChoiceOutcome =
  | { ok: true; intent: IntentResult; text: string; label: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'not_offered' }

/**
 * Re-validate a clarification_choice and consume it.
 *
 * The uplink is shape-validated on the wire only — zod cannot know which ids
 * we offered. This is the check that matters: the clarification must still be
 * OPEN (never answered, never expired) and the optionId must be one WE sent
 * for it. A second tap finds nothing (the first consumed it) and is refused
 * honestly rather than placing the order twice.
 *
 * An id we never offered does NOT consume the clarification — the trader can
 * still pick a real option from the card in front of them.
 */
export function takeChoice(
  store: Map<string, OpenClarification>,
  clarificationId: string,
  optionId: string,
  now: number = Date.now(),
): ChoiceOutcome {
  const entry = store.get(clarificationId)
  if (!entry) return { ok: false, reason: 'unknown' }
  if (entry.expiresAt <= now) {
    store.delete(clarificationId)
    return { ok: false, reason: 'expired' }
  }
  const intent = entry.resolutions[optionId]
  const option = entry.options.find((o) => o.id === optionId)
  if (!intent || !option) return { ok: false, reason: 'not_offered' }
  store.delete(clarificationId) // one-shot: a duplicate tap now reads 'unknown'
  sweep(store, now)
  return { ok: true, intent, text: entry.text, label: option.label }
}

/** The honest reply for a choice we can't act on — never a silent no-op. */
export function choiceDeclineBanner(reason: 'unknown' | 'expired' | 'not_offered'): {
  type: 'banner'
  kind: 'info'
  title: string
  text: string
} {
  switch (reason) {
    case 'expired':
      return {
        type: 'banner',
        kind: 'info',
        title: 'That question timed out',
        text: 'Open questions expire after a couple of minutes so a stale pick can never place an order in a market that has moved. Nothing was placed — ask me again and I will pick it straight up.',
      }
    case 'not_offered':
      return {
        type: 'banner',
        kind: 'info',
        title: 'That was not one of the choices',
        text: 'I only act on the options I offered, so I did nothing. Tap one of the choices on the card — or just tell me again in your own words.',
      }
    default:
      return {
        type: 'banner',
        kind: 'info',
        title: 'That question is closed',
        text: 'I do not have that question open any more — it was already answered, or this session restarted. Nothing was placed; ask me again and I will pick it up.',
      }
  }
}
