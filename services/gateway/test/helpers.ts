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
import type {
  LearnedFact,
  LearnedFactIds,
  MemoryClient,
  Persona,
  PersonaUpdate,
} from '../src/orchestrator/memory.js'
import type { PreparedTicket, SeamClient, SeamPortfolio } from '../src/orchestrator/seam.js'
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
  model: 'anthropic/claude-haiku-4.5',
}

export function stubIntel(overrides: {
  intent?: (text: string) => IntentResult | Promise<IntentResult>
  respond?: () => RespondResult | Promise<RespondResult>
  respondStream?: (
    req: Parameters<IntelligenceClient['respondStream']>[0],
  ) => AsyncGenerator<RespondStreamEvent>
  extractMemory?: IntelligenceClient['extractMemory']
}): IntelligenceClient {
  const respond = async () => (overrides.respond ? overrides.respond() : briefFixture)
  // Default stream mirrors respond(): meta then done (or a lone decline),
  // so blocking-era tests keep passing against the streaming orchestrator.
  async function* defaultStream(): AsyncGenerator<RespondStreamEvent> {
    const res = await respond()
    if (res.kind === 'decline') {
      yield { event: 'decline', data: res } as RespondStreamEvent
    } else {
      yield { event: 'meta', data: {} } as RespondStreamEvent
      yield { event: 'done', data: res } as RespondStreamEvent
    }
  }
  return {
    intent: async ({ text }) =>
      overrides.intent
        ? overrides.intent(text)
        : { intent: 'research', confidence: 0.95, language: 'en' },
    respond,
    respondStream: (req) =>
      overrides.respondStream ? overrides.respondStream(req) : defaultStream(),
    extractMemory: overrides.extractMemory ?? (async () => []),
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
  // Extraction is best-effort; even hard-down it must resolve, never reject
  // (the orchestrator treats [] as "nothing learned this turn").
  extractMemory: async () => [],
}

export const stubMarket: MarketClient = {
  snapshot: async (symbol) => ({ ...snapshotFixture, symbol }),
}

/** In-test memory client backed by the real store semantics, call-recorded. */
export function stubMemory(initial?: Partial<Persona>): MemoryClient & {
  personas: Map<string, Persona>
  updates: Array<{ userId: string; patch: PersonaUpdate }>
  clears: string[]
  scopeDocsData: { global: string; host: string; user: string }
  composed: Map<string, string>
  learnedFacts: Map<string, LearnedFact[]>
} {
  const personas = new Map<string, Persona>()
  const updates: Array<{ userId: string; patch: PersonaUpdate }> = []
  const clears: string[] = []
  // Scope docs the test can preset; composed snapshots the orchestrator wrote.
  const scopeDocsData = { global: '', host: '', user: '' }
  const composed = new Map<string, string>()
  // Auto-learned facts, keyed by scope+ids, so tests can assert what accrued.
  const learnedFacts = new Map<string, LearnedFact[]>()
  const factsKey = (scope: string, ids: LearnedFactIds) =>
    scope === 'user' ? `user:${ids.partnerId}:${ids.userId}` : `session:${ids.sessionId}`
  const blank = (): Persona => ({
    optIn: false,
    experienceLevel: null,
    followedAssets: [],
    openThreads: [],
    updatedAt: 0,
    ...initial,
  })
  return {
    personas,
    updates,
    clears,
    async get(partnerId, userId) {
      return personas.get(`${partnerId}:${userId}`) ?? blank()
    },
    async update(partnerId, userId, patch) {
      updates.push({ userId, patch })
      const key = `${partnerId}:${userId}`
      const cur = personas.get(key) ?? blank()
      personas.set(key, {
        ...cur,
        ...(patch.optIn !== undefined ? { optIn: patch.optIn } : {}),
        ...(patch.experienceLevel !== undefined ? { experienceLevel: patch.experienceLevel } : {}),
        ...(patch.followAsset && (patch.optIn ?? cur.optIn)
          ? { followedAssets: [patch.followAsset.toUpperCase(), ...cur.followedAssets] }
          : {}),
        updatedAt: Date.now(),
      })
    },
    async clear(_partnerId, userId) {
      clears.push(userId)
    },
    scopeDocsData,
    composed,
    learnedFacts,
    async scopeDocs() {
      return { ...scopeDocsData }
    },
    async saveComposed(sessionId, _p, _u, text) {
      composed.set(sessionId, text)
    },
    async getComposed(sessionId) {
      const c = composed.get(sessionId)
      return c === undefined ? null : { composed: c, updatedAt: 1 }
    },
    async getLearnedFacts(scope, ids) {
      return [...(learnedFacts.get(factsKey(scope, ids)) ?? [])]
    },
    async upsertLearnedFacts(scope, ids, facts) {
      // Minimal merge for tests: dedup by (type,value), auto source, timestamped.
      const key = factsKey(scope, ids)
      const cur = learnedFacts.get(key) ?? []
      const now = Date.now()
      for (const f of facts) {
        const existing = cur.find((c) => c.type === f.type && c.value === f.value)
        if (existing) {
          existing.confidence = f.confidence
          existing.updatedAt = now
        } else {
          cur.push({
            type: f.type,
            value: f.value,
            confidence: f.confidence,
            source: f.source ?? 'auto',
            createdAt: now,
            updatedAt: now,
          })
        }
      }
      learnedFacts.set(key, cur)
    },
  }
}

export const ticketFixture: PreparedTicket = {
  ticketId: 't_fixture001',
  side: 'buy',
  instrument: 'BTC/USDT',
  orderType: 'market',
  sideLabel: 'BUY · MKT',
  rows: [
    { label: 'Instrument', value: 'BTC / USDT' },
    { label: 'Size', value: '0.05 BTC' },
    { label: 'Est. price', value: '61,240' },
    { label: 'Est. cost incl. fees', value: '3,065.06 USDT' },
  ],
}

export const portfolioFixture: SeamPortfolio = {
  positions: [
    {
      instrument: 'BTC/USDT',
      size: '0.31 BTC',
      entry: '58,420',
      mark: '61,240',
      pnl: '+874.20 USDT',
      tone: 'pos',
    },
  ],
  openOrders: [{ orderId: 'o_btc', side: 'buy', summary: 'BUY 0.05 BTC · MKT', status: 'OPEN' }],
}

/** Call-recording seam client with fixture responses. */
export function stubSeam(): SeamClient & {
  prepares: unknown[]
  confirms: string[]
  cancels: string[]
} {
  const prepares: unknown[] = []
  const confirms: string[] = []
  const cancels: string[] = []
  return {
    prepares,
    confirms,
    cancels,
    async prepare(req) {
      prepares.push(req)
      return { ...ticketFixture, side: req.side, instrument: req.instrument }
    },
    async confirm(ticketId) {
      confirms.push(ticketId)
    },
    async cancel(ticketId) {
      cancels.push(ticketId)
    },
    async portfolio() {
      return portfolioFixture
    },
  }
}

/** A seam client that is hard-down — every call rejects. */
export const deadSeam: SeamClient = {
  prepare: async () => {
    throw new Error('seam unreachable')
  },
  confirm: async () => {
    throw new Error('seam unreachable')
  },
  cancel: async () => {
    throw new Error('seam unreachable')
  },
  portfolio: async () => {
    throw new Error('seam unreachable')
  },
}

/** A memory client that is hard-down — reads null, writes reject. */
export const deadMemory: MemoryClient = {
  get: async () => null,
  update: async () => {
    throw new Error('memory unreachable')
  },
  clear: async () => {
    throw new Error('memory unreachable')
  },
  // Down memory → the compose path degrades to empty docs, never throws into
  // the turn (the orchestrator must treat memory as best-effort).
  scopeDocs: async () => ({ global: '', host: '', user: '' }),
  saveComposed: async () => {},
  getComposed: async () => null,
  // Facts degrade to [] on read; writes reject like the other mutations (the
  // orchestrator's learnFromTurn swallows it — auto-learning is best-effort).
  getLearnedFacts: async () => [],
  upsertLearnedFacts: async () => {
    throw new Error('memory unreachable')
  },
}

export const deadMarket: MarketClient = {
  snapshot: async () => {
    throw new Error('market-data unreachable')
  },
}

export type TestGateway = Awaited<ReturnType<typeof buildApp>>

const stubClients = (): Parameters<typeof buildApp>[0] => ({
  intel: stubIntel({}),
  market: stubMarket,
  memory: stubMemory(),
  seam: stubSeam(),
})

/** Shared internal token the test suite mints internal-route requests with. */
export const TEST_INTERNAL_TOKEN = 'test-internal'

/**
 * Default test gateway. devMode is forced ON (the suite exercises anonymous
 * dev sessions) and an internal token is configured (so /internal/* routes are
 * reachable). Rate limiting is OFF by default so functional tests aren't
 * throttled — the rate-limit suite opts back in with an explicit small limit.
 * All three are plain defaults any caller can override via `opts`.
 */
export async function testApp(opts: Parameters<typeof buildApp>[0] = {}): Promise<TestGateway> {
  return buildApp({
    ...stubClients(),
    devMode: true,
    internalToken: TEST_INTERNAL_TOKEN,
    rateLimit: false,
    ...opts,
  })
}

/** Like testApp but WITHOUT the dev-mode / internal-token / rate-limit
 * defaults — used to assert the production-safe defaults (opt-in dev mode). */
export async function testAppRaw(opts: Parameters<typeof buildApp>[0] = {}): Promise<TestGateway> {
  return buildApp({ ...stubClients(), ...opts })
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
