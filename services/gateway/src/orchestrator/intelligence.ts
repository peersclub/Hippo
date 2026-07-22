/**
 * Client for the intelligence service (Python, services/intelligence) plus the
 * deterministic fallback used when it is unreachable.
 *
 * The wire contract is pinned — the intelligence service implements exactly
 * this; anything the gateway needs beyond it goes through a contract bump on
 * both sides:
 *   POST {INTEL}/v1/intent   {text, language?} → IntentResult
 *   POST {INTEL}/v1/respond  {text, intent, symbol?} → BriefResponse | DeclineResponse
 *   GET  {INTEL}/health      {ok, mode, model}
 */

const INTELLIGENCE_URL = process.env.INTELLIGENCE_URL ?? 'http://localhost:8791'
const INTENT_TIMEOUT_MS = 3_000
const RESPOND_TIMEOUT_MS = 30_000
/** After a failed call, fail fast into the degraded path for this long
 * instead of paying the full intent/respond timeouts on every turn; the
 * first call after the window is the probe (mirrors the intelligence
 * service's own LLM breaker). */
const BREAKER_MS = 15_000

export type IntentKind = 'research' | 'concept' | 'action' | 'advice' | 'portfolio' | 'smalltalk'

export type OrderIntent = {
  /** Absent/'spot' = spot; 'futures_perp' routes to the seam's plan path. */
  capability?: 'spot' | 'futures_perp'
  side: 'buy' | 'sell'
  size: string
  /** e.g. "BTC/USDT" */
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

export type IntentResult = {
  intent: IntentKind
  confidence: number
  language: 'en' | 'hi' | 'hinglish'
  order?: OrderIntent
  /** Stage-1 "understanding" (additive): a one-line restatement for the
   * research-view card, and a crisp rewrite forwarded to the answer engine.
   * Absent from older intelligence builds — callers default gracefully. */
  interpretation?: string
  restructuredQuery?: string
}

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
  /** Rejects on timeout (3s), network error or non-2xx — callers fall back. */
  intent(req: { text: string; language?: string }): Promise<IntentResult>
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
  }): AsyncGenerator<RespondStreamEvent>
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

  if (/position|p&l|pnl|portfolio/.test(t)) {
    return { intent: 'portfolio', confidence: 0.5, language: 'en' }
  }

  if (/should i|good idea|is this the dip/.test(t)) {
    return { intent: 'advice', confidence: 0.5, language: 'en' }
  }

  return { intent: 'research', confidence: 0.5, language: 'en' }
}
