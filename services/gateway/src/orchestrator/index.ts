/**
 * Orchestrator — the card state machine (Build Plan/10 BE Architecture §2).
 *
 * Per turn: validate uplink (done in the route) → emit `thinking` immediately
 * (<150ms budget: it goes out before ANY network call) → intent service →
 * route:
 *
 *   research/concept → skeleton → intelligence /v1/respond → research_brief
 *   advice           → /v1/respond → advice_decline
 *   action (open)    → editable order_draft → (draft_action submit) → ticket
 *   action (close/reduce-only) → direct prepare → ticket (no draft: terms
 *                      come from the position; drafts are open-only)
 *   portfolio        → positions frame (in-memory demo table, seam stub)
 *   smalltalk/low-χ  → short research_brief-style nudge
 *
 * Deliberately a plain TS state machine, not an agent framework: routing is
 * deterministic; only the model calls are model-driven.
 *
 * DEGRADED MODE (the SLA contract): if the intelligence service times out or
 * errors, we emit one `banner(degraded)` per session per episode, classify
 * with the deterministic `guessIntent`, and answer research turns with a
 * market-data-only brief — degraded but truthful. Orders, prices and
 * portfolio never depend on the intelligence service and stay fully live.
 */
import { randomUUID } from 'node:crypto'
import type { VenueCapabilities } from '@hippo/protocol'
import type { UserIdentityStore } from '@hippo/stores'
import type { AccuracySignals } from '../accuracy-signals.js'
import type { AlertsEngine } from '../alerts.js'
import type { DraftFields, Session, SessionStore } from '../plugins/auth.js'
import type { EmitFrame, FrameDraft, JournalEntry } from '../plugins/sse.js'
import { emitTransient } from '../plugins/sse.js'
import type { Telemetry } from '../plugins/telemetry.js'
import type { ClarificationPlan } from './clarify.js'
import {
  buildClarification,
  CLARIFICATION_TTL_MS,
  choiceDeclineBanner,
  rememberClarification,
  takeChoice,
} from './clarify.js'
import { createIdentityHandler } from './identity.js'
import type {
  AmendIntent,
  BriefResponse,
  DeclineResponse,
  HistoryItem,
  HostActionIntent,
  IntelligenceClient,
  IntentResult,
  LearnedFactCandidate,
  OrderIntent,
} from './intelligence.js'
import { guessIntent } from './intelligence.js'
import type { MarketClient, MarketSnapshot } from './market.js'
import { asOfDisplay, cacheAgeDisplay, normalizeSymbol, symbolFromText } from './market.js'
import type { LearnedFact, MemoryClient, Persona } from './memory.js'
import { composeMemory } from './memory-compose.js'
import type { OrderRecord, SeamClient } from './seam.js'

/** Below this intent confidence we don't trust the route and nudge instead. */
const LOW_CONFIDENCE = 0.4

/** Coalescing window for streamed brief_delta frames (journal economy). */
const DELTA_FLUSH_MS = 150

/** Race winner when the trader stops an in-flight stream (stream_stop). */
const STOPPED = Symbol('stream-stopped')

/** brief frameId → originating turn, kept for REFRESH re-runs (FIFO cap). */
const BRIEF_TURNS_CAP = 500

/** Pending interactive drafts kept per session (oldest evicted beyond this). */
const DRAFTS_CAP = 5

/** Fallback market when neither the text nor the host page names one. */
const DEFAULT_SYMBOL = 'BTC/USDT'

/** Majors offered in the draft's symbol dropdown alongside the session symbol.
 * There is no venue instrument list exposed to the gateway today — this is a
 * deliberate, documented simplification until the seam advertises one. */
const DRAFT_SYMBOL_MAJORS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'] as const

/** Card actions ride the chip_tap uplink with reserved prefixes (v1 keeps
 * the uplink surface frozen). They are commands, not conversation: never
 * echoed, never classified, never written to persona memory. */
const CARD_ACTION_RE = /^(refresh|share|manage):(.+)$/

type Uplink = import('@hippo/protocol').Uplink

type Log = {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
}

export type OrchestratorDeps = {
  intel: IntelligenceClient
  market: MarketClient
  memory: MemoryClient
  seam: SeamClient
  /** In-panel username+PIN identities (identity_claim uplink, migration 015). */
  identity: UserIdentityStore
  /** Price alerts engine (src/alerts.ts) — conversational arm/cancel plus the
   * session-start sweep of undelivered triggered alerts. The poll loop itself
   * is started in app.ts; the orchestrator only routes into it. */
  alerts: AlertsEngine
  emit: EmitFrame
  telemetry: Telemetry
  log: Log
  /** The gateway's session store. On a Redis-backed store the orchestrator
   * mirrors ticket→session routing durably (registerTicket/resolveTicket),
   * so in-flight orders survive a restart; the in-memory store exposes none
   * of those hooks and behaves exactly as before. */
  sessions: SessionStore
  /** Implicit misunderstanding signals (src/accuracy-signals.ts). Optional:
   * absent = the four hooks below are no-ops and nothing is recorded. Every
   * hook is fire-and-forget — a turn never waits on or fails because of one. */
  signals?: AccuracySignals
}

export type Orchestrator = {
  onStreamConnect(session: Session): void
  handleUplink(session: Session, uplink: Uplink): void
  /** Venue lifecycle event from the seam callback. false = unknown ticket.
   * Async: a miss on the live routing map may consult the durable (Redis)
   * ticket mapping and cold-resume the owning session before routing. */
  onVenueEvent(event: import('./seam.js').VenueEvent): Promise<boolean>
}

/** The effective userId every per-user read/write keys off (memory, persona,
 * learned facts, seam, telemetry — and the upload library, which imports this
 * rather than re-deriving it). A claimed in-panel identity takes over the
 * moment it's adopted — namespaced `id:` so it can never collide with a
 * host-minted sub — which is what makes memory travel with the person. */
export function userKey(session: Session): string {
  if (session.identity) return `id:${session.identity.usernameLower}`
  return session.venueUserId ?? session.id
}

/** The session's default market: the host page's symbol (mint body or a
 * context uplink) when known, else BTC/USDT. Used wherever symbolFromText's
 * fallback applies — research, drafts and ticks key off the page's market
 * when the text names no symbol. */
function defaultSymbol(session: Session): string {
  return session.symbol ?? DEFAULT_SYMBOL
}

/** One-line USER-scope summary from the structured persona (opted-in only) —
 * folded into the composed memory's USER layer. Empty when nothing to say. */
function personaSummary(persona: Persona | null): string {
  if (!persona?.optIn) return ''
  const bits: string[] = []
  if (persona.experienceLevel) bits.push(`${persona.experienceLevel} trader`)
  if (persona.followedAssets.length)
    bits.push(`follows ${persona.followedAssets.slice(0, 5).join(', ')}`)
  return bits.join(' · ')
}

/** Render auto-learned facts into short, human-readable lines for the composed
 * memory block. Labels our closed fact-type vocab; unknown types pass through.
 * Bounded so a store that somehow grew can't bloat the prompt. Pure. */
function formatLearnedFacts(facts: LearnedFact[]): string {
  if (!facts.length) return ''
  const label: Record<string, string> = {
    followed_asset: 'follows',
    instrument_pref: 'prefers',
    leverage_pref: 'typical leverage',
    experience_level: 'experience',
    answer_style: 'answers',
  }
  return facts
    .slice(0, 20)
    .map((f) => `- ${label[f.type] ?? f.type}: ${f.value}`)
    .join('\n')
}

/** Human labels for the `learned_memory` frame ("what Hippo remembers"). Maps
 * the allowlisted fact types to a short phrase; unknown types pass through as
 * "type: value". Distinct from formatLearnedFacts (which formats the compose
 * block) — this is the trader-facing surface. Pure. */
const LEARNED_MEMORY_LABEL: Record<string, (value: string) => string> = {
  followed_asset: (v) => `Follows ${v}`,
  instrument_pref: (v) => `Prefers ${v}`,
  leverage_pref: (v) => `Typical leverage ${v}`,
  experience_level: (v) => `${v} trader`,
  answer_style: (v) => `Wants ${v} answers`,
}

function learnedMemoryLabel(type: string, value: string): string {
  return LEARNED_MEMORY_LABEL[type]?.(value) ?? `${type}: ${value}`
}

/** Per-VERB host-action copy. Degraded mode detects navigate / set_symbol /
 * prefill_ticket just like the primary path does, so a single "Adjusting the
 * chart on the page." line made the understanding card contradict the frames
 * under it — chart copy above a correct "Ticket → BUY 0.1" chip. Mirror of the
 * intelligence service's `_HOST_VERB_INTERP` (intent.py); `intent-parity.test.ts`
 * asserts this map covers every verb in HOST_ACTION_VERBS. */
const HOST_VERB_INTERPRETATION: Record<string, string> = {
  set_timeframe: 'Adjusting the chart timeframe on the page.',
  apply_indicator: 'Adding an indicator to the chart.',
  remove_indicator: 'Removing an indicator from the chart.',
  navigate: 'Taking you to another page.',
  set_symbol: 'Switching the page to a different market.',
  prefill_ticket: 'Filling in the order ticket for you to review.',
}

/** Fallback interpretation summary when stage-1 didn't supply one (degraded
 * mode / older intelligence build). One neutral line per intent — never
 * advice. `verb` is the detected host_action verb, so page commands describe
 * what they actually do instead of all claiming to touch the chart. */
export function defaultInterpretation(intent: string, verb?: string): string {
  switch (intent) {
    case 'research':
      return 'Looking up live market info for this.'
    case 'concept':
      return 'Explaining the concept.'
    case 'action':
      return 'Preparing an order ticket to review.'
    case 'advice':
      return "This asks for a call — I'll share facts, not advice."
    case 'portfolio':
      return 'Checking your own positions.'
    case 'host_action':
      return (verb ? HOST_VERB_INTERPRETATION[verb] : undefined) ?? 'Adjusting the page for you.'
    case 'orders_query':
      return 'Pulling together your orders.'
    case 'alert':
      return 'Managing your price alerts.'
    default:
      return 'Working on your request.'
  }
}

/** Human labels for the supported indicator slugs — used in the server-authored
 * host_action note ("Indicator → RSI") and the ack copy. Pure. */
const INDICATOR_LABEL: Record<string, string> = {
  sma20: 'SMA 20',
  sma50: 'SMA 50',
  ema20: 'EMA 20',
  rsi: 'RSI',
  vol: 'Volume',
}

/** The chart trio every page-control host supported before verb declaration
 * existed — the effective vocabulary when pageControl is true but the context
 * uplink carried NO hostActions (the contract's back-compat rule). */
const LEGACY_CHART_VERBS: readonly string[] = [
  'set_timeframe',
  'apply_indicator',
  'remove_indicator',
]

/** Server-authored one-liner for the host_action chip, e.g. "Chart → 5m",
 * "Indicator → RSI", "Market → ETH/USDT", "Ticket → BUY 0.1". Called with the
 * already-validated intent (params normalized), so it never renders raw user
 * text. Unknown future verbs fall back to the humanized slug. Pure. */
function hostActionNote(ha: HostActionIntent): string {
  const p = ha.params ?? {}
  switch (ha.action) {
    case 'set_timeframe':
      return `Chart → ${ha.timeframe}`
    case 'apply_indicator':
    case 'remove_indicator': {
      const label =
        INDICATOR_LABEL[ha.indicator ?? ''] ?? (ha.indicator ?? 'indicator').toUpperCase()
      return ha.action === 'apply_indicator' ? `Indicator → ${label}` : `Removed → ${label}`
    }
    case 'set_symbol':
      return `Market → ${p.symbol}`
    case 'navigate':
      return `Page → ${p.target}`
    case 'prefill_ticket':
      return `Ticket → ${(p.side ?? '').toUpperCase()} ${p.qty}${p.price ? ` @ ${p.price}` : ''}`
    default:
      return ha.action.replaceAll('_', ' ')
  }
}

/** Bucket order records into open/filled/cancelled totals over the FULL set
 * (before any 50-row bound), so the card's totals stay true even when the row
 * list is truncated. Pure. */
function ordersTotals(records: OrderRecord[]): { open: number; filled: number; cancelled: number } {
  const totals = { open: 0, filled: 0, cancelled: 0 }
  for (const r of records) totals[r.statusClass] += 1
  return totals
}

// ── conversation history (interpret-stage context) ─────────────────────────

/** History bounds: last N exchanges, headline-only, total chars capped —
 * enough for coreference, never a transcript. The intelligence service
 * re-bounds defensively on its side. */
const HISTORY_MAX_EXCHANGES = 6
const HISTORY_MAX_CHARS = 1200
const HISTORY_ITEM_MAX_CHARS = 240

/**
 * Assemble the bounded thread history for the interpret stage from the
 * session's frame journal. Per exchange: the user_echo text, plus ONE
 * assistant line — the research_brief HEADLINE when the turn produced a brief
 * (never the paragraphs: headlines carry the referent, bodies carry cost),
 * else the interpretation summary. The trailing exchange is the IN-FLIGHT
 * turn (its echo lands before processTurn runs) and is always dropped, so a
 * first turn yields []. Newest exchanges win the char budget. Pure.
 *
 * The result feeds ONLY the intent call. It must never be threaded into
 * /v1/respond or anything that touches the answer cache key — the cache stays
 * keyed on the self-contained restructured question.
 */
