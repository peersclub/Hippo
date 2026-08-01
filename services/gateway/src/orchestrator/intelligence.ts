/**
 * Client for the intelligence service (Python, services/intelligence) plus the
 * deterministic fallback used when it is unreachable.
 *
 * The wire contract is pinned — the intelligence service implements exactly
 * this; anything the gateway needs beyond it goes through a contract bump on
 * both sides:
 *   POST {INTEL}/v1/intent   {text, language?, history?} → IntentResult
 *   POST {INTEL}/v1/respond  {text, intent, symbol?} → BriefResponse | DeclineResponse
 *   GET  {INTEL}/health      {ok, mode, model}
 */

const INTELLIGENCE_URL = process.env.INTELLIGENCE_URL ?? 'http://localhost:8791'
const INTENT_TIMEOUT_MS = 3_000
const RESPOND_TIMEOUT_MS = 30_000
/** Extraction runs AFTER the answer is delivered, so it never sits on the
 * trader's critical path — but keep it snappy so it can't pile up. */
const EXTRACT_TIMEOUT_MS = 4_000
/** After a failed call, fail fast into the degraded path for this long
 * instead of paying the full intent/respond timeouts on every turn; the
 * first call after the window is the probe (mirrors the intelligence
 * service's own LLM breaker). */
const BREAKER_MS = 15_000

export type IntentKind =
  | 'research'
  | 'concept'
  | 'action'
  | 'advice'
  | 'portfolio'
  | 'smalltalk'
  // Host-interaction wave (July 2026): chart control + consolidated orders.
  | 'host_action'
  | 'orders_query'

/** Chart-control intent (host_action). `indicator` is a supported slug when the
 * intelligence service could canonicalise it; ABSENT when the phrasing named an
 * unsupported indicator — the orchestrator then declines honestly rather than
 * guessing. Mirrors @hippo/protocol HostActionFrame's action/timeframe vocab. */
export type HostActionIntent = {
  action: 'set_timeframe' | 'apply_indicator' | 'remove_indicator'
  timeframe?: '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
  indicator?: string
}

/** Consolidated-orders intent (orders_query). "my orders" defaults to 'all';
 * this-session/today wording → 'session'. */
export type OrdersQueryIntent = { scope: 'all' | 'session' }

/** One prior thread turn, assembled by the orchestrator from the session's
 * frame journal (user echoes + assistant answer HEADLINES, never brief
 * bodies). Feeds the INTERPRET stage only — history must never reach the
 * research stage or its cache key, so the fleet-wide answer cache (keyed on
 * the canonical restructured question) keeps its hit-rate economics. */
export type HistoryItem = { role: 'user' | 'assistant'; text: string }

export type OrderIntent = {
  /** Absent/'spot' = spot; 'futures_perp' routes to the seam's plan path. */
  capability?: 'spot' | 'futures_perp'
  side: 'buy' | 'sell'
  size: string
  /** Fractional close/reduce ("sell half my SOL"): 0 < f ≤ 1 and size is ""
   * — the orchestrator resolves the fraction against the LIVE position via
   * the seam before preparing. Absent for absolute-size orders. */
  sizeFraction?: number
  /** e.g. "BTC/USDT" — "" on fractional orders that named no asset (the
   * orchestrator substitutes the session's page symbol, like drafts do). */
  instrument: string
  orderType: 'market' | 'limit'
  limitPrice?: string
  // futures_perp only:
  direction?: 'long' | 'short'
  leverage?: number
  marginMode?: 'isolated' | 'cross'
  action?: 'open' | 'close'
  reduceOnly?: boolean
}

/** Conversational amend ("move my limit to 61k") — v1 is a replacement
 * ticket: the orchestrator finds the trader's single open order, prepares a
 * new ticket at the amended price/size, and on confirm cancels the old venue
 * order before placing the new one. At most one of price/size is set. */
export type AmendIntent = { price?: string; size?: string }

