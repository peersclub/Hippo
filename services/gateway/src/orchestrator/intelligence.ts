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

export type IntentKind = 'research' | 'concept' | 'action' | 'advice' | 'portfolio' | 'smalltalk'

export type OrderIntent = {
  side: 'buy' | 'sell'
  size: string
  /** e.g. "BTC/USDT" */
  instrument: string
  orderType: 'market' | 'limit'
  limitPrice?: string
}

export type IntentResult = {
  intent: IntentKind
  confidence: number
  language: 'en' | 'hi' | 'hinglish'
  order?: OrderIntent
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
}

export type DeclineResponse = {
  kind: 'decline'
  message: string
  pivotTitle: string
  facts: Array<{ icon: string; text: string }>
  followups: string[]
}

export type RespondResult = BriefResponse | DeclineResponse

export interface IntelligenceClient {
  /** Rejects on timeout (3s), network error or non-2xx — callers fall back. */
  intent(req: { text: string; language?: string }): Promise<IntentResult>
  /** Rejects on timeout (30s), network error or non-2xx. */
  respond(req: { text: string; intent: string; symbol?: string }): Promise<RespondResult>
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

export function createIntelligenceClient(baseUrl = INTELLIGENCE_URL): IntelligenceClient {
  return {
    intent: (req) => postJson<IntentResult>(`${baseUrl}/v1/intent`, req, INTENT_TIMEOUT_MS),
    respond: (req) => postJson<RespondResult>(`${baseUrl}/v1/respond`, req, RESPOND_TIMEOUT_MS),
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
