/** Shared test scaffolding: stub intelligence/market clients + wait helpers. */
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import type {
  BriefResponse,
  IntelligenceClient,
  IntentResult,
  RespondResult,
  RespondStreamEvent,
} from '../src/orchestrator/intelligence.js'
import type { MarketClient, MarketSnapshot } from '../src/orchestrator/market.js'
import type { Session, SessionStore } from '../src/plugins/auth.js'

export const snapshotFixture: MarketSnapshot = {
  symbol: 'BTC/USDT',
  last: 61240,
  lastDisplay: '61,240',
  change12hPct: -4.18,
  change12hDisplay: '−4.2%',
  fundingRate: -0.00008,
  fundingDisplay: '−0.008%',
  spark: [
    63910, 63800, 63500, 63100, 62800, 62400, 62100, 61900, 61600, 61400, 61300, 61250, 61240,
  ],
  asOfIso: '2026-07-14T09:02:05.000Z',
  sources: ['FIXTURE'],
}

export const briefFixture: BriefResponse = {
  kind: 'brief',
  headline: 'BTC is down 4.2% over 12 hours',
  paragraphs: ['Macro-led selloff after the US inflation print.'],
  stats: [
    { k: 'LAST', v: '61,240', tone: 'neutral' },
    { k: '12H', v: '−4.2%', tone: 'neg' },
  ],
  sparkPoints: [11, 8, 15, 13, 11, 22, 26],
  sources: ['PRICE FEED', 'NEWS ×2'],
  followups: ["What's driving SOL volume?"],
  asOfIso: '2026-07-14T09:02:05.000Z',
  cached: false,
}

export function stubIntel(overrides: {
  intent?: (text: string) => IntentResult | Promise<IntentResult>
  respond?: () => RespondResult | Promise<RespondResult>
  respondStream?: () => AsyncGenerator<RespondStreamEvent>
}): IntelligenceClient {
  const respond = async () => (overrides.respond ? overrides.respond() : briefFixture)
  return {
    intent: async ({ text }) =>
      overrides.intent
        ? overrides.intent(text)
        : { intent: 'research', confidence: 0.95, language: 'en' },
    respond,
    // Default stream mirrors respond(): meta then done (or a lone decline),
    // so blocking-era tests keep passing against the streaming orchestrator.
    respondStream:
      overrides.respondStream ??
      async function* () {
        const res = await respond()
        if (res.kind === 'decline') {
          yield { event: 'decline', data: res } as RespondStreamEvent
        } else {
          yield { event: 'meta', data: {} } as RespondStreamEvent
          yield { event: 'done', data: res } as RespondStreamEvent
        }
      },
  }
}

/** An intelligence client that is hard-down — every call rejects. */
export const deadIntel: IntelligenceClient = {
  intent: async () => {
    throw new Error('intelligence unreachable')
  },
  respond: async () => {
    throw new Error('intelligence unreachable')
  },
  // biome-ignore lint/correctness/useYield: hard-down stub — throws before any yield
  respondStream: async function* () {
    throw new Error('intelligence unreachable')
  },
}

export const stubMarket: MarketClient = {
  snapshot: async (symbol) => ({ ...snapshotFixture, symbol }),
}

export const deadMarket: MarketClient = {
  snapshot: async () => {
    throw new Error('market-data unreachable')
  },
}

export type TestGateway = Awaited<ReturnType<typeof buildApp>>

export async function testApp(opts: Parameters<typeof buildApp>[0] = {}): Promise<TestGateway> {
  return buildApp({ intel: stubIntel({}), market: stubMarket, fillDelayMs: 20, ...opts })
}

export async function createSession(
  app: FastifyInstance,
  sessions: SessionStore,
): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/session',
    payload: { partnerKey: 'pk_demo' },
  })
  if (res.statusCode !== 200) throw new Error(`session mint failed: ${res.statusCode}`)
  const { sessionId } = res.json() as { sessionId: string }
  const session = sessions.get(sessionId)
  if (!session) throw new Error('minted session missing from store')
  return session
}

export async function sendTurn(
  app: FastifyInstance,
  sessionId: string,
  uplink: Record<string, unknown>,
): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/turns',
    payload: { v: 1, sessionId, ts: Date.now(), ...uplink },
  })
  return res.statusCode
}

/** Poll until the session journal satisfies a predicate (orchestrator work is async). */
export async function waitForJournal(
  session: Session,
  predicate: (types: string[]) => boolean,
  timeoutMs = 2_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const types = session.journal.after(0).map((e) => e.frame.type)
    if (predicate(types)) return types
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for frames; journal has [${types.join(', ')}]`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

export function frameOfType<T = Record<string, unknown>>(session: Session, type: string): T {
  const entry = session.journal.after(0).find((e) => e.frame.type === type)
  if (!entry) throw new Error(`no ${type} frame in journal`)
  return entry.frame as unknown as T
}