export type IntentResult = {
  intent: IntentKind
  confidence: number
  language: 'en' | 'hi' | 'hinglish'
  order?: OrderIntent
  /** Amend marker when the action is "change my working order" (additive;
   * produced by the intelligence fast-path only). */
  amend?: AmendIntent
  /** Chart-control payload when intent is 'host_action' (additive). */
  hostAction?: HostActionIntent
  /** Orders-blotter scope when intent is 'orders_query' (additive). */
  ordersQuery?: OrdersQueryIntent
  /** Stage-1 "understanding" (additive): a one-line restatement for the
   * research-view card, and a crisp rewrite forwarded to the answer engine.
   * Absent from older intelligence builds — callers default gracefully. */
  interpretation?: string
  restructuredQuery?: string
}

/** A candidate durable fact the extractor pulled from a turn. The intelligence
 * service already canonicalises + allowlists these (closed vocab, no directives);
 * the gateway treats them as opaque data to forward to the memory store. */
export type LearnedFactCandidate = { type: string; value: string; confidence: number }

export type BriefResponse = {
  kind: 'brief'
  headline: string
  paragraphs: string[]
  stats: Array<{ k: string; v: string; tone: 'pos' | 'neg' | 'neutral' }>
  sparkPoints?: number[]
  sources: string[]
  followups: string[]
  asOfIso: string
  cached: boolean
  /** Real model id (e.g. "anthropic/claude-haiku-4.5"), or "mock" when the
   * LLM was unreachable/unset — surfaced in the SDK card and admin panel. */
  model: string
}

export type DeclineResponse = {
  kind: 'decline'
  message: string
  pivotTitle: string
  facts: Array<{ icon: string; text: string }>
  followups: string[]
}

export type RespondResult = BriefResponse | DeclineResponse

/**
 * Events from POST /v1/respond/stream (SSE). Order on the wire:
 * meta (snapshot facts before the model's first token) → delta* → done,
 * or replace (output guardrail tripped mid-stream) / decline (advice).
 */
export type RespondStreamEvent =
  | { event: 'meta'; data: Record<string, unknown> }
  | { event: 'delta'; data: { text: string } }
  | { event: 'done'; data: BriefResponse }
  | { event: 'replace'; data: DeclineResponse }
  | { event: 'decline'; data: DeclineResponse }

export interface IntelligenceClient {
  /** Rejects on timeout (3s), network error or non-2xx — callers fall back.
   * `history` (additive) is the bounded thread context for coreference —
   * interpret-stage only; omit it entirely on a first turn. */
  intent(req: { text: string; language?: string; history?: HistoryItem[] }): Promise<IntentResult>
  /** Rejects on timeout (30s), network error or non-2xx. */
  respond(req: { text: string; intent: string; symbol?: string }): Promise<RespondResult>
  /**
   * Streaming respond. Throws (before or mid-iteration) on timeout, network
   * error or non-2xx — callers fall back to `respond` degraded handling.
   * `persona` is the thin personalization layer (memo §9): experience level
   * calibrates concept-answer depth; market briefs stay fleet-wide.
   */
  respondStream(req: {
    text: string
    intent: string
    symbol?: string
    persona?: { experienceLevel: 'new' | 'intermediate' | 'pro' }
    /** Layered memory context (platform → venue → user → session). Passed as
     * context ONLY; the engine keeps its no-advice guardrail authoritative. */
    memoryContext?: string
  }): AsyncGenerator<RespondStreamEvent>
  /**
   * Post-turn auto-learning: extract durable, allowlisted trading facts from a
   * completed turn. Fire-and-forget by contract — NEVER throws and NEVER blocks
   * the answer path; any failure (down/slow/mock) resolves to `[]`. Does not
   * touch the answer-path breaker.
   */
  extractMemory(req: {
    query: string
    interpretation?: string
    answer?: string
  }): Promise<LearnedFactCandidate[]>
}

async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`intelligence ${res.status} for ${url}`)
  return (await res.json()) as T
}