export function assembleHistory(entries: JournalEntry[]): HistoryItem[] {
  type Exchange = { user: string; assistant?: string; assistantIsHeadline?: boolean }
  const exchanges: Exchange[] = []
  for (const { frame } of entries) {
    const f = frame as { type: string } & Record<string, unknown>
    if (f.type === 'user_echo' && typeof f.text === 'string') {
      exchanges.push({ user: f.text })
      continue
    }
    const current = exchanges[exchanges.length - 1]
    if (!current) continue // pre-first-turn frames (orders_snapshot, identity…)
    if (f.type === 'research_brief' && typeof f.headline === 'string') {
      current.assistant = f.headline
      current.assistantIsHeadline = true
    } else if (
      f.type === 'interpretation' &&
      typeof f.summary === 'string' &&
      !current.assistantIsHeadline
    ) {
      current.assistant = f.summary
    }
  }
  exchanges.pop() // the in-flight turn's own echo — never its own context
  const items: HistoryItem[] = []
  for (const ex of exchanges.slice(-HISTORY_MAX_EXCHANGES)) {
    items.push({ role: 'user', text: ex.user.slice(0, HISTORY_ITEM_MAX_CHARS) })
    if (ex.assistant) {
      items.push({ role: 'assistant', text: ex.assistant.slice(0, HISTORY_ITEM_MAX_CHARS) })
    }
  }
  // Total-char cap: newest items survive, oldest drop first.
  let total = 0
  const kept: HistoryItem[] = []
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item) continue
    total += item.text.length
    if (total > HISTORY_MAX_CHARS) break
    kept.push(item)
  }
  kept.reverse()
  return kept
}

/** First numeric value in a venue display string ("0.31 BTC", "1,234.5 SOL",
 * "−0.5 BTC"), as an absolute number — position sizes are magnitudes here;
 * direction lives elsewhere. null when no finite number can be read. Pure. */
function parseDisplayNumber(display: string): number | null {
  const cleaned = display.replaceAll(',', '').replaceAll('−', '-')
  const m = cleaned.match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? Math.abs(n) : null
}

/** The trading pair inside a venue POSITION display string. Live rows are
 * display-shaped ("BTC-USDT 5x LONG"), not canonical instruments — the first
 * token is the pair, with venue-native separators. Pure. */
function pairOfPositionRow(display: string): string {
  const token = display.trim().split(/\s+/)[0] ?? display
  return token.toUpperCase().replaceAll('-', '/').replaceAll('_', '/')
}

/** The leverage a venue POSITION display string advertises ("BTC-USDT 5x
 * LONG" → 5). The trader's OPEN position is the only honest source of
 * leverage for a close/reduce — the parser has no way to know it and
 * defaults. null when the row carries none (spot rows, and venue adapters
 * that don't advertise it), in which case the caller must NOT invent one and
 * the capability backstop in prepareTicket bounds whatever it was given. */
function leverageOfPositionRow(display: string): number | null {
  const m = /(?:^|\s)(\d+(?:\.\d+)?)\s*x(?:\s|$)/i.exec(display)
  const raw = m?.[1]
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? n : null
}

/** Resolved fractional size → order-size string, rounded to the venue's
 * 8-decimal display convention with trailing zeros trimmed (the sim venue's
 * maximumFractionDigits:8; real venues re-validate at prepare). Pure. */