/** Minimal SSE reader over fetch: yields {event, data} per event block. */
async function* readSse(
  url: string,
  body: unknown,
  timeoutMs: number,
): AsyncGenerator<{ event: string; data: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok || !res.body) throw new Error(`intelligence ${res.status} for ${url}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep = buf.indexOf('\n\n')
      while (sep !== -1) {
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        let event = 'message'
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (data) yield { event, data: JSON.parse(data) }
        sep = buf.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function createIntelligenceClient(baseUrl = INTELLIGENCE_URL): IntelligenceClient {
  let downUntil = 0

  function gate(): void {
    if (Date.now() < downUntil) {
      throw new Error('intelligence breaker open — routing degraded')
    }
  }

  async function guarded<T>(call: () => Promise<T>): Promise<T> {
    gate()
    try {
      const result = await call()
      downUntil = 0
      return result
    } catch (err) {
      downUntil = Date.now() + BREAKER_MS
      throw err
    }
  }

  async function* guardedStream(
    open: () => AsyncGenerator<RespondStreamEvent>,
  ): AsyncGenerator<RespondStreamEvent> {
    gate()
    try {
      yield* open()
      downUntil = 0
    } catch (err) {
      downUntil = Date.now() + BREAKER_MS
      throw err
    }
  }

  return {
    intent: (req) =>
      guarded(() => postJson<IntentResult>(`${baseUrl}/v1/intent`, req, INTENT_TIMEOUT_MS)),
    respond: (req) =>
      guarded(() => postJson<RespondResult>(`${baseUrl}/v1/respond`, req, RESPOND_TIMEOUT_MS)),
    respondStream: (req) =>
      guardedStream(
        () =>
          readSse(
            `${baseUrl}/v1/respond/stream`,
            req,
            RESPOND_TIMEOUT_MS,
          ) as AsyncGenerator<RespondStreamEvent>,
      ),
    // Deliberately OUTSIDE `guarded`: extraction is best-effort and post-answer,
    // so a hiccup here must neither throw to the caller nor trip the breaker
    // that routes real answers. Always resolves to an array.
    async extractMemory(req) {
      try {
        const { facts } = await postJson<{ facts?: LearnedFactCandidate[] }>(
          `${baseUrl}/v1/extract-memory`,
          req,
          EXTRACT_TIMEOUT_MS,
        )
        return Array.isArray(facts) ? facts : []
      } catch {
        return []
      }
    },
  }
}

/**
 * SLA degraded-mode contract: when the intelligence service is down or slow,
 * the gateway still answers every turn — orders, prices and portfolio stay
 * fully live, research degrades to a market-data-only brief. This minimal
 * deterministic classifier routes turns in that mode. It is intentionally
 * dumb and side-effect-free: no model, no network, same answer every time.
 */
export function guessIntent(text: string): IntentResult {
  const t = text.toLowerCase()

  // "long 0.5 btc 10x" / "short 1 eth 20x isolated" → futures_perp action.
  const p = t.match(/\b(long|short)\s+([\d,]*\.?\d+)\s*([a-z]{2,10})\b(?:\D*?(\d{1,3})x)?/)
  if (p) {
    const [, dir, size, asset, lev] = p as unknown as [
      string,
      'long' | 'short',
      string,
      string,
      string | undefined,
    ]
    return {
      intent: 'action',
      confidence: 0.5,
      language: 'en',
      order: {
        capability: 'futures_perp',
        side: dir === 'long' ? 'buy' : 'sell',
        direction: dir,
        action: 'open',
        leverage: lev ? Number(lev) : 10,
        marginMode: /\bcross\b/.test(t) ? 'cross' : 'isolated',
        reduceOnly: /\b(reduce|close)\b/.test(t),
        size: size.replaceAll(',', ''),
        instrument: `${asset.toUpperCase()}/USDT`,
        orderType: 'market',
      },
    }
  }

  // "buy 0.05 btc" / "sell 12 sol" → action with extracted order params.
  const m = t.match(/\b(buy|sell)\s+([\d,]*\.?\d+)\s*([a-z]{2,10})\b/)
  if (m) {
    const [, side, size, asset] = m as unknown as [string, 'buy' | 'sell', string, string]
    return {
      intent: 'action',
      confidence: 0.5,
      language: 'en',
      order: {
        side,
        size: size.replaceAll(',', ''),
        instrument: `${asset.toUpperCase()}/USDT`,
        orderType: 'market',
      },
    }
  }

  // Host actions and orders queries stay fully live in degraded mode — they
  // never needed the model. Checked BEFORE portfolio so "my orders" routes to
  // the blotter, not the positions view. Mirrors the intelligence fast-path.
  const hostAction = guessHostAction(t)
  if (hostAction) return { intent: 'host_action', confidence: 0.5, language: 'en', hostAction }
  if (/\borders?\b|what (?:have|did) i traded?|my trades?/.test(t)) {
    const scope: 'all' | 'session' =
      /this session|current session|this chat|this conversation|right now|just (?:now|placed|made)|today|so far/.test(
        t,
      )
        ? 'session'
        : 'all'
    return { intent: 'orders_query', confidence: 0.5, language: 'en', ordersQuery: { scope } }
  }

  if (/position|p&l|pnl|portfolio/.test(t)) {
    return { intent: 'portfolio', confidence: 0.5, language: 'en' }
  }

  if (/should i|good idea|is this the dip/.test(t)) {
    return { intent: 'advice', confidence: 0.5, language: 'en' }
  }

  return { intent: 'research', confidence: 0.5, language: 'en' }
}

/** Chart-control canonicalisers — mirror of the intelligence service's, used
 * only in the degraded-mode `guessIntent` above so chart control keeps working
 * when the model is down. */
const TF_TRIGGER =
  /\b(?:timeframe|time frame|candles?|chart|interval|switch|change|set|make|view|show me|go to|zoom)\b/
const APPLY_RE = /\b(?:apply|add|show|enable|overlay|put|plot|display|turn on)\b/
const REMOVE_RE = /\b(?:remove|hide|clear|disable|drop|turn off|take off|get rid of)\b/
const INDICATOR_HINT = /\b(?:rsi|sma\d*|ema\d*|vol|volume|moving\s*average|ma\d*|indicator)\b/

function canonTimeframe(t: string): HostActionIntent['timeframe'] | undefined {
  const m = t.match(/\b(1m|5m|15m|1h|4h|1d)\b/)
  if (m) return m[1] as HostActionIntent['timeframe']
  const min = t.match(/\b(\d{1,2})\s*(?:min|mins|minute|minutes)\b/)
  if (min && ['1', '5', '15'].includes(min[1] as string))
    return `${min[1]}m` as HostActionIntent['timeframe']
  const hr = t.match(/\b(\d{1,2})\s*(?:h|hr|hrs|hour|hours)\b/)
  if (hr && ['1', '4'].includes(hr[1] as string))
    return `${hr[1]}h` as HostActionIntent['timeframe']
  if (/\b(?:daily|day\s*candles?|1\s*day|one\s*day)\b/.test(t)) return '1d'
  return undefined
}

function canonIndicator(t: string): string | undefined {
  if (/\brsi\b/.test(t)) return 'rsi'
  if (/\b(?:vol|volume)\b/.test(t)) return 'vol'
  const slug = t.match(/\b(sma|ema)\s*(\d{1,3})\b/)
  if (slug) {
    if (slug[1] === 'ema') return 'ema20'
    return slug[2] === '50' ? 'sma50' : 'sma20'
  }
  const isEma = /\b(?:ema|exponential)\b/.test(t)
  const isSma = /\b(?:sma|simple|ma|moving\s*average)\b/.test(t)
  if (!isEma && !isSma) return undefined
  if (isEma) return 'ema20'
  const period = t.match(/\b(\d{1,3})\b/)
  return period && period[1] === '50' ? 'sma50' : 'sma20'
}

/** Deterministic host-action detection for degraded mode. Returns undefined
 * when the message isn't a chart command. */
function guessHostAction(t: string): HostActionIntent | undefined {
  const tf = canonTimeframe(t)
  if (tf && TF_TRIGGER.test(t)) return { action: 'set_timeframe', timeframe: tf }
  const remove = REMOVE_RE.test(t)
  const apply = APPLY_RE.test(t)
  if ((remove || apply) && INDICATOR_HINT.test(t)) {
    const indicator = canonIndicator(t)
    return {
      action: remove ? 'remove_indicator' : 'apply_indicator',
      ...(indicator ? { indicator } : {}),
    }
  }
  return undefined
}