function formatFractionSize(n: number): string {
  const fixed = n.toFixed(8)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { intel, market, memory, seam, identity, alerts, emit, telemetry, log, sessions } = deps

  // In-panel username+PIN identity (identity_claim → identity frames). Owns
  // hashing, rate limiting and the sub→identity links; adoption flips what
  // userKey() above resolves to.
  const identityHandler = createIdentityHandler({ store: identity, emit, log, sessions })

  /**
   * Post-turn auto-learning (PRE-PROD, gated by `memoryLab`): extract durable
   * trading facts from the completed turn and persist them to SESSION scope.
   * Entirely fire-and-forget — it runs after the answer is already delivered,
   * never awaited on the trader's path, and swallows every error. Extraction
   * output is untrusted, allowlisted DATA (see the intelligence service); it is
   * composed as CONTEXT beneath the no-advice guardrail, never as instruction.
   * Phase B adds repeat-based promotion to DURABLE user scope: a fact observed
   * for the first time stays session-only; a re-observation (same type+value
   * already present in this session's facts) also lands in USER scope, so
   * durable memory reflects consistently-observed preferences, not one-offs.
   */
  function learnFromTurn(
    session: Session,
    query: string,
    interpretation: string | undefined,
    answer: string,
    persona: Persona | null,
  ): void {
    if (session.partner.entitlements?.memoryLab !== true) return
    // Phase C opt-OUT: a trader who turned "Remember my preferences" off gets
    // no extraction, no promotion — auto-learning is a full no-op for them.
    if (persona?.learnOptOut === true) return
    void (async () => {
      try {
        const facts = await intel.extractMemory({ query, interpretation, answer })
        if (!facts.length) return
        // Read the current session facts BEFORE upserting: any incoming fact
        // whose (type,value) is already here is a re-observation → promote it
        // to durable USER scope. First observation stays session-only.
        const prior = await memory.getLearnedFacts('session', { sessionId: session.id })
        const seen = new Set(prior.map((f) => `${f.type}\u0000${f.value}`))
        const repeats = facts.filter((f) => seen.has(`${f.type}\u0000${f.value}`))
        await memory.upsertLearnedFacts(
          'session',
          { sessionId: session.id },
          facts as LearnedFactCandidate[],
        )
        if (repeats.length) {
          await memory.upsertLearnedFacts(
            'user',
            { partnerId: session.partner.partnerId, userId: userKey(session) },
            repeats as LearnedFactCandidate[],
          )
        }
        // The learned set changed → refresh "what Hippo remembers" (gated).
        await emitLearnedMemory(session)
      } catch {
        // best-effort: auto-learning must never surface on a turn
      }
    })()
  }

  /**
   * Push the `learned_memory` frame ("what Hippo remembers about you"): durable
   * USER-scope facts + this-session facts, each with a human label. Gated on
   * memoryLab and best-effort (memory down → no frame, never an error). Called
   * on stream connect, after a learn changes the set, and after a clear.
   */
  async function emitLearnedMemory(session: Session): Promise<void> {
    if (session.partner.entitlements?.memoryLab !== true) return
    try {
      // The frame's `optIn` always reflects the CURRENT opt-out state so the
      // SDK's "Remember my preferences" toggle stays in sync. A trader who has
      // opted out has no learned facts to show (the toggle-off cleared them and
      // learnFromTurn is a no-op), so emit an empty, optIn:false frame — no
      // fact reads needed.
      const persona = await memory.get(session.partner.partnerId, userKey(session))
      const optIn = persona?.learnOptOut !== true
      if (!optIn) {
        emit(session, { type: 'learned_memory', facts: [], optIn: false })
        return
      }
      const [userFacts, sessionFacts] = await Promise.all([
        memory.getLearnedFacts('user', {
          partnerId: session.partner.partnerId,
          userId: userKey(session),
        }),
        memory.getLearnedFacts('session', { sessionId: session.id }),
      ])
      const facts = [
        ...userFacts.map((f) => ({
          label: learnedMemoryLabel(f.type, f.value),
          type: f.type,
          value: f.value,
          scope: 'user' as const,
        })),
        ...sessionFacts.map((f) => ({
          label: learnedMemoryLabel(f.type, f.value),
          type: f.type,
          value: f.value,
          scope: 'session' as const,
        })),
      ]
      emit(session, { type: 'learned_memory', facts, optIn: true })
    } catch {
      // best-effort: the memory surface must never break the stream
    }
  }

  // ── frame builders ─────────────────────────────────────────────────────

  function briefFrame(res: BriefResponse, intent: string): FrameDraft {
    return {
      type: 'research_brief',
      eyebrow: intent === 'concept' ? 'CONCEPT' : 'MARKET BRIEF',
      live: !res.cached,
      headline: res.headline,
      paragraphs: res.paragraphs,
      stats: res.stats,
      model: res.model,
      ...(res.sparkPoints && res.sparkPoints.length >= 2
        ? { spark: { points: res.sparkPoints } }
        : {}),
      sources: res.sources,
      followups: res.followups,
      liveBar: {
        asOf: asOfDisplay(res.asOfIso),
        asOfIso: res.asOfIso,
        refreshable: true,
        shareable: true,
        feedback: true,
        cached: res.cached,
        ...(res.cached ? { cacheAge: cacheAgeDisplay(res.asOfIso) } : {}),
      },
    }
  }

  function declineFrame(res: DeclineResponse): FrameDraft {
    return {
      type: 'advice_decline',
      message: res.message,
      pivotTitle: res.pivotTitle,
      facts: res.facts,
      followups: res.followups,
    }
  }

  /** Static decline for degraded mode — no model, no market call, still honest. */
  function staticDeclineFrame(): FrameDraft {
    return {
      type: 'advice_decline',
      message:
        "I can't tell you whether to trade — an assistant that gives trading calls isn't on your side. Here's what I can do instead:",
      pivotTitle: 'What I can show you right now',
      facts: [
        { icon: '◎', text: 'The live picture for any asset — price, 12h move, funding.' },
        { icon: '▤', text: 'Your open orders and positions, straight from the venue.' },
        { icon: '✎', text: 'A prepared order ticket you confirm on the exchange, never here.' },
      ],
      followups: ['BTC price picture', 'My positions & P&L'],
    }
  }

  /** Degraded-mode research: headline/stats/spark built directly from the
   * market-data snapshot; one templated sentence of prose; provenance is the
   * price feed and nothing else. */
  function marketOnlyBriefFrame(snap: MarketSnapshot): FrameDraft {
    const base = snap.symbol.split('/')[0] ?? snap.symbol
    const direction = snap.change12hPct < 0 ? 'down' : 'up'
    const magnitude = snap.change12hDisplay.replace(/^[+−-]/, '')
    const stats: Array<{ k: string; v: string; tone: string }> = [
      { k: 'LAST', v: snap.lastDisplay, tone: 'neutral' },
      { k: '12H', v: snap.change12hDisplay, tone: snap.change12hPct < 0 ? 'neg' : 'pos' },
    ]
    if (snap.fundingDisplay !== null && snap.fundingRate !== null) {
      stats.push({
        k: 'FUNDING',
        v: snap.fundingDisplay,
        tone: snap.fundingRate < 0 ? 'neg' : 'pos',
      })
    }
    return {
      type: 'research_brief',
      eyebrow: 'MARKET BRIEF',
      live: true,
      headline: `${base} is ${direction} ${magnitude} over 12 hours`,
      paragraphs: [
        `Fresh research is briefly paused, so this comes straight from the live price feed: ${base} last traded at ${snap.lastDisplay}, ${snap.change12hDisplay} over the past 12 hours.`,
      ],
      stats,
      spark: {
        points: snap.spark,
        captionLeft: `${snap.symbol} · 12H`,
        captionRight: `$${snap.lastDisplay}`,
      },
      sources: ['PRICE FEED'],
      followups: ['My positions & P&L', 'Explain funding rates'],
      liveBar: {
        asOf: asOfDisplay(snap.asOfIso),
        asOfIso: snap.asOfIso,
        refreshable: true,
        shareable: true,
        feedback: true,
        cached: false,
      },
    }
  }

  /**
   * Stopped-stream brief: the authoritative frame for a stream the trader
   * halted. Assembled SERVER-SIDE from the text that already streamed —
   * honest and truncated. No stats, no spark: the server never fabricates
   * numbers it didn't retrieve. liveBar appears only when the snapshot meta
   * (real asOf) was already fetched before the stop.
   */
  function stoppedBriefFrame(
    accumulated: string,
    intent: string,
    asOfIso: string | null,
  ): FrameDraft {
    const paragraphs = accumulated
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
    return {
      type: 'research_brief',
      eyebrow: intent === 'concept' ? 'CONCEPT · STOPPED' : 'MARKET BRIEF · STOPPED',
      live: false,
      headline: 'Stopped early — partial brief',
      paragraphs:
        paragraphs.length > 0
          ? paragraphs
          : ['Stopped before any of the brief had streamed. Ask again for the full picture.'],
      stats: [],
      sources: [],
      followups: [],
      ...(asOfIso
        ? {
            liveBar: {
              asOf: asOfDisplay(asOfIso),
              asOfIso,
              refreshable: true,
              shareable: true,
              feedback: true,
              cached: false,
            },
          }
        : {}),
    }
  }

  /** Smalltalk / low-confidence: a short, helpful nudge in brief clothing. */
  function nudgeFrame(session: Session): FrameDraft {
    return {
      type: 'research_brief',
      eyebrow: 'HIPPO',
      live: false,
      headline: 'Ask me about the market',
      paragraphs: [
        'I can research any listed asset, explain concepts, prepare orders for you to confirm on the exchange, and show your positions. Try one of these:',
      ],
      stats: [],
      sources: [],
      followups: session.partner.suggestedQueries.slice(0, 4),
    }
  }

  // ── degraded-mode helpers ──────────────────────────────────────────────

  function enterDegraded(session: Session, err: unknown): void {
    telemetry.markDegraded()
    log.warn({ err }, 'intelligence unreachable — degraded mode')
    if (!session.degradedBannerShown) {
      session.degradedBannerShown = true
      emit(session, {
        type: 'banner',
        kind: 'degraded',
        title: 'HIGH MARKET LOAD',
        text: 'Fresh research may take longer than usual; orders, prices and saved briefs are unaffected.',
      })
    }
  }

  async function emitMarketOnlyBrief(
    session: Session,
    text: string,
    replaces?: string,
  ): Promise<void> {
    try {
      const snap = await market.snapshot(symbolFromText(text, defaultSymbol(session)))
      const frame = emit(session, {
        ...marketOnlyBriefFrame(snap),
        ...(replaces ? { replaces } : {}),
      })
      rememberBrief(frame, text, 'research')
      telemetry.recordResearchAnswered(userKey(session))
    } catch (err) {
      // Both intelligence AND market-data are down: say so, truthfully.
      log.error({ err }, 'market-data also unreachable in degraded mode')
      emit(session, {
        type: 'research_brief',
        eyebrow: 'MARKET BRIEF',
        live: false,
        headline: 'Live research is temporarily unavailable',
        paragraphs: [
          'Both fresh research and the live price feed are briefly unreachable. Your orders and positions are unaffected — try again in a moment.',
        ],
        stats: [],
        sources: [],
        followups: session.partner.suggestedQueries.slice(0, 2),
      })
    }
  }

  // ── action: order tickets (Canonical Trading Interface, Build Plan/04) ──

  /** Live tickets → their session, so venue events (which carry only a
   * ticketId) can be routed back into the right thread. */
  const ticketSessions = new Map<string, Session>()

  /** Tickets whose confirm was handed to the venue — from that moment the
   * order may exist venue-side, so cancel copy and routing must stay honest
   * about it (never "nothing was sent"). */
  const confirmedTickets = new Set<string>()

  /** Replacement (amend) tickets → the venue orderId they replace. On this
   * ticket's confirm the OLD order is cancelled FIRST, then the new one is
   * placed — both legs through existing seam surfaces, both audited by the
   * seam's cancel/confirm audit kinds. Consumed at confirm/cancel time. */
  const amendReplaces = new Map<string, string>()

  /** Post-confirm venue-event backstop: if the seam's callback delivery fails
   * (it retries exactly once, then only audits) the trader must never sit on
   * "WAITING FOR YOUR CONFIRM" forever. Env-tunable so tests can shrink it;
   * read per orchestrator so tests set it before buildApp. */
  const ticketTimeoutMs = Number(process.env.TICKET_EVENT_TIMEOUT_MS ?? 10 * 60_000)

  /** Per-ticket backstop timers (see ticketTimeoutMs). */
  const ticketTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** Durable ticket-key TTL slack past the backstop window: the key must
   * outlive the timer that ends the ticket, never the other way round. */
  const TICKET_KEY_TTL_SLACK_MS = 30_000

  /** Mirror the ticket→session mapping durably (Redis-backed stores only —
   * `?.` makes this a no-op on the in-memory store, keeping that path
   * byte-identical). Also re-snapshots the session meta, so the serialized
   * `session.tickets` (incl. confirm state) stays current. */
  function persistTicket(session: Session, ticketId: string): void {
    sessions.registerTicket?.(session, ticketId, ticketTimeoutMs + TICKET_KEY_TTL_SLACK_MS)
  }

  /** Drop the durable mapping — call AFTER deleting from `session.tickets`
   * so the refreshed meta snapshot no longer carries the ticket. */
  function releaseTicket(session: Session, ticketId: string): void {
    sessions.releaseTicket?.(session, ticketId)
  }

  function clearTicketTimeout(ticketId: string): void {
    const timer = ticketTimers.get(ticketId)
    if (timer !== undefined) {
      clearTimeout(timer)
      ticketTimers.delete(ticketId)
    }
  }

  /** (Re)arm the no-venue-event backstop: past the window, close the card
   * with an honest terminal frame instead of leaving it waiting forever.
   * Every (re)arm also refreshes the durable ticket mapping, so its TTL
   * tracks the live backstop window. */
  function armTicketTimeout(session: Session, ticketId: string): void {
    persistTicket(session, ticketId)
    clearTicketTimeout(ticketId)
    const timer = setTimeout(() => {
      ticketTimers.delete(ticketId)
      if (!ticketSessions.has(ticketId)) return // already resolved by an event
      // Read the side BEFORE the delete below tears the ticket entry down.
      const side = session.tickets.get(ticketId)?.side
      ticketSessions.delete(ticketId)
      session.tickets.delete(ticketId)
      confirmedTickets.delete(ticketId)
      releaseTicket(session, ticketId)
      log.warn({ ticketId }, 'no venue event within the backstop window')
      emit(session, {
        type: 'lifecycle',
        ticketId,
        phase: 'expired',
        statusLine: `NO UPDATE FROM ${session.partner.venueName.toUpperCase()} — CHECK THE VENUE FOR FINAL STATUS`,
        ...(side ? { side } : {}),
      })
    }, ticketTimeoutMs)
    timer.unref?.()
    ticketTimers.set(ticketId, timer)
  }

  // ── stop-streaming (stream_stop uplink) ─────────────────────────────────

  /** In-flight research stream per session. `stop` aborts it: the consuming
   * loop below races every stream event against the stop signal, aborts
   * consumption, and emits the stopped brief; `settled` resolves once that
   * loop has fully wound down. stream_stop with no entry here is a silent
   * no-op. One stream per session — a new research turn stops the previous
   * stream and awaits `settled`, so two streams can never interleave deltas
   * or steal each other's stop handle. */
  const activeStreams = new Map<string, { stop: () => void; settled: Promise<void> }>()

  // ── REFRESH re-runs (card_action refresh:<frameId>) ─────────────────────

  /** Emitted brief frameId → the turn that produced it. REFRESH re-runs the
   * ORIGINAL question and the new brief replaces the old card in place —
   * never a re-classification of the raw "refresh:f_…" string. */
  const briefTurns = new Map<string, { text: string; intent: string }>()

  function rememberBrief(frame: ReturnType<EmitFrame>, text: string, intent: string): void {
    if (!frame) return
    briefTurns.set(frame.id, { text, intent })
    if (briefTurns.size > BRIEF_TURNS_CAP) {
      const oldest = briefTurns.keys().next().value
      if (oldest !== undefined) briefTurns.delete(oldest)
    }
  }

  async function refreshBrief(session: Session, frameId: string): Promise<void> {
    const origin = briefTurns.get(frameId)
    if (!origin) {
      // Gateway restarted or the mapping aged out: an in-place re-run would
      // be a guess at what the trader asked. Say so instead of guessing.
      emit(session, {
        type: 'rejection_ticket',
        title: 'Refresh unavailable',
        reason:
          'This brief is too old to refresh in place — ask the question again for a fresh answer.',
      })
      return
    }
    try {
      const res = await intel.respond({
        text: origin.text,
        intent: origin.intent,
        symbol: symbolFromText(origin.text, defaultSymbol(session)),
      })
      if (res.kind === 'decline') {
        emit(session, declineFrame(res))
        return
      }
      telemetry.recordCache(res.cached)
      const frame = emit(session, { ...briefFrame(res, origin.intent), replaces: frameId })
      rememberBrief(frame, origin.text, origin.intent)
      telemetry.recordResearchAnswered(userKey(session))
    } catch (err) {
      enterDegraded(session, err)
      await emitMarketOnlyBrief(session, origin.text, frameId)
    }
  }

  /**
   * THE capability gate. Every order path funnels through prepareTicket —
   * draft submit, close/reduce, fractional close, conversational amend — so
   * the venue-truth check lives HERE, not in any one caller. Previously it
   * sat in submitDraft, which covered the draft path only: a close carrying
   * the parser's default leverage reached the seam unbounded and rendered a
   * ticket quoting a leverage the venue would never accept.
   *
   * Fetched-vs-unreachable is the whole distinction: a caps object we
   * actually READ is venue truth and is enforced; a seam we could not reach
   * yields null and we forward, letting the seam's own (authoritative)
   * validation decide rather than blocking the trader on our ignorance.
   *
   * Returns null when the order is cleared to proceed, or the rejection
   * reason to emit.
   */
  async function capabilityRejection(
    session: Session,
    order: OrderIntent,
    perpPlan: boolean,
  ): Promise<string | null> {
    let caps: VenueCapabilities | null = null
    try {
      caps = await seam.capabilities()
    } catch (err) {
      log.warn({ err }, 'seam capabilities unavailable at prepare — deferring to seam validation')
    }
    if (!caps) return null
    const venue = session.partner.venueName
    if (!perpPlan) {
      return caps.spot === undefined ? `${venue} doesn't support spot orders.` : null
    }
    const perp = caps.futures_perp
    if (!perp) return `${venue} doesn't support perpetual futures.`
    const lev = order.leverage
    if (lev !== undefined && (lev < 1 || lev > perp.maxLeverage)) {
      return `Leverage ${lev}× is outside this venue's 1–${perp.maxLeverage}× range.`
    }
    if (order.marginMode && !perp.marginModes.includes(order.marginMode)) {
      return `Margin mode "${order.marginMode}" isn't available here — use ${perp.marginModes.join(' or ')}.`
    }
    return null
  }

  async function prepareTicket(
    session: Session,
    order: OrderIntent,
    text: string,
    opts: { replacesOrderId?: string } = {},
  ) {
    // The seam owns quoting, fees and validation (per-venue adapter). The
    // gateway forwards the prepared ticket verbatim — it never computes money.
    let ticket: import('./seam.js').PreparedTicket
    const exits = {
      ...(order.stopLossPrice !== undefined ? { stopLossPrice: order.stopLossPrice } : {}),
      ...(order.takeProfitPrice !== undefined ? { takeProfitPrice: order.takeProfitPrice } : {}),
    }
    // Which seam plan this order will take — computed ONCE so the capability
    // gate below checks exactly the capability that gets sent downstream.
    const perpPlan = Boolean(
      order.capability === 'futures_perp' && order.direction && order.leverage,
    )
    const rejection = await capabilityRejection(session, order, perpPlan)
    if (rejection !== null) {
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `${rejection} Nothing was sent to the venue.`,
        fix: { label: 'Try again', action: text },
      })
      return
    }
    try {
      if (perpPlan && order.direction && order.leverage) {
        // Futures perp → the seam's capability plan path.
        ticket = await seam.prepareOrder({
          capability: 'futures_perp',
          partnerId: session.partner.partnerId,
          userId: userKey(session),
          instrument: order.instrument,
          direction: order.direction,
          action: order.action ?? 'open',
          leverage: order.leverage,
          marginMode: order.marginMode ?? 'isolated',
          size: order.size,
          reduceOnly: order.reduceOnly ?? false,
          orderType: order.orderType,
          ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
          ...exits,
        })
      } else if (order.stopLossPrice !== undefined || order.takeProfitPrice !== undefined) {
        // Spot WITH protective exits → the capability plan path too: the
        // legacy /v1/prepare wire has no protective fields, and dropping them
        // there would silently strip the trader's protection.
        ticket = await seam.prepareOrder({
          capability: 'spot',
          partnerId: session.partner.partnerId,
          userId: userKey(session),
          side: order.side,
          size: order.size,
          instrument: order.instrument,
          orderType: order.orderType,
          ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
          ...exits,
        })
      } else {
        ticket = await seam.prepare({
          partnerId: session.partner.partnerId,
          userId: userKey(session),
          side: order.side,
          size: order.size,
          instrument: order.instrument,
          orderType: order.orderType,
          ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
        })
      }
    } catch (err) {
      log.error({ err, instrument: order.instrument }, 'seam prepare failed')
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `${session.partner.venueName} couldn't quote this order right now, so I won't guess at a price. Nothing was sent to the venue.`,
        fix: { label: 'Try again', action: text },
      })
      return
    }

    ticketSessions.set(ticket.ticketId, session)
    // Replacement ticket (conversational amend): remember which venue order
    // it replaces — confirm cancels that one first — and say so on the card
    // (server-authored row; the SDK renders rows verbatim).
    if (opts.replacesOrderId !== undefined) {
      amendReplaces.set(ticket.ticketId, opts.replacesOrderId)
      ticket.rows = [...ticket.rows, { label: 'Replaces', value: `Order #${opts.replacesOrderId}` }]
    }
    // Append-only record of orders this session created — the basis for
    // orders_query scope 'session'. session.tickets is pruned on terminal
    // events, so it can't serve this; this set is never pruned.
    if (!session.createdTicketIds) session.createdTicketIds = new Set()
    session.createdTicketIds.add(ticket.ticketId)
    session.tickets.set(ticket.ticketId, {
      side: ticket.side,
      instrument: ticket.instrument,
      sizeDisplay: order.size,
      sizeNum: Number(order.size),
      price: 0, // actuals come back on venue events; the gateway holds no math
      feeRate: 0,
    })
    // Durable mirror of the routing entry above (Redis-backed stores only):
    // a restarted pod resolves the ticket back to this session, so the venue
    // FILL still lands in the trader's thread instead of being dropped.
    persistTicket(session, ticket.ticketId)

    emit(session, {
      type: 'order_ticket',
      ticketId: ticket.ticketId,
      title: 'Order prepared',
      side: ticket.side,
      sideLabel: ticket.sideLabel,
      rows: ticket.rows,
      cta: `Review & confirm in ${session.partner.venueName} →`,
      footnote: `Hippo prepared this order. ${session.partner.venueName} will ask you to confirm before anything executes.`,
    })
  }

  // ── fractional close/reduce ("sell half my SOL") ─────────────────────────

  /**
   * Resolve a fractional close/reduce order against the LIVE position via the
   * seam's portfolio: size = fraction × current position size, rounded to the
   * venue's 8-decimal convention. Returns the order with a concrete size, or
   * null after emitting an honest decline (no position / seam down / dust).
   * Fraction 1.0 uses the full position size — exactly the existing "close".
   */
  async function resolveFractionalOrder(
    session: Session,
    order: OrderIntent,
  ): Promise<OrderIntent | null> {
    const venue = session.partner.venueName
    const fraction = order.sizeFraction ?? 0
    // The instrument may be "" when the phrasing named no asset ("close half
    // my long") — fall back to the page's symbol, same convention as drafts.
    const instrument = normalizeSymbol(order.instrument) ?? defaultSymbol(session)
    const base = instrument.split('/')[0] ?? instrument
    if (!(fraction > 0 && fraction <= 1)) {
      // Defensive: the intelligence service already rejects out-of-range
      // fractions, but a bad wire value must never become a guessed size.
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `I couldn't read that as a fraction of your ${base} position — try "sell half my ${base}" or give an explicit size. Nothing was sent to the venue.`,
      })
      return null
    }
    let positions: import('./seam.js').SeamPortfolio['positions']
    try {
      ;({ positions } = await seam.portfolio(session.partner.partnerId, userKey(session)))
    } catch (err) {
      log.error({ err, instrument }, 'seam portfolio unavailable for fractional sizing')
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `${venue} isn't answering position queries right now, so I can't size a fraction of your ${base} position. Nothing was sent to the venue.`,
      })
      return null
    }
    // Venue rows carry DISPLAY instruments ("BTC-USDT 5x LONG"), so match on
    // the normalized pair — an exact === against "BTC/USDT" never fires live.
    // When the phrasing named a direction ("close half my LONG"), prefer the
    // row that carries it; else the first pair match wins.
    const pairMatches = positions.filter((p) => pairOfPositionRow(p.instrument) === instrument)
    const wantDir = order.direction?.toUpperCase()
    const position =
      (wantDir && pairMatches.find((p) => p.instrument.toUpperCase().includes(wantDir))) ??
      pairMatches[0]
    const held = position ? parseDisplayNumber(position.size) : null
    if (held === null || held <= 0) {
      // The honest decline — never a zero-size order.
      emit(session, {
        type: 'rejection_ticket',
        title: 'No position to reduce',
        reason: `You have no open ${base} position on ${venue} to reduce. Nothing was sent to the venue.`,
      })
      return null
    }
    const size = formatFractionSize(fraction >= 1 ? held : fraction * held)
    if (Number(size) <= 0) {
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `That fraction of your ${base} position rounds to zero at the venue's precision. Nothing was sent to the venue.`,
      })
      return null
    }
    // MONEY: leverage on a close comes from the POSITION being closed, never
    // from the parser. The intelligence fast-path has no way to know it and
    // defaults (intent.py: `"leverage": 10`), so a close on a 5× position
    // would otherwise render "CLOSE LONG 10×" with liquidation and margin
    // derived from a number the trader never chose. Live perp rows advertise
    // it ("BTC-USDT 5x LONG"); rows that don't (spot rows, sim venue) leave
    // the value alone and prepareTicket's capability gate bounds it.
    const liveLeverage =
      order.capability === 'futures_perp' && position
        ? leverageOfPositionRow(position.instrument)
        : null
    return {
      ...order,
      instrument,
      size,
      ...(liveLeverage !== null ? { leverage: liveLeverage } : {}),
    }
  }

  // ── conversational amend ("move my limit to 61k") ────────────────────────

  /**
   * v1 amend = replacement ticket, no new protocol: exactly one open order →
   * prepare a new ticket at the amended price/size carrying a "Replaces order
   * #<id>" row; on that ticket's confirm the old venue order is cancelled
   * FIRST, then the new one is placed (confirmHandoff routes to
   * confirmAmendHandoff via amendReplaces). Zero open orders → honest notice;
   * several → ask which one, listing them. Never a guess.
   */
  async function handleAmend(session: Session, amend: AmendIntent, text: string): Promise<void> {
    const venue = session.partner.venueName
    let records: OrderRecord[]
    try {
      records = await seam.listOrders(session.partner.partnerId, userKey(session))
    } catch (err) {
      log.error({ err }, 'seam listOrders unavailable for amend')
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not amended',
        reason: `${venue} isn't answering order queries right now, so I can't find the order to change. Your working order is untouched — try again in a moment.`,
      })
      return
    }
    const open = records.filter((r) => r.statusClass === 'open')
    if (open.length === 0) {
      emit(session, {
        type: 'banner',
        kind: 'info',
        title: 'No working order',
        text: `You have no working order on ${venue} to amend — nothing was changed.`,
      })
      return
    }
    if (open.length > 1) {
      const list = open
        .slice(0, 5)
        .map((r) => `#${r.orderId} ${r.side.toUpperCase()} ${r.qty} ${r.symbol} (${r.kind})`)
        .join(' · ')
      emit(session, {
        type: 'banner',
        kind: 'info',
        title: 'Which order?',
        text: `You have ${open.length} working orders: ${list}. I amend one order at a time — cancel the ones you don't want first, or manage them on ${venue}.`,
      })
      return
    }
    const target = open[0]
    if (!target) return // unreachable: length === 1
    // Replacement terms: the amended value wins; everything else carries over
    // from the working order. qty strings look like "0.05" or "0.05 BTC".
    const heldQty = parseDisplayNumber(target.qty)
    const size = amend.size ?? (heldQty !== null ? formatFractionSize(heldQty) : undefined)
    if (size === undefined || Number(size) <= 0) {
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not amended',
        reason: `I couldn't read the size of order #${target.orderId}, so I won't guess. Amend it on ${venue}, or tell me the full new order.`,
      })
      return
    }
    const oldPrice = target.price !== undefined ? target.price.replaceAll(',', '') : undefined
    const limitPrice = amend.price ?? oldPrice
    const order: OrderIntent = {
      side: target.side,
      size,
      instrument: normalizeSymbol(target.symbol) ?? defaultSymbol(session),
      // A price amend (or an existing limit) makes the replacement a limit
      // order; a size-only amend of a market order stays market.
      ...(limitPrice !== undefined
        ? { orderType: 'limit' as const, limitPrice }
        : { orderType: 'market' as const }),
    }
    emit(session, { type: 'skeleton', shape: 'ticket' })
    await prepareTicket(session, order, text, { replacesOrderId: target.orderId })
  }

  /**
   * Confirm of a replacement (amend) ticket: cancel the old venue order
   * FIRST, then place the new one — both through existing seam surfaces, so
   * both legs land in the seam's audit trail (cancel + confirm kinds). Every
   * failure mode is honest: cancel failed → old order still working, nothing
   * new placed; placement failed after a successful cancel → the thread says
   * BOTH things (old order cancelled + replacement rejected) — never
   * silently half-done.
   */
  function confirmAmendHandoff(session: Session, ticketId: string, oldOrderId: string): void {
    const venue = session.partner.venueName.toUpperCase()
    const side = session.tickets.get(ticketId)?.side
    const dropTicket = (): void => {
      ticketSessions.delete(ticketId)
      session.tickets.delete(ticketId)
      confirmedTickets.delete(ticketId)
      clearTicketTimeout(ticketId)
      releaseTicket(session, ticketId)
    }
    emit(session, {
      type: 'lifecycle',
      ticketId,
      phase: 'awaiting_confirm',
      stage: 'placing',
      statusLine: `CANCELLING ORDER #${oldOrderId.toUpperCase()} ON ${venue}…`,
      cancellable: false,
      ...(side ? { side } : {}),
    })
    telemetry.recordUplink('ticket_confirm')
    void (async () => {
      try {
        // Leg 1 — cancel the order being replaced. The seam audits this leg
        // under its existing 'cancel' kind.
        await seam.cancel(oldOrderId)
      } catch (err) {
        log.error({ err, ticketId, oldOrderId }, 'amend cancel leg failed')
        dropTicket()
        emit(session, {
          type: 'lifecycle',
          ticketId,
          phase: 'expired',
          statusLine: `COULDN'T CANCEL ORDER #${oldOrderId.toUpperCase()} — IT MAY STILL EXECUTE; NO REPLACEMENT WAS PLACED`,
          ...(side ? { side } : {}),
        })
        return
      }
      // Leg 2 — place the replacement through the classic confirm path
      // (audited by the seam's 'confirm' kind), with amend-honest copy.
      emit(session, {
        type: 'lifecycle',
        ticketId,
        phase: 'awaiting_confirm',
        stage: 'placing',
        statusLine: `ORDER #${oldOrderId.toUpperCase()} CANCELLED — SENDING REPLACEMENT TO ${venue}…`,
        cancellable: true,
        ...(side ? { side } : {}),
      })
      confirmedTickets.add(ticketId)
      const quote = session.tickets.get(ticketId)
      if (quote) quote.confirmed = true
      armTicketTimeout(session, ticketId)
      try {
        await seam.confirm(ticketId)
      } catch (err) {
        log.error({ err, ticketId, oldOrderId }, 'amend place leg failed after cancel succeeded')
        dropTicket()
        // The half-done truth, stated in full: the cancel DID happen.
        emit(session, {
          type: 'lifecycle',
          ticketId,
          phase: 'expired',
          statusLine: `ORDER #${oldOrderId.toUpperCase()} WAS CANCELLED, BUT ${venue} REJECTED THE REPLACEMENT — NO ORDER IS WORKING`,
          ...(side ? { side } : {}),
        })
      }
    })()
  }

  // ── interactive order drafts (order_draft → draft_action → prepare) ─────

  /** Keep a pending draft's FIXED fields on the session, bounded (last 5). */
  function rememberDraft(session: Session, draftId: string, fields: DraftFields): void {
    session.drafts.set(draftId, fields)
    while (session.drafts.size > DRAFTS_CAP) {
      const oldest = session.drafts.keys().next().value
      if (oldest === undefined) break
      session.drafts.delete(oldest)
    }
  }

  /**
   * Emit the editable order_draft for an action turn. Prefilled from the
   * parsed order when the intent service extracted one; defaulted (side buy,
   * session-symbol instrument, empty size the trader fills in) when it
   * didn't. Perp bounds (maxLeverage, marginModes) come from the seam's
   * capabilities — fetched best-effort: a seam hiccup degrades the card to
   * spot-only rather than blocking the turn.
   */
  async function emitOrderDraft(
    session: Session,
    order: OrderIntent | undefined,
    text: string,
  ): Promise<void> {
    // capsFetched is the load-bearing distinction: `{spot:{}}` below is a
    // FALLBACK we invented because the seam was unreachable, not venue truth.
    // Fetched caps are enforced (an unsupported capability is declined);
    // the fallback stays lenient exactly as before — degrading a turn on our
    // own ignorance would be worse than letting the seam reject downstream.
    let caps: VenueCapabilities = { spot: {} }
    let capsFetched = false
    try {
      caps = await seam.capabilities()
      capsFetched = true
    } catch (err) {
      log.warn({ err }, 'seam capabilities unavailable — draft falls back to spot, no perp bounds')
    }
    const perp = caps.futures_perp

    // Direction hint for bare actions ("long btc" that parsed as action with
    // no order object) — the draft should still open perp-shaped.
    const hintMatch = /\b(long|short)\b/i.exec(text)?.[1]?.toLowerCase()
    const hint = hintMatch === 'long' || hintMatch === 'short' ? hintMatch : undefined
    const wantsPerp = order?.capability === 'futures_perp' || (!order && hint !== undefined)
    // DEFECT (fixed): "long 0.5 BTC 20x" on a spot-only venue used to render
    // "Set up your BUY BTC order" — no leverage, no mention that perps aren't
    // supported, an unleveraged position the trader never asked for. A perp
    // ask on a venue we KNOW has no perps is declined, never downgraded.
    if (capsFetched && wantsPerp && !perp) {
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `${session.partner.venueName} doesn't support perpetual futures, so I won't quietly turn a leveraged ${hint ?? order?.direction ?? 'long'} into an unleveraged spot buy. Ask for a spot order if that's what you want. Nothing was sent to the venue.`,
      })
      return
    }
    const capability: 'spot' | 'futures_perp' = wantsPerp && perp ? 'futures_perp' : 'spot'
    // Same truth in the other direction: a perp-only venue must not accept a
    // spot draft that only fails at confirm, where the real reason is lost
    // behind a generic hand-off failure. Decline up front.
    if (capsFetched && capability === 'spot' && caps.spot === undefined) {
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `${session.partner.venueName} doesn't support spot orders. Nothing was sent to the venue.`,
      })
      return
    }

    const direction =
      capability === 'futures_perp'
        ? (order?.direction ?? hint ?? (order?.side === 'sell' ? 'short' : 'long'))
        : undefined
    const side: 'buy' | 'sell' = order?.side ?? (direction === 'short' ? 'sell' : 'buy')
    const instrument = normalizeSymbol(order?.instrument) ?? defaultSymbol(session)
    const base = instrument.split('/')[0] ?? instrument
    // Symbol dropdown: session/parsed symbol first, then the majors, deduped.
    // No venue instrument list is exposed to the gateway today — a deliberate
    // simplification until the seam advertises one.
    const symbols = [...new Set([instrument, ...DRAFT_SYMBOL_MAJORS])]
    const maxLeverage =
      capability === 'futures_perp' && perp ? Math.max(1, Math.floor(perp.maxLeverage)) : undefined
    const marginModes = capability === 'futures_perp' && perp ? perp.marginModes : []

    // Protective exits: only OFFERED when the venue advertises protectiveExits
    // for this capability. DESIGN CHOICE (documented): when the parsed order
    // asked for a stop/take-profit the venue can't attach, we DECLINE the
    // whole order rather than open an unprotected position — an order card
    // that silently dropped the protective half would be worse than no card.
    const protectiveSupported =
      capability === 'futures_perp'
        ? perp?.protectiveExits === true
        : caps.spot?.protectiveExits === true
    if (
      !protectiveSupported &&
      (order?.stopLossPrice !== undefined || order?.takeProfitPrice !== undefined)
    ) {
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `${session.partner.venueName} doesn't support attached stop-loss/take-profit orders, so I won't place this without the protection you asked for. Ask again without the stop/take-profit to place the entry alone.`,
      })
      return
    }

    const draftId = `d_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    rememberDraft(session, draftId, {
      capability,
      side,
      ...(direction ? { direction } : {}),
      userText: text,
    })

    emit(session, {
      type: 'order_draft',
      draftId,
      capability,
      title: `Set up your ${(direction ?? side).toUpperCase()} ${base} order`,
      instrument,
      symbols,
      side,
      ...(direction ? { direction } : {}),
      size: order?.size ?? '',
      sizeAsset: base,
      orderType: order?.orderType ?? 'market',
      ...(order?.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
      // Frame presence drives the SDK's stop/take-profit inputs: present
      // (possibly empty) when the venue supports attaching them, absent when
      // it doesn't — the server decides, the SDK never guesses venue truth.
      ...(protectiveSupported
        ? {
            stopLossPrice: order?.stopLossPrice ?? '',
            takeProfitPrice: order?.takeProfitPrice ?? '',
          }
        : {}),
      ...(maxLeverage !== undefined
        ? {
            leverage: Math.min(Math.max(1, Math.floor(order?.leverage ?? 1)), maxLeverage),
            maxLeverage,
            marginMode:
              order?.marginMode && marginModes.includes(order.marginMode)
                ? order.marginMode
                : (marginModes[0] ?? 'isolated'),
            marginModes,
          }
        : {}),
      cta: 'Review order →',
      footnote: `Nothing is sent to ${session.partner.venueName} until you review and confirm.`,
    })
  }

  /**
   * draft_action submit: the SDK's edited params are UNTRUSTED — everything
   * is re-validated here against the venue's capabilities (and the seam
   * validates again downstream; it owns venue truth). A violation emits a
   * crisp rejection_ticket and the seam is never called; success assembles an
   * OrderIntent from the draft's fixed fields + the edited params and runs
   * the EXISTING prepare → order_ticket → confirm → lifecycle flow unchanged.
   */
  async function submitDraft(
    session: Session,
    draftId: string,
    fixed: DraftFields,
    params: {
      instrument: string
      orderType: 'market' | 'limit'
      size: string
      limitPrice?: string
      stopLossPrice?: string
      takeProfitPrice?: string
      leverage?: number
      marginMode?: 'isolated' | 'cross'
    },
  ): Promise<void> {
    const reject = (reason: string): void => {
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason,
        fix: { label: 'Try again', action: fixed.userText },
      })
    }

    const instrument = normalizeSymbol(params.instrument)
    if (!instrument) {
      reject(
        `"${params.instrument}" isn't a valid instrument — use the BASE/QUOTE form, like BTC/USDT.`,
      )
      return
    }
    const sizeNum = Number(params.size)
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
      reject('Size must be a positive number.')
      return
    }
    if (params.orderType === 'limit') {
      const px = Number(params.limitPrice)
      if (params.limitPrice === undefined || !Number.isFinite(px) || px <= 0) {
        reject('Limit orders need a positive limit price.')
        return
      }
    }

    // Protective exits are UNTRUSTED edits like everything else on the card:
    // empty strings read as absent; present values are re-validated below
    // against venue capabilities and basic long/short sanity (the seam
    // re-validates against the actual entry price — it owns venue truth).
    const stopLoss = params.stopLossPrice?.trim() ? params.stopLossPrice.trim() : undefined
    const takeProfit = params.takeProfitPrice?.trim() ? params.takeProfitPrice.trim() : undefined
    const wantsExits = stopLoss !== undefined || takeProfit !== undefined

    // Venue capabilities: needed for perp bounds AND for protective-exit
    // gating (spot included). Best-effort: if the seam can't answer right
    // now, forward and let its own validation (authoritative) decide, rather
    // than blocking the trader here.
    let caps: VenueCapabilities | null = null
    if (fixed.capability === 'futures_perp' || wantsExits) {
      try {
        caps = await seam.capabilities()
      } catch (err) {
        log.warn({ err }, 'seam capabilities unavailable at submit — deferring to seam validation')
      }
    }

    if (wantsExits) {
      const supported =
        fixed.capability === 'futures_perp'
          ? caps?.futures_perp?.protectiveExits === true
          : caps?.spot?.protectiveExits === true
      if (caps && !supported) {
        reject(
          `${session.partner.venueName} doesn't support attached stop-loss/take-profit orders — remove them to place the entry alone.`,
        )
        return
      }
      const slNum = stopLoss !== undefined ? Number(stopLoss) : undefined
      const tpNum = takeProfit !== undefined ? Number(takeProfit) : undefined
      if (slNum !== undefined && (!Number.isFinite(slNum) || slNum <= 0)) {
        reject('Stop-loss must be a positive price.')
        return
      }
      if (tpNum !== undefined && (!Number.isFinite(tpNum) || tpNum <= 0)) {
        reject('Take-profit must be a positive price.')
        return
      }
      const isLong =
        fixed.capability === 'futures_perp' ? fixed.direction !== 'short' : fixed.side === 'buy'
      if (fixed.capability === 'spot' && fixed.side === 'sell') {
        reject('Attached stop-loss/take-profit applies to buy orders — a sell is already an exit.')
        return
      }
      if (
        slNum !== undefined &&
        tpNum !== undefined &&
        (isLong ? slNum >= tpNum : slNum <= tpNum)
      ) {
        reject(
          isLong
            ? 'For a long, the stop-loss must be below the take-profit.'
            : 'For a short, the stop-loss must be above the take-profit.',
        )
        return
      }
      if (params.orderType === 'limit') {
        const px = Number(params.limitPrice)
        if (slNum !== undefined && (isLong ? slNum >= px : slNum <= px)) {
          reject(
            `A stop-loss of ${stopLoss} would trigger immediately against your ${params.limitPrice} entry.`,
          )
          return
        }
        if (tpNum !== undefined && (isLong ? tpNum <= px : tpNum >= px)) {
          reject(
            `A take-profit of ${takeProfit} would fill immediately against your ${params.limitPrice} entry.`,
          )
          return
        }
      }
    }

    if (fixed.capability === 'futures_perp') {
      const perp = caps?.futures_perp
      if (caps && !perp) {
        reject(`${session.partner.venueName} doesn't support perpetual futures.`)
        return
      }
      if (perp) {
        const lev = params.leverage ?? 1
        if (lev < 1 || lev > perp.maxLeverage) {
          reject(`Leverage ${lev}× is outside this venue's 1–${perp.maxLeverage}× range.`)
          return
        }
        if (params.marginMode && !perp.marginModes.includes(params.marginMode)) {
          reject(
            `Margin mode "${params.marginMode}" isn't available here — use ${perp.marginModes.join(' or ')}.`,
          )
          return
        }
      }
    }

    // Validated — the draft is consumed; downstream is the classic flow.
    session.drafts.delete(draftId)

    const order: OrderIntent = {
      ...(fixed.capability === 'futures_perp'
        ? {
            capability: 'futures_perp' as const,
            direction: fixed.direction ?? (fixed.side === 'sell' ? 'short' : 'long'),
            leverage: params.leverage ?? 1,
            marginMode: params.marginMode ?? 'isolated',
            // INVARIANT: drafts are open-only by construction. Close/
            // reduce-only intents never enter the draft flow — the action
            // branch routes them straight to prepareTicket — so 'open' here
            // is deliberate, not a default. If drafts ever carry closes,
            // DraftFields must capture action/reduceOnly and this must
            // forward them.
            action: 'open' as const,
          }
        : {}),
      side: fixed.side,
      size: params.size,
      instrument,
      orderType: params.orderType,
      ...(params.orderType === 'limit' && params.limitPrice !== undefined
        ? { limitPrice: params.limitPrice }
        : {}),
      ...(stopLoss !== undefined ? { stopLossPrice: stopLoss } : {}),
      ...(takeProfit !== undefined ? { takeProfitPrice: takeProfit } : {}),
    }

    // Ticket-shaped skeleton while the seam quotes — same as the classic flow.
    emit(session, { type: 'skeleton', shape: 'ticket' })
    await prepareTicket(session, order, fixed.userText)
  }

  function confirmHandoff(session: Session, ticketId: string): void {
    // Replacement (amend) tickets confirm through the two-leg cancel-then-
    // place path; the mapping is consumed so a re-confirm can't re-cancel.
    const replacesOrderId = amendReplaces.get(ticketId)
    if (replacesOrderId !== undefined) {
      amendReplaces.delete(ticketId)
      confirmAmendHandoff(session, ticketId, replacesOrderId)
      return
    }
    const side = session.tickets.get(ticketId)?.side
    // Neutral copy on purpose: the confirm surface (api vs js_callback) is
    // resolved inside the venue adapter, so "sending" is the only claim the
    // gateway can honestly make here. The venue's own event follows with the
    // surface-true status (PLACED — WORKING, or WAITING FOR YOUR CONFIRM).
    emit(session, {
      type: 'lifecycle',
      ticketId,
      phase: 'awaiting_confirm',
      stage: 'placing',
      statusLine: `SENDING ORDER TO ${session.partner.venueName.toUpperCase()}…`,
      cancellable: true,
      ...(side ? { side } : {}),
    })
    // Venue events (fill, partial, reject) flow back asynchronously through
    // POST /internal/venue-events → onVenueEvent below. If the confirm call
    // itself fails, say so — silence is the one unacceptable outcome. And if
    // NO event ever arrives (lost callback), the armed backstop closes the
    // card honestly instead of waiting forever.
    confirmedTickets.add(ticketId)
    // Mirror the confirm into the durable ticket state (persisted by the
    // armTicketTimeout refresh below): a post-restart resume must restore
    // this, or cancel/routing copy would lie about what reached the venue.
    const quote = session.tickets.get(ticketId)
    if (quote) quote.confirmed = true
    armTicketTimeout(session, ticketId)
    seam.confirm(ticketId).catch((err) => {
      log.error({ err, ticketId }, 'seam confirm failed')
      ticketSessions.delete(ticketId)
      session.tickets.delete(ticketId)
      confirmedTickets.delete(ticketId)
      clearTicketTimeout(ticketId)
      releaseTicket(session, ticketId)
      emit(session, {
        type: 'lifecycle',
        ticketId,
        phase: 'expired',
        statusLine: `COULDN'T HAND OFF TO ${session.partner.venueName.toUpperCase()} — NOTHING EXECUTED`,
        ...(side ? { side } : {}),
      })
    })
    telemetry.recordUplink('ticket_confirm')
  }

  function cancelTicket(session: Session, ticketId: string): void {
    telemetry.recordUplink('ticket_cancel')
    if (!confirmedTickets.has(ticketId)) {
      // Pre-confirm: nothing ever reached the venue — dismiss locally. A
      // dismissed replacement ticket also forgets what it would have
      // replaced (the old order stays untouched and working).
      // Cancelled-instead-of-confirmed is accuracy evidence: record it BEFORE
      // the quote is torn down below (src/accuracy-signals.ts).
      deps.signals?.onTicketCancelled(session, ticketId)
      amendReplaces.delete(ticketId)
      ticketSessions.delete(ticketId)
      session.tickets.delete(ticketId)
      clearTicketTimeout(ticketId)
      releaseTicket(session, ticketId)
      // Fire-and-forget: locally the ticket is gone either way; the seam call
      // stops the venue-side lifecycle.
      seam.cancel(ticketId).catch((err) => log.warn({ err, ticketId }, 'seam cancel failed'))
      emit(session, {
        type: 'lifecycle',
        ticketId,
        phase: 'cancelled',
        statusLine: 'CANCELLED — NOTHING WAS SENT TO THE VENUE',
      })
      return
    }
    // Post-confirm: the order IS on the venue, so "nothing was sent" would be
    // a lie and a racing fill must still reach the trader. Keep the routing
    // entry alive; the venue's own lifecycle event (cancelled — or filled, if
    // the fill won the race) decides the outcome, with the backstop behind it.
    const venue = session.partner.venueName.toUpperCase()
    const side = session.tickets.get(ticketId)?.side
    emit(session, {
      type: 'lifecycle',
      ticketId,
      phase: 'awaiting_confirm',
      stage: 'cancel_pending',
      statusLine: `CANCEL REQUESTED — CONFIRMING WITH ${venue}`,
      cancellable: false,
      ...(side ? { side } : {}),
    })
    seam.cancel(ticketId).then(
      () => armTicketTimeout(session, ticketId),
      (err) => {
        log.warn({ err, ticketId }, 'seam cancel failed post-confirm')
        emit(session, {
          type: 'lifecycle',
          ticketId,
          phase: 'awaiting_confirm',
          stage: 'working', // the order is still live on the venue
          statusLine: `${venue} COULDN'T CANCEL — THE ORDER MAY STILL EXECUTE`,
          cancellable: true,
          ...(side ? { side } : {}),
        })
        armTicketTimeout(session, ticketId)
      },
    )
  }

  /** Cold-restart fallback for venue-event routing: the in-process
   * `ticketSessions` map died with the old pod, but a Redis-backed store
   * holds the durable `session:ticket:{id}` → sessionId mapping. Resolve it,
   * cold-resume the session (frame journal replayed, `session.tickets`
   * rehydrated from meta), re-register the live routing entry, restore the
   * confirm state, and re-arm the backstop. Returns null — the audit-only
   * path — when the store isn't durable, the ticket is unknown/expired, or
   * Redis is unreachable (never an error into the webhook). */
  async function resolveTicketSession(ticketId: string): Promise<Session | null> {
    if (!sessions.resolveTicket || !sessions.resume) return null
    try {
      const sessionId = await sessions.resolveTicket(ticketId)
      if (!sessionId) return null
      const session = await sessions.resume(sessionId)
      if (!session) return null
      ticketSessions.set(ticketId, session)
      if (session.tickets.get(ticketId)?.confirmed) confirmedTickets.add(ticketId)
      armTicketTimeout(session, ticketId)
      log.info({ ticketId, sessionId }, 'venue-event routing restored from durable ticket mapping')
      return session
    } catch (err) {
      log.warn({ err, ticketId }, 'durable ticket resolve failed — treating as unknown ticket')
      return null
    }
  }

  /** Venue lifecycle event (from the seam's callback webhook) → frame.
   * This is the mechanism behind "status changes made elsewhere still arrive
   * in the thread": the frame journal + SSE resume deliver it even if the
   * trader reconnects later. A miss on the live map falls back to the durable
   * ticket mapping (Redis-backed stores), so a gateway restart no longer
   * drops an in-flight order's fill. */
  async function onVenueEvent(event: import('./seam.js').VenueEvent): Promise<boolean> {
    const session =
      ticketSessions.get(event.ticketId) ?? (await resolveTicketSession(event.ticketId))
    if (!session) return false // unknown/expired ticket — audit-only
    const side = session.tickets.get(event.ticketId)?.side
    emit(session, {
      type: 'lifecycle',
      ticketId: event.ticketId,
      phase: event.phase,
      statusLine: event.statusLine,
      ...(event.stage ? { stage: event.stage } : {}),
      ...(event.cancellable !== undefined ? { cancellable: event.cancellable } : {}),
      ...(side ? { side } : {}),
      ...(event.venueOrderId ? { venueOrderId: event.venueOrderId } : {}),
      ...(event.fillPct !== undefined ? { fillPct: event.fillPct } : {}),
      ...(event.rows ? { rows: event.rows } : {}),
    })
    if (event.phase === 'filled') telemetry.recordOrderExecuted(userKey(session))
    // Non-terminal phases: placement/cancel acks (awaiting_confirm) and
    // partials both precede more events — treating them as terminal would
    // delete the routing entry and silently drop the fill that follows.
    if (event.phase === 'awaiting_confirm' || event.phase === 'partial') {
      // Still in flight — push the no-event backstop out another window.
      armTicketTimeout(session, event.ticketId)
    } else {
      ticketSessions.delete(event.ticketId)
      session.tickets.delete(event.ticketId)
      confirmedTickets.delete(event.ticketId)
      clearTicketTimeout(event.ticketId)
      releaseTicket(session, event.ticketId)
    }
    return true
  }

  // ── live price ticker (transient price_tick frames) ─────────────────────

  /** Poll cadence per symbol. Env-tunable (tests shrink it); read per
   * orchestrator so tests set it before buildApp. */
  const tickIntervalMs = Number(process.env.PRICE_TICK_INTERVAL_MS ?? 4_000)

  /** One shared poller per symbol while ≥1 CONNECTED session wants it. */
  const tickers = new Map<
    string,
    { timer: ReturnType<typeof setInterval>; sessions: Set<Session> }
  >()

  /** Register the session's CURRENT symbol with the shared poller (starting
   * one if this symbol had none). Called on stream connect and after a
   * context symbol switch; the old symbol's poller sheds the session on its
   * next poll and stops itself once nobody connected wants it. */
  function watchTicker(session: Session): void {
    const symbol = defaultSymbol(session)
    let entry = tickers.get(symbol)
    if (!entry) {
      const timer = setInterval(() => void pollTicker(symbol), tickIntervalMs)
      timer.unref?.()
      entry = { timer, sessions: new Set() }
      tickers.set(symbol, entry)
      // Prompt first tick rather than a full interval later. setTimeout(0)
      // runs after the connect handler's synchronous tail (streamSession)
      // has attached the transient writer.
      const kick = setTimeout(() => void pollTicker(symbol), 0)
      kick.unref?.()
    }
    entry.sessions.add(session)
  }

  async function pollTicker(symbol: string): Promise<void> {
    const entry = tickers.get(symbol)
    if (!entry) return
    // Prune BEFORE polling: disconnected sessions and sessions whose symbol
    // moved elsewhere; an empty set stops this symbol's poller entirely.
    for (const s of entry.sessions) {
      if (!s.liveTransient || defaultSymbol(s) !== symbol) entry.sessions.delete(s)
    }
    if (entry.sessions.size === 0) {
      clearInterval(entry.timer)
      tickers.delete(symbol)
      return
    }
    let snap: MarketSnapshot
    try {
      snap = await market.snapshot(symbol)
    } catch {
      return // snapshot errored — skip the beat, never a fake tick
    }
    for (const s of entry.sessions) {
      // Transient by contract: emitTransient bypasses the frame journal and
      // writes no SSE id, so a resume replay can never contain a tick.
      emitTransient(s, {
        type: 'price_tick',
        symbol: snap.symbol,
        last: snap.last,
        lastDisplay: snap.lastDisplay,
        changePct: snap.change12hPct,
        asOfIso: snap.asOfIso,
      })
    }
  }

  // ── host actions (chart control) ───────────────────────────────────────

  /**
   * host_action intent → drive the host page's chart, but ONLY when the host
   * opted in (ContextUplink.pageControl). Opted in: emit a validated host_action
   * frame (fresh actionId, server-authored note) plus a short acknowledgment.
   * Not opted in, or an unsupported indicator: an honest one-line notice — never
   * a silently-dropped frame, never a guess.
   */
  function handleHostAction(session: Session, ha: HostActionIntent | undefined): void {
    if (!ha) {
      emit(session, {
        type: 'banner',
        kind: 'info',
        title: 'Chart control',
        text: 'I couldn\'t tell which chart change you meant — try "switch to 5m" or "apply RSI".',
      })
      return
    }
    if (session.pageControl !== true) {
      // The host page never turned on chart control, so a host_action frame
      // would be silently dropped. Say so instead of no-opping.
      emit(session, {
        type: 'banner',
        kind: 'info',
        title: 'Chart control is off',
        text: "This page hasn't enabled chart control, so I can't change the chart from here. You can still switch it on the page itself.",
      })
      return
    }
    // Verb gate (August 2026): emit ONLY what the host declared. A legacy host
    // (pageControl true, no hostActions uplinked) speaks the chart trio only.
    const allowed = session.hostActions ?? LEGACY_CHART_VERBS
    if (!allowed.includes(ha.action)) {
      emit(session, {
        type: 'banner',
        kind: 'info',
        title: 'Not supported on this page',
        text: "This page hasn't declared support for that action, so I left it alone — you can still do it on the page itself.",
      })
      return
    }
    if ((ha.action === 'apply_indicator' || ha.action === 'remove_indicator') && !ha.indicator) {
      // A supported indicator couldn't be resolved — decline honestly.
      emit(session, {
        type: 'banner',
        kind: 'info',
        title: 'Indicator not recognised',
        text: 'I can add or remove RSI, volume, and 20/50 moving averages (SMA/EMA) — I left the chart as-is because that one is not one I know.',
      })
      return
    }
    // Wider-verb param validation — every field re-checked server-side before
    // a frame exists; the host re-validates again at its boundary.
    let params: Record<string, string> | undefined
    if (ha.action === 'set_symbol') {
      // Same symbol rule the context bridge applies to uplinked page symbols.
      const symbol = normalizeSymbol(ha.params?.symbol)
      if (!symbol) {
        emit(session, {
          type: 'banner',
          kind: 'info',
          title: 'Market not recognised',
          text: 'I couldn\'t tell which market you meant — try a pair like "switch to ETH/USDT".',
        })
        return
      }
      params = { symbol }
    } else if (ha.action === 'navigate') {
      const target = ha.params?.target
      if (typeof target !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(target)) {
        emit(session, {
          type: 'banner',
          kind: 'info',
          title: 'Page not recognised',
          text: 'I couldn\'t tell where you wanted to go — try "go to settings" or "open the trade page".',
        })
        return
      }
      params = { target }
    } else if (ha.action === 'prefill_ticket') {
      // side + qty are required; price rides along ONLY when the trader said
      // one — the server never invents a price. All values stay strings.
      const side = ha.params?.side
      const qty = ha.params?.qty
      const price = ha.params?.price
      const DECIMAL_RE = /^\d+\.?\d*$/
      if (
        (side !== 'buy' && side !== 'sell') ||
        typeof qty !== 'string' ||
        !DECIMAL_RE.test(qty) ||
        Number(qty) <= 0
      ) {
        emit(session, {
          type: 'banner',
          kind: 'info',
          title: 'Ticket not prefilled',
          text: 'I need a side and a size to fill the ticket — try "fill the ticket to buy 0.1 BTC".',
        })
        return
      }
      params = { side, qty }
      if (typeof price === 'string' && DECIMAL_RE.test(price) && Number(price) > 0) {
        params.price = price
      }
    } else if (ha.params) {
      // A future verb the host declared: pass its params through untouched —
      // the host validates values against what it actually supports.
      params = ha.params
    }
    const note = hostActionNote({ ...ha, params })
    emit(session, {
      type: 'host_action',
      actionId: `ha_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      action: ha.action,
      ...(ha.timeframe ? { timeframe: ha.timeframe } : {}),
      ...(ha.indicator ? { indicator: ha.indicator } : {}),
      ...(params ? { params } : {}),
      note,
    })
    // Short user-visible acknowledgment (the one-line notice surface).
    emit(session, hostActionAckBanner(ha.action, note))
  }

  /** The one-line notice that rides beside each emitted host_action. The
   * prefill copy is deliberate: it must say the order was NOT submitted. */
  function hostActionAckBanner(
    action: string,
    note: string,
  ): { type: 'banner'; kind: 'info'; title: string; text: string } {
    switch (action) {
      case 'set_symbol':
        return {
          type: 'banner',
          kind: 'info',
          title: 'Market switched',
          text: `${note}. The page follows along — tell me if you want it back.`,
        }
      case 'navigate':
        return {
          type: 'banner',
          kind: 'info',
          title: 'Opening page',
          text: `${note}. The page handles the move from here.`,
        }
      case 'prefill_ticket':
        return {
          type: 'banner',
          kind: 'info',
          title: 'Ticket prefilled',
          text: `${note}. Review it on the page and press Place — nothing was submitted.`,
        }
      case 'set_timeframe':
      case 'apply_indicator':
      case 'remove_indicator':
        return {
          type: 'banner',
          kind: 'info',
          title: 'Chart updated',
          text: `${note}. Tell me if you want anything else on the chart.`,
        }
      default:
        return {
          type: 'banner',
          kind: 'info',
          title: 'Sent to page',
          text: `${note}. The page reports the outcome on the chip above.`,
        }
    }
  }

  // ── consolidated orders (orders_query) ─────────────────────────────────

  /**
   * orders_query intent → the full orders blotter. Reads ALL orders (open +
   * filled + cancelled) from the seam, filters to scope, computes totals over
   * the FULL scoped set BEFORE the 50-row bound (so totals stay true even when
   * truncated), and emits orders_summary. Empty result still emits the frame
   * (empty orders + zero totals) so the SDK renders its empty state.
   */
  async function handleOrdersQuery(session: Session, scope: 'all' | 'session'): Promise<void> {
    let records: OrderRecord[]
    try {
      records = await seam.listOrders(session.partner.partnerId, userKey(session))
    } catch (err) {
      log.error({ err }, 'seam listOrders unavailable')
      emit(session, {
        type: 'rejection_ticket',
        title: 'Orders temporarily unavailable',
        reason: `${session.partner.venueName} isn't answering order queries right now. Your funds and orders are unaffected — try again in a moment.`,
      })
      return
    }
    const created = session.createdTicketIds
    const scoped =
      scope === 'session' ? records.filter((r) => created?.has(r.orderId) ?? false) : records
    const totals = ordersTotals(scoped)
    // Newest first by venue timestamp (records without one sort last), then
    // bound to the protocol's 50-row cap — totals above are already truthful.
    const bounded = [...scoped]
      .sort((a, b) => (b.tsIso ?? '').localeCompare(a.tsIso ?? ''))
      .slice(0, 50)
      .map((r) => ({
        orderId: r.orderId,
        symbol: r.symbol,
        side: r.side,
        kind: r.kind,
        qty: r.qty,
        ...(r.price !== undefined ? { price: r.price } : {}),
        status: r.status,
        ...(r.filledPct !== undefined ? { filledPct: r.filledPct } : {}),
        ...(r.tsIso !== undefined ? { tsIso: r.tsIso } : {}),
      }))
    emit(session, {
      type: 'orders_summary',
      scope,
      asOfIso: new Date().toISOString(),
      orders: bounded,
      totals,
    })
  }

  // ── confidence-aware clarification ─────────────────────────────────────

  /**
   * Ask instead of executing: mint the clarificationId, remember the options
   * (bounded + TTL'd on the session) and emit the frame. The caller RETURNS
   * straight after — a clarification REPLACES the risky execution for this
   * turn, so nothing is prepared, armed or posted to the host until the
   * trader picks one of these options back.
   */
  function askClarification(session: Session, plan: ClarificationPlan, text: string): void {
    const clarificationId = `c_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    if (!session.clarifications) session.clarifications = new Map()
    rememberClarification(session.clarifications, clarificationId, {
      options: plan.options,
      resolutions: plan.resolutions,
      text,
      expiresAt: Date.now() + CLARIFICATION_TTL_MS,
    })
    const original = text.trim()
    emit(session, {
      type: 'clarification',
      clarificationId,
      question: plan.question,
      options: plan.options,
      ...(original ? { originalText: original.slice(0, 280) } : {}),
      note: plan.note,
    })
    telemetry.recordUplink('clarification_asked')
  }

  // ── per-turn routing ───────────────────────────────────────────────────

  /**
   * One turn. `resolved` is the clarified re-run: the trader picked an
   * interpretation off a clarification card, so this turn skips classification
   * entirely and runs the chosen IntentResult down the EXISTING execution
   * paths below — no order, alert or host logic is duplicated for it.
   */
  async function processTurn(
    session: Session,
    text: string,
    resolved?: IntentResult,
  ): Promise<void> {
    const turnStart = Date.now()
    let intentRes: IntentResult
    let degraded = false
    // Span + latency around intent classification (intent-p95 rate-card number).
    const span = telemetry.startSpan('hippo.turn')
    if (resolved) {
      // Nothing left to classify — re-classifying would land on the very
      // guess the trader just corrected. No intent call, no history, and no
      // intent-latency sample (that cost was paid on the asking turn).
      intentRes = resolved
    } else {
      const intentStart = Date.now()
      // Thread context for coreference ("what about ETH?" after a BTC turn) —
      // interpret stage ONLY. First turn assembles to [] and the field is
      // omitted; research calls below never see it.
      const history = assembleHistory(session.journal.after(0))
      try {
        intentRes = await intel.intent({
          text,
          language: session.language,
          ...(history.length > 0 ? { history } : {}),
        })
        telemetry.markHealthy()
        // Recovered: a future degradation episode gets its banner again.
        session.degradedBannerShown = false
      } catch (err) {
        degraded = true
        enterDegraded(session, err)
        intentRes = guessIntent(text)
      }
      telemetry.recordIntent(intentRes.intent, Date.now() - intentStart)
    }
    span.setAttribute('hippo.intent', intentRes.intent)
    span.setAttribute('hippo.degraded', degraded)
    span.end()

    // Low confidence: don't act on a guess — nudge. (Never applies to the
    // deterministic fallback, which pins confidence at 0.5.)
    if (intentRes.intent === 'smalltalk' || intentRes.confidence < LOW_CONFIDENCE) {
      emit(session, nudgeFrame(session))
      return
    }

    // Confidence-aware clarification: a COSTLY intent (order, alert, host page)
    // under the threshold is a guess, and guessing there costs money, durable
    // state or the trader's page — so ASK. This runs BEFORE the interpretation
    // card on purpose: "UNDERSTOOD — preparing an order ticket" above a
    // question we're asking because we did NOT understand would be a lie.
    //
    // Skipped in degraded mode: guessIntent pins confidence at 0.5, so every
    // costly turn would clarify — and its deterministic parse ("buy 0.05 btc")
    // is a parse, not a guess. Skipped on a clarified re-run for the same
    // reason a re-run skips classification.
    if (!degraded && !resolved) {
      const plan = buildClarification(intentRes, {
        symbol: defaultSymbol(session),
        venueName: session.partner.venueName,
      })
      if (plan) {
        askClarification(session, plan, text)
        return
      }
    }

    // Persona read is cheap and unconditional (opt-in accrual + experience
    // depth predate the memory feature). null = opted out or memory down.
    const persona = await memory.get(session.partner.partnerId, userKey(session))

    // Memory composition (Phase C) is PRE-PROD and GATED: only partners whose
    // plan carries the `memoryLab` entitlement get the four freeform scopes
    // composed into the prompt. Unentitled partners behave exactly as before —
    // no scope reads, no memoryContext, empty scopes — so setting a memory doc
    // has zero effect until a super-admin enables the feature per plan.
    const memoryLab = session.partner.entitlements?.memoryLab === true
    let mem = { text: '', scopes: [] as ReturnType<typeof composeMemory>['scopes'] }
    if (memoryLab) {
      // Best-effort: memory down → empty block, never blocks/breaks a turn.
      // Composed as CONTEXT below the answer engine's no-advice guardrail
      // (which stays authoritative — memory never overrides it). Applied
      // scopes surface on the interpretation card + the admin inspector.
      // Freeform scope docs + auto-learned USER (durable, cross-session) and
      // SESSION facts, all best-effort (memory down → '' / [], never blocks or
      // breaks a turn). Read together. The USER facts are what makes a returning
      // trader's fresh session carry their durable memory.
      //
      // Phase C opt-OUT: if the trader turned auto-learning off, the learned
      // facts do NOT compose — but the curated freeform scope docs and the
      // structured persona line still do (those are separate consents), so the
      // block behaves exactly as it did before auto-learning existed.
      const optedOutOfLearning = persona?.learnOptOut === true
      const [docs, userFacts, sessionFacts] = await Promise.all([
        memory.scopeDocs(session.partner.partnerId, userKey(session)),
        optedOutOfLearning
          ? Promise.resolve([])
          : memory.getLearnedFacts('user', {
              partnerId: session.partner.partnerId,
              userId: userKey(session),
            }),
        optedOutOfLearning
          ? Promise.resolve([])
          : memory.getLearnedFacts('session', { sessionId: session.id }),
      ])
      mem = composeMemory({
        global: docs.global,
        host: docs.host,
        user: docs.user,
        personaLine: personaSummary(persona),
        userFacts: formatLearnedFacts(userFacts),
        sessionFacts: formatLearnedFacts(sessionFacts),
      })
      if (mem.text) {
        // Persist the exact composed block for the admin/in-session inspector.
        memory
          .saveComposed(session.id, session.partner.partnerId, userKey(session), mem.text)
          .catch(() => {})
      }
    }

    // Stage-1 "understanding" — a persistent, collapsible card above the
    // answer (replaces the ephemeral thinking line; not itself ephemeral, so
    // it survives the skeleton→answer swap). Degraded-mode guessIntent has no
    // interpretation, so default from the intent. memoryScopes tells the card
    // which layers were applied.
    emit(session, {
      type: 'interpretation',
      summary:
        intentRes.interpretation ??
        defaultInterpretation(intentRes.intent, intentRes.hostAction?.action),
      intent: intentRes.intent,
      memoryScopes: mem.scopes,
    })

    switch (intentRes.intent) {
      case 'research':
      case 'concept': {
        // Serialize research streams per session: stop any in-flight stream
        // and wait for its stopped brief to land BEFORE this turn's skeleton,
        // so the thread never interleaves two streams' prose.
        const prior = activeStreams.get(session.id)
        if (prior) {
          prior.stop()
          await prior.settled
        }
        emit(session, { type: 'skeleton', shape: 'brief' })
        if (degraded) {
          await emitMarketOnlyBrief(session, text)
          return
        }
        // Persona asset/thread accrual — opted-in users only (read above).
        const symbol = symbolFromText(text, defaultSymbol(session))
        if (persona?.optIn) {
          memory
            .update(session.partner.partnerId, userKey(session), {
              followAsset: symbol.split('/')[0] ?? symbol,
              openThread: { text, symbol: symbol.split('/')[0] },
            })
            .catch(() => {}) // fire-and-forget; a turn never waits on memory
        }
        try {
          // Streaming path: brief_delta frames fill the skeleton with prose
          // as the research engine generates; the final research_brief frame
          // is authoritative and replaces the accumulated text in the SDK.
          // Deltas are coalesced (~DELTA_FLUSH_MS) so the frame journal and
          // SSE fan-out carry dozens of frames per brief, not hundreds.
          let pending = ''
          let lastFlush = 0
          let finished = false
          let firstTokenSent = false
          // Everything that streamed, flushed or not — the stopped brief is
          // assembled server-side from exactly this.
          let accumulated = ''
          let metaAsOfIso: string | null = null
          // Model id from the intelligence deltas — forwarded on every
          // brief_delta so provenance shows mid-stream, not just at the end.
          let streamModel: string | undefined
          // First readable token → the first-token-p95 rate-card number.
          const markFirstToken = () => {
            if (firstTokenSent) return
            firstTokenSent = true
            telemetry.recordFirstToken(Date.now() - turnStart, intentRes.intent)
          }
          // stream_stop: the uplink handler fires this session's stop signal;
          // every iteration races the next stream event against it, so a stop
          // lands even while the model is mid-generation between events.
          let requestStop: () => void = () => {}
          const stopSignal = new Promise<typeof STOPPED>((resolve) => {
            requestStop = () => resolve(STOPPED)
          })
          let settle: () => void = () => {}
          const handle = {
            stop: requestStop,
            settled: new Promise<void>((resolve) => {
              settle = resolve
            }),
          }
          activeStreams.set(session.id, handle)
          const stream = intel.respondStream({
            // The RESTRUCTURED query goes to the answer engine (stage-2); the
            // raw text is the fallback when stage-1 didn't rewrite it.
            text: intentRes.restructuredQuery ?? text,
            intent: intentRes.intent,
            symbol,
            ...(persona?.optIn && persona.experienceLevel
              ? { persona: { experienceLevel: persona.experienceLevel } }
              : {}),
            // Layered memory as CONTEXT — the engine keeps its guardrail first.
            ...(mem.text ? { memoryContext: mem.text } : {}),
          })
          try {
            while (true) {
              const nextEvent = stream.next()
              // Abandoned on stop — must never become an unhandled rejection.
              nextEvent.catch(() => {})
              const step = await Promise.race([nextEvent, stopSignal])
              if (step === STOPPED) {
                // Abort consumption (AbortController-equivalent for the SSE
                // generator: return() runs its finally and drops the rest).
                stream.return(undefined).catch(() => {})
                // Flush the coalescing buffer, then emit the authoritative
                // stopped brief — honest, truncated, server-assembled.
                if (pending.trim()) {
                  emit(session, {
                    type: 'brief_delta',
                    text: pending,
                    ...(streamModel ? { model: streamModel } : {}),
                  })
                }
                const stopped = emit(
                  session,
                  stoppedBriefFrame(accumulated, intentRes.intent, metaAsOfIso),
                )
                rememberBrief(stopped, text, intentRes.intent)
                telemetry.recordResearchAnswered(userKey(session))
                return
              }
              if (step.done) break
              const ev = step.value
              if (ev.event === 'delta') {
                // The delta's model tag is additive on the pinned wire
                // contract — read defensively so an older intelligence
                // service (no tag) still streams fine.
                const model = (ev.data as { model?: unknown }).model
                if (typeof model === 'string') streamModel = model
                accumulated += ev.data.text
                pending += ev.data.text
                const now = Date.now()
                if (pending.trim() && now - lastFlush >= DELTA_FLUSH_MS) {
                  markFirstToken()
                  emit(session, {
                    type: 'brief_delta',
                    text: pending,
                    ...(streamModel ? { model: streamModel } : {}),
                  })
                  pending = ''
                  lastFlush = now
                }
              } else if (ev.event === 'done') {
                // Cache-hit path streams straight to done — that's still the
                // first token the trader sees.
                markFirstToken()
                telemetry.recordCache(ev.data.cached)
                const brief = emit(session, briefFrame(ev.data, intentRes.intent))
                rememberBrief(brief, text, intentRes.intent)
                telemetry.recordResearchAnswered(userKey(session))
                // Auto-learn from the delivered answer (gated + fire-and-forget).
                learnFromTurn(
                  session,
                  text,
                  intentRes.interpretation,
                  [ev.data.headline, ...ev.data.paragraphs].join(' '),
                  persona,
                )
                finished = true
              } else if (ev.event === 'replace' || ev.event === 'decline') {
                // Guardrail trip mid-brief is an advice decline too.
                telemetry.recordAdvice(true)
                emit(session, declineFrame(ev.data))
                finished = true
              } else if (ev.event === 'meta') {
                // Snapshot facts land in the final brief either way and the
                // skeleton is already up — no frame. The real asOf is kept so
                // a stopped brief can carry a truthful liveBar.
                const asOf = (ev.data as Record<string, unknown>).asOfIso
                if (typeof asOf === 'string') metaAsOfIso = asOf
              }
            }
            if (!finished) throw new Error('respond stream ended without done/decline')
          } finally {
            settle()
            // Guarded delete: a newer turn may have replaced our handle.
            if (activeStreams.get(session.id) === handle) activeStreams.delete(session.id)
          }
        } catch (err) {
          enterDegraded(session, err)
          await emitMarketOnlyBrief(session, text)
        }
        return
      }

      case 'advice': {
        if (degraded) {
          telemetry.recordAdvice(true)
          emit(session, staticDeclineFrame())
          return
        }
        try {
          const res = await intel.respond({
            text,
            intent: 'advice',
            symbol: symbolFromText(text, defaultSymbol(session)),
          })
          const declined = res.kind === 'decline'
          telemetry.recordAdvice(declined)
          if (declined) {
            emit(session, declineFrame(res))
          } else {
            rememberBrief(emit(session, briefFrame(res, 'research')), text, 'research')
          }
        } catch (err) {
          enterDegraded(session, err)
          telemetry.recordAdvice(true)
          emit(session, staticDeclineFrame())
        }
        return
      }

      case 'action': {
        // Conversational amend ("move my limit to 61k") — resolved against
        // the trader's open orders, never the draft flow.
        if (intentRes.amend) {
          await handleAmend(session, intentRes.amend, text)
          return
        }
        // Fractional close/reduce ("sell half my SOL position"): resolve the
        // fraction against the LIVE position, then flow into the existing
        // close/reduce prepare path below. A failed resolution already
        // emitted its honest decline — never a zero-size order.
        if (
          intentRes.order &&
          typeof intentRes.order.sizeFraction === 'number' &&
          (intentRes.order.action === 'close' || intentRes.order.reduceOnly === true)
        ) {
          emit(session, { type: 'skeleton', shape: 'ticket' })
          const resolved = await resolveFractionalOrder(session, intentRes.order)
          if (resolved === null) return
          await prepareTicket(session, resolved, text)
          return
        }
        // Close/reduce-only orders BYPASS the draft flow: their terms come
        // from the position being closed, so an editable card (symbol/
        // leverage controls) is the wrong surface — and the draft frame
        // carries no action/reduceOnly fields by design, so routing a close
        // through it would resubmit as an OPEN and double exposure instead
        // of reducing it. Guarded here, BEFORE any draft is remembered:
        // closes go straight down the classic prepare → order_ticket path.
        if (
          intentRes.order &&
          (intentRes.order.action === 'close' || intentRes.order.reduceOnly === true)
        ) {
          emit(session, { type: 'skeleton', shape: 'ticket' })
          await prepareTicket(session, intentRes.order, text)
          return
        }
        // Interactive draft flow (replaces instant-prepare): every OPEN
        // action turn gets an EDITABLE order_draft — prefilled when the order
        // parsed fully, defaulted from the session's page-context symbol when
        // it didn't (no more bare rejection for "long BTC"). The trader edits
        // + submits via the draft_action uplink; submit re-validates against
        // venue capabilities and runs the classic prepare → order_ticket flow.
        // Ticket-shaped skeleton while capabilities are fetched — replaces the
        // thinking card (pushFrame's ephemeral rule); the draft replaces it.
        emit(session, { type: 'skeleton', shape: 'ticket' })
        await emitOrderDraft(session, intentRes.order, text)
        return
      }

      case 'portfolio': {
        // Never cached — every read goes to the venue via the seam adapter.
        try {
          const { positions, openOrders } = await seam.portfolio(
            session.partner.partnerId,
            userKey(session),
          )
          emit(session, { type: 'positions', rows: positions })
          // The same read MUST re-sync the orders strip: the SDK derives the
          // OPEN ORDERS badge and the blotter pills from the latest
          // orders_snapshot, so dropping openOrders here leaves both stale.
          emit(session, {
            type: 'orders_snapshot',
            open: openOrders,
            positionsCount: positions.length,
          })
        } catch (err) {
          log.error({ err }, 'seam portfolio unavailable')
          emit(session, {
            type: 'rejection_ticket',
            title: 'Portfolio temporarily unavailable',
            reason: `${session.partner.venueName} isn't answering position queries right now. Your funds and orders are unaffected — try again in a moment.`,
          })
        }
        return
      }

      case 'host_action': {
        // No network call, no venue call — chart control is server-side truth
        // gated only on the host's opt-in.
        handleHostAction(session, intentRes.hostAction)
        return
      }

      case 'orders_query': {
        await handleOrdersQuery(session, intentRes.ordersQuery?.scope ?? 'all')
        return
      }

      case 'alert': {
        // Conversational price alerts (src/alerts.ts owns every rule: cap,
        // cross resolution against the live price, ownership, server-authored
        // conditionLabel). No payload → honest one-line ask, never a guess.
        const ai = intentRes.alertIntent
        if (!ai) {
          emit(session, {
            type: 'banner',
            kind: 'info',
            title: 'Price alerts',
            text: 'Tell me the level and the asset — like "alert me when BTC goes above 70,000".',
          })
          return
        }
        if (ai.action === 'cancel') await alerts.cancelConversational(session, ai.symbol)
        else await alerts.arm(session, ai)
        return
      }

      default:
        emit(session, nudgeFrame(session))
        return
    }
  }

  // ── public surface ─────────────────────────────────────────────────────

  return {
    onStreamConnect(session) {
      const fresh = session.journal.lastSeq() === 0
      // Identity restore FIRST (fresh sessions only — a reconnect's journal
      // replay re-delivers the original identity frame): if this session's
      // sub claimed an identity earlier, adopt it BEFORE the first reads
      // keyed by userKey below, so memory/portfolio never key to the
      // anonymous sub for a signed-in trader.
      const ready = fresh ? identityHandler.restore(session) : Promise.resolve()
      void ready.then(() => {
        // Opening state: current orders strip only. No scripted conversation —
        // the thread starts empty and the SDK shows its empty-state hero.
        // Emit once per session: on reconnect the journal replay covers it.
        // Fetched from the seam asynchronously; if the venue is unreachable
        // the strip simply doesn't render — never a fabricated snapshot.
        if (fresh) {
          seam
            .portfolio(session.partner.partnerId, userKey(session))
            .then(({ openOrders, positions }) => {
              emit(session, {
                type: 'orders_snapshot',
                open: openOrders,
                positionsCount: positions.length,
              })
            })
            .catch((err) => log.warn({ err }, 'orders snapshot unavailable'))
        }
        // "What Hippo remembers about you" — pushed on connect (gated on
        // memoryLab; no-op otherwise). Fire-and-forget; the journal replay
        // re-delivers it on reconnect, the SDK keeps only the latest.
        void emitLearnedMemory(session)
        // Price alerts that TRIGGERED while this user had no live session:
        // deliver them now and mark delivered. Runs AFTER identity restore so
        // the sweep keys to the effective (identity-adopted) user, and on
        // EVERY connect — a reconnect may have missed a trigger too (the
        // journal only replays what was emitted into it). Best-effort.
        void alerts.sweepOnConnect(session)
      })
      // Live price ticker for the session's symbol — transient frames to the
      // connected socket only, never the journal.
      watchTicker(session)
    },

    onVenueEvent,

    handleUplink(session, uplink) {
      telemetry.recordTurn(uplink.kind)
      switch (uplink.kind) {
        case 'user_text':
        case 'chip_tap': {
          if (uplink.kind === 'chip_tap') {
            // Reserved card-action prefixes are commands, not conversation:
            // no echo bubble, no thinking card, no intent classification —
            // "refresh:f_…" must never run as a research turn.
            const action = uplink.text.match(CARD_ACTION_RE)
            if (action) {
              telemetry.recordUplink(`card_${action[1]}`)
              if (action[1] === 'refresh' && action[2]) {
                refreshBrief(session, action[2]).catch((err) => {
                  log.error({ err }, 'brief refresh failed')
                })
              }
              // share:/manage: are telemetry-only acks — the SDK already did
              // the visible work (share overlay / venue deep-link).
              return
            }
          }
          // Echo + thinking go out synchronously — before any network call —
          // to hold the <150ms first-frame budget. guessIntent is the sync
          // deterministic classifier, so order turns get order-shaped status
          // lines in the SAME thinking frame (a second thinking frame would
          // strand a card on old SDKs — pushFrame only replaces the last
          // ephemeral item).
          // Implicit accuracy evidence: a rapid rephrase is read from the
          // journal BEFORE this turn's echo lands, so the last exchange there
          // is still the previous turn (src/accuracy-signals.ts).
          if (uplink.kind === 'user_text') deps.signals?.onUserText(session, uplink.text)
          emit(session, { type: 'user_echo', text: uplink.text })
          const looksLikeOrder = guessIntent(uplink.text).intent === 'action'
          emit(session, {
            type: 'thinking',
            lines: looksLikeOrder
              ? [
                  'Constructing order…',
                  `Checking balance on ${session.partner.venueName}…`,
                  'Preparing your ticket…',
                ]
              : ['Parsing intent…', 'Fetching live market data…', 'Reading funding & flows…'],
          })
          // Total turn latency (uplink → all frames emitted) feeds the
          // operator diagnostics window; a no-op when no sink is wired.
          const turnT0 = Date.now()
          processTurn(session, uplink.text)
            .catch((err) => {
              log.error({ err }, 'turn processing failed')
            })
            .finally(() => telemetry.recordTurnLatency(Date.now() - turnT0))
          return
        }
        case 'ticket_action': {
          if (uplink.action === 'confirm_handoff') confirmHandoff(session, uplink.ticketId)
          else cancelTicket(session, uplink.ticketId)
          return
        }
        case 'draft_action': {
          // Commands, not conversation: no echo, no thinking, no classify.
          const fixed = session.drafts.get(uplink.draftId)
          if (uplink.action === 'dismiss') {
            // Drop the pending draft, no frame — the SDK already collapsed it.
            deps.signals?.onDraftDismissed(session, uplink.draftId, fixed)
            session.drafts.delete(uplink.draftId)
            return
          }
          if (!fixed) {
            // Unknown/expired draft: never guess at an order — say so.
            emit(session, {
              type: 'rejection_ticket',
              title: 'Order not prepared',
              reason: 'This order card has expired — ask for the order again to get a fresh one.',
            })
            return
          }
          if (!uplink.params) {
            emit(session, {
              type: 'rejection_ticket',
              title: 'Order not prepared',
              reason: 'The order card sent no parameters — edit the order and submit again.',
            })
            return
          }
          submitDraft(session, uplink.draftId, fixed, uplink.params).catch((err) => {
            log.error({ err, draftId: uplink.draftId }, 'draft submit failed')
          })
          return
        }
        case 'context': {
          // The host page's market. Context, never a command: an invalid
          // symbol is ignored silently; a valid one becomes the session's
          // default (research/drafts/ticks) and retargets the live ticker.
          const symbol = normalizeSymbol(uplink.symbol)
          if (symbol) {
            session.symbol = symbol
            if (session.liveTransient) watchTicker(session)
          }
          // Host page-control opt-in — mirrors the symbol store above. Only
          // when true will a host_action turn emit a frame; a page that never
          // opted in is answered in prose (handleHostAction).
          if (typeof uplink.pageControl === 'boolean') session.pageControl = uplink.pageControl
          // Host-declared verb set (August 2026) — already bounded by the
          // uplink schema (≤24 verbs, each ≤40 chars). Stored verbatim; the
          // emission gate in handleHostAction reads it. A host that never
          // declares keeps the legacy chart-trio fallback.
          if (Array.isArray(uplink.hostActions)) session.hostActions = uplink.hostActions
          return
        }
        case 'settings': {
          if (uplink.language) session.language = uplink.language
          if (uplink.memoryOptIn !== undefined) {
            memory
              .update(session.partner.partnerId, userKey(session), {
                optIn: uplink.memoryOptIn,
              })
              .catch(() => {})
          }
          if (uplink.clearMemory) {
            // The settings promise: wipe persona data (opt-in choice survives).
            memory.clear(session.partner.partnerId, userKey(session)).catch(() => {})
          }
          if (
            uplink.learnedMemoryOptIn !== undefined &&
            session.partner.entitlements?.memoryLab === true
          ) {
            // Phase C toggle. Persist as the persona's learnOptOut (inverse of
            // the trader-facing "on"). Turning it OFF also forgets everything
            // already learned — "stop remembering" must actually forget — so it
            // reuses the same clear path as clearLearnedMemory. Either way we
            // re-emit "what Hippo remembers" so the SDK reflects the new state
            // (empty + optIn:false when off; resumes learning when back on).
            const optIn = uplink.learnedMemoryOptIn
            void (async () => {
              try {
                await memory.update(session.partner.partnerId, userKey(session), {
                  learnOptOut: !optIn,
                })
                if (!optIn) {
                  await Promise.all([
                    memory.clearLearnedFacts('user', {
                      partnerId: session.partner.partnerId,
                      userId: userKey(session),
                    }),
                    memory.clearLearnedFacts('session', { sessionId: session.id }),
                  ])
                }
                await emitLearnedMemory(session)
              } catch {
                // best-effort: a settings toggle must never surface an error
              }
            })()
          }
          if (uplink.clearLearnedMemory && session.partner.entitlements?.memoryLab === true) {
            // Wipe the auto-learned facts (durable USER + this SESSION), then
            // push a fresh (empty) learned_memory frame so the SDK's "what
            // Hippo remembers" surface clears immediately. Gated + best-effort.
            void (async () => {
              await Promise.all([
                memory.clearLearnedFacts('user', {
                  partnerId: session.partner.partnerId,
                  userId: userKey(session),
                }),
                memory.clearLearnedFacts('session', { sessionId: session.id }),
              ])
              await emitLearnedMemory(session)
            })()
          }
          telemetry.recordUplink('settings')
          return
        }
        case 'consent': {
          // Onboarding consent: the moment memory is allowed to exist.
          memory
            .update(session.partner.partnerId, userKey(session), {
              optIn: uplink.memoryOptIn,
            })
            .catch(() => {})
          telemetry.recordUplink('consent')
          return
        }
        case 'feedback': {
          // Recorded for the L2 export pipeline (BE doc §4); counters only here.
          // A thumbs-DOWN is also joined to the intent we classified for that
          // frame's turn (src/accuracy-signals.ts) — the counter alone never
          // said what we thought the trader wanted.
          deps.signals?.onFeedback(session, uplink)
          telemetry.recordUplink(uplink.kind)
          return
        }
        case 'identity_claim': {
          // Command, not conversation: no echo, no thinking, no classify.
          // All outcomes (ok/taken/wrong_pin/invalid/rate_limited/signed_out)
          // come back as journaled `identity` frames.
          identityHandler.handleClaim(session, uplink).catch((err) => {
            log.error({ err }, 'identity claim failed')
          })
          return
        }
        case 'alert_action': {
          // Command, not conversation: no echo, no thinking, no classify.
          // Cancel is the only alert verb on the wire; a non-armed/unknown/
          // foreign alertId is an idempotent no-op ack — never a crash.
          telemetry.recordUplink('alert_cancel')
          alerts.cancelById(session, uplink.alertId).catch((err) => {
            log.error({ err, alertId: uplink.alertId }, 'alert cancel failed')
          })
          return
        }
        case 'clarification_choice': {
          // Command, not conversation: no echo, no thinking, no classify.
          //
          // The uplink schema validated SHAPE only — zod cannot know which
          // option ids we offered. takeChoice is the check that matters: the
          // clarification must still be open (never answered, never expired)
          // and the optionId must be one WE sent for it. Every refusal is an
          // honest frame; none of them is a silent no-op, and none of them
          // executes anything.
          telemetry.recordUplink('clarification_choice')
          const outcome = session.clarifications
            ? takeChoice(session.clarifications, uplink.clarificationId, uplink.optionId)
            : ({ ok: false, reason: 'unknown' } as const)
          if (!outcome.ok) {
            emit(session, choiceDeclineBanner(outcome.reason))
            return
          }
          // Re-run the ORIGINAL turn with the chosen interpretation. The
          // resolution carries the chosen option's label as its
          // interpretation, so the read-back lands in-thread on the normal
          // interpretation card and the transcript shows what was decided.
          const turnT0 = Date.now()
          processTurn(session, outcome.text, outcome.intent)
            .catch((err) => {
              log.error({ err, clarificationId: uplink.clarificationId }, 'clarified turn failed')
            })
            .finally(() => telemetry.recordTurnLatency(Date.now() - turnT0))
          return
        }
        case 'stream_stop': {
          // Stop the session's in-flight research stream: the consuming loop
          // aborts and emits the stopped brief. No active stream (the brief
          // already landed, or none was running) → silent no-op.
          activeStreams.get(session.id)?.stop()
          return
        }
      }
    },
  }
}
