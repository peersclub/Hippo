/**
 * Production gateway — sessions, SSE frame journal with resume, orchestrator.
 * Speaks the exact wire surface the SDK was built against (identical to
 * services/mock-gateway): POST /v1/session, GET /v1/stream (SSE),
 * POST /v1/turns, GET /health. See Build Plan/10 BE Architecture §1–2.
 */
import { timingSafeEqual } from 'node:crypto'
import cors from '@fastify/cors'
import { Uplink } from '@hippo/protocol'
import {
  type AlertStore,
  getPool,
  INTENT_SIGNALS_LIST_CAP,
  InMemoryAlertStore,
  InMemoryIntentSignalStore,
  InMemoryMauStore,
  InMemoryPartnerStore,
  InMemoryPlanStore,
  InMemoryUploadedFileStore,
  InMemoryUserIdentityStore,
  InMemoryUserStore,
  type IntentSignalKind,
  type IntentSignalStore,
  type MauStore,
  monthKey,
  type PartnerStore,
  type PlanStore,
  PostgresAlertStore,
  PostgresIntentSignalStore,
  PostgresMauStore,
  PostgresPartnerStore,
  PostgresPlanStore,
  PostgresUploadedFileStore,
  PostgresUserIdentityStore,
  PostgresUserStore,
  type UploadedFileStore,
  type UserIdentityStore,
  type UserStore,
} from '@hippo/stores'
import Fastify from 'fastify'
import { createAccuracySignals, mergeSummaries, toEvalRows, toJsonl } from './accuracy-signals.js'
import { createAlertsEngine } from './alerts.js'
import { Diagnostics, instrumentClient } from './diagnostics.js'
import { createOrchestrator } from './orchestrator/index.js'
import { createIntelligenceClient } from './orchestrator/intelligence.js'
import { createMarketClient, normalizeSymbol } from './orchestrator/market.js'
import { createMemoryClient } from './orchestrator/memory.js'
import { createSeamClient } from './orchestrator/seam.js'
import { authenticate, createSessionStore, type SessionStore } from './plugins/auth.js'
import { createRateLimiter, type RateLimitOptions } from './plugins/rate-limit.js'
import { createEmitter, streamSession } from './plugins/sse.js'
import { Telemetry } from './plugins/telemetry.js'
import { InMemoryShareStore, registerShareRoutes, type ShareStore } from './shares.js'
import { createFileAnalysisClient } from './upload/analysis.js'
import { registerFileUploadRoute } from './upload/route.js'

const PORT = Number(process.env.PORT ?? 8788)

// Build provenance: stamped by the Docker build (Railway build args); an
// unstamped build reports "unknown", never a guessed value.
const GIT_SHA = process.env.GIT_SHA || 'unknown'
const BUILT_AT = process.env.BUILT_AT || 'unknown'

export type GatewayOptions = {
  intel?: import('./orchestrator/intelligence.js').IntelligenceClient
  market?: import('./orchestrator/market.js').MarketClient
  memory?: import('./orchestrator/memory.js').MemoryClient
  seam?: import('./orchestrator/seam.js').SeamClient
  /** File-analysis client for POST /v1/uplink/file (tests inject a stub).
   * Defaults to the intelligence service's /v1/analyze-file endpoint. */
  fileAnalysis?: import('./upload/analysis.js').FileAnalysisClient
  /** Throw on invalid frames instead of log+drop. Defaults to true in tests. */
  strictFrames?: boolean
  /** Allow anonymous {partnerKey} sessions. OPT-IN: defaults to
   * HIPPO_DEV === '1' so a prod deploy that forgets the env var is closed. */
  devMode?: boolean
  /** Per-IP rate limit for the partner-facing mint/turn surface. Defaults to
   * RATE_LIMIT_MAX / RATE_LIMIT_WINDOW (60 requests / 60s). Pass `false` to
   * disable (tests that fan out many mints). Never applied to /internal/* or
   * the SSE stream. */
  rateLimit?: RateLimitOptions | false
  /** Shared secret for /internal/sessions (admin panel). Fail-closed when
   * unset. Defaults to INTERNAL_API_TOKEN. */
  internalToken?: string
  /** Partner/plan/user registries. Postgres when DATABASE_URL is set,
   * in-memory (koinbx-dev seed) otherwise. */
  partnerStore?: PartnerStore
  planStore?: PlanStore
  userStore?: UserStore
  mauStore?: MauStore
  /** In-panel username+PIN identities (migration 015). Postgres when
   * DATABASE_URL is set, in-memory otherwise. */
  identityStore?: UserIdentityStore
  /** Durable upload records (migration 016) — the "Files" library. Postgres
   * when DATABASE_URL is set, in-memory otherwise. */
  uploadedFileStore?: UploadedFileStore
  /** Durable price alerts (migration 017). Postgres when DATABASE_URL is set,
   * in-memory otherwise. */
  alertStore?: AlertStore
  /** Implicit misunderstanding signals (migration 018). Postgres when
   * DATABASE_URL is set, in-memory otherwise. */
  intentSignalStore?: IntentSignalStore
  /** Alert poll cadence override (tests). Defaults to ALERT_POLL_MS ?? 15s. */
  alertPollMs?: number
  /** Share-card records (in-memory pilot store by default — see shares.ts). */
  shareStore?: ShareStore
  /** Share lifetime override (tests). Defaults to SHARE_TTL_MS ?? 7 days. */
  shareTtlMs?: number
  /** Override the session store (tests inject a Redis-backed one). Defaults to
   * Redis when REDIS_URL is set, else in-memory. */
  sessions?: SessionStore
}

export async function buildApp(opts: GatewayOptions = {}) {
  const isTest = process.env.NODE_ENV === 'test'
  // Dev mode is OPT-IN (anonymous sessions) so a prod deploy that forgets the
  // env var is safe by default. Previously it defaulted ON (HIPPO_DEV !== '0').
  const devMode = opts.devMode ?? process.env.HIPPO_DEV === '1'

  const app = Fastify({
    logger: { level: isTest ? 'silent' : (process.env.LOG_LEVEL ?? 'info') },
  })
  if (devMode && !isTest) {
    app.log.warn(
      'HIPPO_DEV mode ON — anonymous {partnerKey} sessions are allowed. Never enable this in production.',
    )
  }
  await app.register(cors, { origin: true })

  // Coarse per-IP abuse guard for the partner-facing surface (mint fans out to
  // LLM/market/seam → DoS + cost amplification). Env-tunable, injectable/off.
  const rateLimit =
    opts.rateLimit === false
      ? undefined
      : createRateLimiter(
          opts.rateLimit ?? {
            max: Number(process.env.RATE_LIMIT_MAX ?? 60),
            windowMs: Number(process.env.RATE_LIMIT_WINDOW ?? 60_000),
          },
        )
  const rateLimited = rateLimit ? { preHandler: rateLimit } : {}

  const usePg = Boolean(process.env.DATABASE_URL) && !isTest
  const partners =
    opts.partnerStore ?? (usePg ? new PostgresPartnerStore(getPool()) : new InMemoryPartnerStore())
  const plans =
    opts.planStore ?? (usePg ? new PostgresPlanStore(getPool()) : new InMemoryPlanStore())
  const users =
    opts.userStore ?? (usePg ? new PostgresUserStore(getPool()) : new InMemoryUserStore())
  const mau = opts.mauStore ?? (usePg ? new PostgresMauStore(getPool()) : new InMemoryMauStore())
  const identities =
    opts.identityStore ??
    (usePg ? new PostgresUserIdentityStore(getPool()) : new InMemoryUserIdentityStore())
  const uploadedFiles =
    opts.uploadedFileStore ??
    (usePg ? new PostgresUploadedFileStore(getPool()) : new InMemoryUploadedFileStore())
  const alertStore =
    opts.alertStore ?? (usePg ? new PostgresAlertStore(getPool()) : new InMemoryAlertStore())
  const intentSignalStore =
    opts.intentSignalStore ??
    (usePg ? new PostgresIntentSignalStore(getPool()) : new InMemoryIntentSignalStore())

  const sessions =
    opts.sessions ??
    createSessionStore({
      ...(process.env.REDIS_URL ? { redisUrl: process.env.REDIS_URL } : {}),
      log: app.log,
      // Durable resume resolves partners from the registry, not a hardcoded list.
      partnerLookup: (partnerId) => partners.get(partnerId),
    })
  const telemetry = new Telemetry()
  // Operator diagnostics (the admin "Tech" page): rolling latency windows,
  // call log, live-load gauges. In-memory only — resets with the process.
  const diagnostics = new Diagnostics()
  telemetry.onFirstToken = (ms) => diagnostics.recordFirstToken(ms)
  telemetry.onTurnLatency = (ms) => diagnostics.recordTurn(ms)
  // Restart-proof quota state: seed the in-process MAU set from the durable
  // store, so a pod restart never resets enforcement or the panel's alerts.
  try {
    telemetry.hydratePartnerMau(await mau.entries(monthKey()), monthKey())
  } catch (err) {
    app.log.warn({ err }, 'MAU hydration failed — quota counters start cold')
  }
  const emit = createEmitter({ strict: opts.strictFrames ?? isTest, log: app.log })
  // The market client is shared by the orchestrator (briefs, ticks) and the
  // alerts poll loop — deliberately NOT instrumented (see below).
  const market = opts.market ?? createMarketClient()
  // Price alerts engine: durable store + shared market client + the session
  // store for live-session delivery. Started below; stopped with the app so
  // tests never leak a poll interval.
  const alerts = createAlertsEngine({
    store: alertStore,
    market,
    sessions,
    emit,
    log: app.log,
    ...(opts.alertPollMs !== undefined ? { pollMs: opts.alertPollMs } : {}),
  })
  const memory = instrumentClient(opts.memory ?? createMemoryClient(), diagnostics, {
    update: 'memory-write',
    clear: 'memory-write',
    saveComposed: 'memory-write',
    upsertLearnedFacts: 'memory-write',
    clearLearnedFacts: 'memory-write',
  })
  // Implicit misunderstanding signals: rapid rephrases, abandoned tickets /
  // dismissed drafts, thumbs-down joined to the intent we classified. Reads
  // the persona ONLY for the learn opt-out (migration 012) — an opted-out
  // trader's text is never stored, though the signal still counts.
  const signals = createAccuracySignals({
    store: intentSignalStore,
    memory,
    log: app.log,
  })
  // Operator-forced degraded mode (SLA demo — PRD gate 5). PartnerIds whose
  // turns are forced down the degraded path via /internal/degraded below.
  // Deliberately in-process and unpersisted: a gateway restart clears every
  // forced flag, so the failure mode of a forgotten demo switch is "back to
  // live", never "stuck degraded".
  const forcedDegradedPartners = new Set<string>()
  // Instrumented pass-through wrappers feed the diagnostics call log. The
  // market client is deliberately NOT wrapped: the shared price-tick poller
  // calls snapshot() every few seconds and would drown the 100-entry log.
  const orchestrator = createOrchestrator({
    intel: instrumentClient(opts.intel ?? createIntelligenceClient(), diagnostics, {
      intent: 'interpret',
      respond: 'research',
      respondStream: 'research',
    }),
    market,
    memory,
    seam: instrumentClient(opts.seam ?? createSeamClient(), diagnostics, {
      prepare: 'order',
      prepareOrder: 'order',
      confirm: 'order',
      cancel: 'order',
      listOrders: 'order',
    }),
    identity: identities,
    alerts,
    emit,
    telemetry,
    log: app.log,
    // Durable ticket→session routing rides the session store: a no-op on the
    // in-memory store, restart-proof on Redis (see orchestrator/index.ts).
    sessions,
    signals,
    forcedDegraded: (partnerId) => forcedDegradedPartners.has(partnerId),
  })

  // Alert poll loop: unref'd interval, torn down with the app so a test
  // gateway never leaks a timer past close().
  alerts.start()
  app.addHook('onClose', async () => alerts.stop())

  // Shared guard for internal routes: INTERNAL_API_TOKEN, timing-safe and
  // fail-closed. 503 when the token is unset (surface disabled), 401 on a
  // missing/bad token. Guards both /internal/sessions and the seam callback
  // /internal/venue-events (which injects lifecycle frames into a user thread).
  const internalToken = opts.internalToken ?? process.env.INTERNAL_API_TOKEN ?? ''
  function internalGuard(
    req: { headers: Record<string, unknown> },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): boolean {
    if (!internalToken) {
      reply.code(503).send({ error: 'internal surface disabled: INTERNAL_API_TOKEN not set' })
      return false
    }
    const presented = req.headers['x-hippo-internal-token']
    const actual = Buffer.from(typeof presented === 'string' ? presented : '')
    const expected = Buffer.from(internalToken)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      reply.code(401).send({ error: 'invalid internal token' })
      return false
    }
    return true
  }

  app.post('/v1/session', rateLimited, async (req, reply) => {
    const body = (req.body ?? {}) as { partnerKey?: string; symbol?: unknown }
    const auth = await authenticate(partners, req.headers.authorization, body.partnerKey, devMode)
    if (!auth.ok) {
      reply.code(401)
      return { error: auth.error }
    }

    // Blocked end-users never get a session (admin panel primitive).
    // Store reads on the mint path degrade OPEN: sessions live in memory/
    // Redis, so a Postgres outage must not stop every new user from booting
    // the SDK. The block/quota checks are skipped (logged) until it recovers.
    if (auth.venueUserId) {
      try {
        const user = await users.get(auth.partner.partnerId, auth.venueUserId)
        if (user?.status === 'blocked') {
          reply.code(401)
          return { error: 'user blocked' }
        }
      } catch (err) {
        app.log.warn({ err }, 'user store read failed — skipping blocked-user check')
      }
    }

    // Plan MAU quota: a NEW distinct user this month past the ceiling → 429.
    // Returning users (already counted) keep working — the quota bounds
    // billable distinct users, it never cuts off someone mid-month.
    let plan: Awaited<ReturnType<typeof plans.get>>
    try {
      plan = auth.partner.planId ? await plans.get(auth.partner.planId) : undefined
    } catch (err) {
      app.log.warn({ err }, 'plan store read failed — skipping MAU quota check')
    }
    if (plan?.mauQuota != null) {
      const alreadyCounted = auth.venueUserId
        ? telemetry.hasPartnerUser(auth.partner.partnerId, auth.venueUserId)
        : false
      if (!alreadyCounted && telemetry.partnerMau(auth.partner.partnerId) >= plan.mauQuota) {
        reply.code(429)
        return { error: 'plan MAU quota reached' }
      }
    }

    // Carry the plan's entitlements onto the session's partner so the
    // orchestrator can feature-gate server-side (memoryLab etc.). Stored with
    // the session in both backings, so it survives to later /v1/turns.
    const partnerWithEntitlements = plan?.entitlements
      ? { ...auth.partner, entitlements: plan.entitlements }
      : auth.partner
    const session = sessions.create(partnerWithEntitlements, auth.venueUserId)
    // Host page's market ("BTC/USDT") — the session's default symbol for
    // research, order drafts and price ticks. Invalid values are ignored
    // silently (context is a hint, never a command).
    const pageSymbol = normalizeSymbol(body.symbol)
    if (pageSymbol) session.symbol = pageSymbol
    const userKey = auth.venueUserId ?? session.id
    telemetry.recordPartnerUser(auth.partner.partnerId, userKey)
    // Durable mirror (fire-and-forget) — feeds boot hydration + admin counts.
    void mau
      .record(auth.partner.partnerId, userKey)
      .catch((err) => app.log.warn({ err }, 'mau record failed'))

    // Lazily register authenticated end-users (never anonymous sessions);
    // fire-and-forget — registry writes must not slow session mint.
    if (auth.venueUserId) {
      void users
        .upsertSeen(auth.partner.partnerId, auth.venueUserId)
        .catch((err) => app.log.warn({ err }, 'users upsert failed'))
    }

    return {
      sessionId: session.id,
      config: {
        venueName: auth.partner.venueName,
        locales: auth.partner.locales,
        suggestedQueries: auth.partner.suggestedQueries,
        // Plan entitlements pass through for SDK feature gating (additive).
        ...(plan ? { entitlements: plan.entitlements } : {}),
      },
    }
  })

  app.get('/v1/stream', async (req, reply) => {
    const { session: sessionId } = req.query as { session?: string }
    // Live object first; on a Redis-backed store, fall back to a durable cold
    // resume (rebuild + replay the frame journal) so a reconnect survives a
    // pod restart. In-memory stores have no `resume` — a miss stays a miss.
    let session = sessionId ? sessions.get(sessionId) : null
    if (!session && sessionId && sessions.resume) {
      // Redis being down must read as a plain miss (404 — the SDK's retry
      // path re-mints), never a 500 the reconnect logic can't handle.
      try {
        session = await sessions.resume(sessionId)
      } catch (err) {
        req.log.warn({ err, sessionId }, 'session resume failed — treating as unknown session')
      }
    }
    if (!session) {
      reply.code(404)
      return { error: 'unknown session' }
    }
    // Open-connection gauge for the diagnostics surface; the close event
    // fires on every disconnect path (client drop, revoke, shutdown).
    diagnostics.sseOpened()
    req.raw.on('close', () => diagnostics.sseClosed())
    // Opening frames land in the journal first, so the replay-then-live path
    // below is the only delivery mechanism — one ordering for everything.
    orchestrator.onStreamConnect(session)
    return streamSession(session, req, reply)
  })

  app.post('/v1/turns', rateLimited, async (req, reply) => {
    const parsed = Uplink.safeParse(req.body)
    if (!parsed.success) {
      reply.code(400)
      return { error: 'invalid uplink', issues: parsed.error.issues }
    }
    const session = sessions.get(parsed.data.sessionId)
    if (!session) {
      reply.code(404)
      return { error: 'unknown session' }
    }
    diagnostics.recordUplink()
    orchestrator.handleUplink(session, parsed.data)
    return { ok: true }
  })

  // File upload → analysis pipeline (CSV digest / image vision → research
  // brief over the session SSE). Same session possession auth as /v1/turns,
  // same per-IP limiter (uploads fan out to the LLM). Additive module — see
  // upload/route.ts for the pinned SDK contract.
  registerFileUploadRoute(app, {
    sessions,
    emit,
    analysis: opts.fileAnalysis ?? createFileAnalysisClient(),
    files: uploadedFiles,
    log: app.log,
    ...(rateLimit ? { rateLimit } : {}),
  })

  // Share cards (baseline §6): POST /v1/shares mints a short id for a brief
  // the session already received; GET /s/:id is the public, co-branded card
  // page that re-grounds on the live market at open time. Tenancy is
  // structural — records carry market-level content only (see shares.ts).
  const shares = opts.shareStore ?? new InMemoryShareStore()
  registerShareRoutes(app, {
    sessions,
    market,
    store: shares,
    log: app.log,
    ...(rateLimit ? { rateLimit } : {}),
    ...(opts.shareTtlMs !== undefined ? { ttlMs: opts.shareTtlMs } : {}),
  })

  /** Venue lifecycle events delivered by the seam (the callbackUrl given at
   * confirm time). Internal route: in pods this sits on the cluster network
   * behind mTLS, never exposed through the partner-facing ingress. Additionally
   * guarded by INTERNAL_API_TOKEN (fail-closed) so a network-adjacent attacker
   * cannot forge "FILLED"/lifecycle frames into a user's thread. The seam sends
   * this token when posting callbacks. */
  app.post('/internal/venue-events', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const event = req.body as import('./orchestrator/seam.js').VenueEvent
    if (typeof event?.ticketId !== 'string' || typeof event?.phase !== 'string') {
      reply.code(400)
      return { error: 'invalid venue event' }
    }
    // Async: a routing miss may consult the durable ticket mapping and
    // cold-resume the owning session (Redis-backed stores) before routing.
    const routed = await orchestrator.onVenueEvent(event)
    return { ok: true, routed }
  })

  app.get('/health', async () => ({
    ok: true,
    service: 'gateway',
    sha: GIT_SHA,
    builtAt: BUILT_AT,
  }))

  // In-memory counters for dev; OTel + telemetry_events replace this in pods.
  // Guarded like every /internal surface — MAU-by-partner and load numbers
  // are operator data, not public data (was unauthenticated until the pilot
  // dashboard work; the admin service presents the internal token now).
  app.get('/internal/metrics', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    return telemetry.snapshot()
  })

  // ── operator diagnostics (admin "Tech" page) ─────────────────────────────
  // Latency percentiles (recomputed on read), downstream call log, live load,
  // degraded clock, and the upstream config as this process sees it. Guarded
  // like every other internal surface. In-memory — resets on restart.
  app.get('/internal/telemetry', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const { degraded } = telemetry.snapshot() as {
      degraded: { active: boolean; seconds: number }
    }
    return {
      ...diagnostics.snapshot(sessions.list().length),
      degraded,
      config: {
        // Mirrors the boot log: what this process was configured with, not a
        // live probe (the admin service probes intelligence /health itself).
        sessionsBackend: process.env.REDIS_URL ? 'redis' : 'memory',
        devMode,
        intelligenceUrl: process.env.INTELLIGENCE_URL ?? 'http://localhost:8791',
      },
    }
  })

  // ── implicit misunderstanding signals (admin "Understanding" + evals) ────
  // Operator data (it can carry trader text), so it sits behind internalGuard
  // like every other /internal surface. `partnerId` narrows to one partner;
  // omitted, the route fans out over the ENTIRE partner registry in bounded
  // batches — no silent cap: `partnersScanned` in the response states exactly
  // how many partners the read covered, so truncation is impossible to miss.
  type SignalsQuery = { partnerId?: string; limit?: string; since?: string; signal?: string }

  /** Registry fan-out batch size: bounds concurrent store reads (each partner
   * costs two queries — rows + summary) without one giant Promise.all. */
  const SIGNALS_SCAN_BATCH = 10

  async function readSignals(q: SignalsQuery) {
    const limit = Math.min(
      Number(q.limit ?? INTENT_SIGNALS_LIST_CAP) || INTENT_SIGNALS_LIST_CAP,
      500,
    )
    const since = Number(q.since)
    const signal = q.signal as IntentSignalKind | undefined
    const partnerIds = q.partnerId ? [q.partnerId] : (await partners.list()).map((p) => p.partnerId)
    // The store has no cross-partner read, so this is per-partner by
    // construction — but batched: at most SIGNALS_SCAN_BATCH partners in
    // flight, and each per-partner list is already bounded by `limit` (so a
    // limit=1 summary poll reads one row per partner, never a full page).
    const perPartner: Array<{
      rows: Awaited<ReturnType<typeof intentSignalStore.list>>
      summary: Awaited<ReturnType<typeof intentSignalStore.summary>>
    }> = []
    for (let i = 0; i < partnerIds.length; i += SIGNALS_SCAN_BATCH) {
      const batch = partnerIds.slice(i, i + SIGNALS_SCAN_BATCH)
      perPartner.push(
        ...(await Promise.all(
          batch.map(async (partnerId) => ({
            rows: await intentSignalStore.list({
              partnerId,
              limit,
              ...(Number.isFinite(since) && since > 0 ? { since } : {}),
              ...(signal ? { signal } : {}),
            }),
            summary: await intentSignalStore.summary(partnerId),
          })),
        )),
      )
    }
    const rows = perPartner
      .flatMap((p) => p.rows)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
    return {
      signals: rows,
      summary: mergeSummaries(perPartner.map((p) => p.summary)),
      // Additive: how many partners this read actually covered.
      partnersScanned: partnerIds.length,
    }
  }

  app.get<{ Querystring: SignalsQuery }>('/internal/intent-signals', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    return readSignals(req.query)
  })

  // The point of the whole feature: production confusion as eval rows. JSONL
  // in the harness's shape, `expected_intent: null` because this is OBSERVED
  // evidence — a human labels it before it becomes a test case. Rows whose
  // text was withheld (opted-out traders) are absent by construction.
  app.get<{ Querystring: SignalsQuery }>('/internal/intent-signals/export', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const { signals } = await readSignals(req.query)
    return reply
      .type('application/x-ndjson')
      .header('content-disposition', 'attachment; filename="intent-signals.jsonl"')
      .send(toJsonl(toEvalRows(signals)))
  })

  // ── operator-forced degraded mode (SLA demo — PRD gate 5) ───────────────
  // The procurement-meeting switch: force one partner's turns down the SAME
  // degraded path a real intelligence outage takes (amber HIGH MARKET LOAD
  // banner, deterministic classifier, market-data-only research — orders,
  // prices and portfolio stay fully live) WITHOUT touching the intelligence
  // service. Flip off → the next turn is live again; no restart anywhere.
  // Guarded like every /internal surface: a partner key or session token can
  // never reach it — only operators (admin service, host-demo settings proxy)
  // presenting INTERNAL_API_TOKEN.
  app.get('/internal/degraded', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    return { forced: [...forcedDegradedPartners] }
  })

  app.post('/internal/degraded', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const body = (req.body ?? {}) as { partnerId?: unknown; forced?: unknown }
    if (typeof body.partnerId !== 'string' || body.partnerId.length === 0) {
      reply.code(400)
      return { error: 'partnerId required' }
    }
    if (typeof body.forced !== 'boolean') {
      reply.code(400)
      return { error: 'forced must be a boolean' }
    }
    if (body.forced) forcedDegradedPartners.add(body.partnerId)
    else forcedDegradedPartners.delete(body.partnerId)
    app.log.info({ partnerId: body.partnerId, forced: body.forced }, 'forced-degraded flag set')
    return { partnerId: body.partnerId, forced: body.forced }
  })

  // ── live-session inventory + kill switch (admin panel) ──────────────────
  // Guarded by internalGuard (INTERNAL_API_TOKEN, timing-safe, fail-closed) —
  // revoking sessions and injecting venue events are mutating powers.
  app.get<{ Querystring: { partnerId?: string } }>('/internal/sessions', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const all = sessions.list()
    const { partnerId } = req.query
    return partnerId ? all.filter((s) => s.partnerId === partnerId) : all
  })

  app.delete<{ Params: { id: string } }>('/internal/sessions/:id', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    return { revoked: sessions.revoke(req.params.id) }
  })

  // ── operator visibility: alerts / shares / identities ────────────────────
  // The operator previously had ZERO read surface over these stores. All three
  // reads require an explicit partnerId (they are per-tenant views, never a
  // cross-tenant dump) and sit behind internalGuard like every /internal route.

  /** GET /internal/alerts?partnerId= — a partner's alerts across all its
   * users, newest first, bounded by the store (ALERTS_LIST_CAP default). */
  app.get<{ Querystring: { partnerId?: string } }>('/internal/alerts', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const { partnerId } = req.query
    if (!partnerId) {
      reply.code(400)
      return { error: 'partnerId required' }
    }
    return { alerts: await alertStore.listByPartner(partnerId) }
  })

  /** POST /internal/alerts/:id/cancel {partnerId, userKey} — operator cancel.
   * The store's cancel is ownership-scoped (id + partnerId + userKey), so the
   * caller passes the owner fields it read from GET /internal/alerts. Unknown/
   * foreign/already-terminal ids return {cancelled:false} — idempotent, never
   * an error (same law as the conversational cancel). */
  app.post<{ Params: { id: string } }>('/internal/alerts/:id/cancel', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const body = (req.body ?? {}) as { partnerId?: unknown; userKey?: unknown }
    if (
      typeof body.partnerId !== 'string' ||
      body.partnerId.length === 0 ||
      typeof body.userKey !== 'string' ||
      body.userKey.length === 0
    ) {
      reply.code(400)
      return { error: 'partnerId and userKey required' }
    }
    const cancelled = await alertStore.cancel(req.params.id, body.partnerId, body.userKey)
    return { cancelled: cancelled !== null, ...(cancelled ? { alert: cancelled } : {}) }
  })

  /** GET /internal/shares?partnerId= — a partner's LIVE share links (expired
   * rows never appear). DELETE /internal/shares/:id is the kill switch for a
   * leaked link: the id 404s on the public /s/:id page from the next open. */
  app.get<{ Querystring: { partnerId?: string } }>('/internal/shares', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const { partnerId } = req.query
    if (!partnerId) {
      reply.code(400)
      return { error: 'partnerId required' }
    }
    return { shares: shares.list(partnerId) }
  })

  app.delete<{ Params: { id: string } }>('/internal/shares/:id', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    return { deleted: shares.delete(req.params.id) }
  })

  /** GET /internal/identities?partnerId= — a partner's in-panel identities,
   * most recently seen first, bounded by the store (IDENTITIES_LIST_CAP
   * default). pinHash never leaves the store surface — stripped here. */
  app.get<{ Querystring: { partnerId?: string } }>('/internal/identities', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const { partnerId } = req.query
    if (!partnerId) {
      reply.code(400)
      return { error: 'partnerId required' }
    }
    const rows = await identities.listByPartner(partnerId)
    return { identities: rows.map(({ pinHash: _pinHash, ...rest }) => rest) }
  })

  // ── operator user purge (right-to-erasure, gateway-side stores) ──────────
  // POST /internal/user-purge {partnerId, userKey}: hard-delete one user's
  // gateway-side data — intent signals (raw trader text), upload records,
  // alerts (every state) and the in-panel identity + its links. Per-store
  // results are reported honestly: a rows-removed count, 'unsupported' when
  // an injected store lacks the delete method, 'failed' when the delete threw
  // (the other stores still purge — one bad store never blocks the rest).
  // Memory-service data (persona, notes, learned facts) is purged via the
  // memory service's own DELETE routes, not from here. Durable mau_events
  // rows are DELIBERATELY retained — they are the billing record (a count,
  // not content) — and the report says so rather than staying silent.
  app.post('/internal/user-purge', async (req, reply) => {
    if (!internalGuard(req, reply)) return reply
    const body = (req.body ?? {}) as { partnerId?: unknown; userKey?: unknown }
    if (
      typeof body.partnerId !== 'string' ||
      body.partnerId.length === 0 ||
      typeof body.userKey !== 'string' ||
      body.userKey.length === 0
    ) {
      reply.code(400)
      return { error: 'partnerId and userKey required' }
    }
    const { partnerId, userKey: targetKey } = body
    // Identity rows are keyed by usernameLower, not the effective user key.
    // An identity-bound key is `id:<username_lower>` (orchestrator userKey()),
    // so strip the prefix; a bare key still purges a same-named identity.
    const usernameLower = (
      targetKey.startsWith('id:') ? targetKey.slice(3) : targetKey
    ).toLowerCase()
    const deleted: Record<string, number | 'unsupported' | 'failed'> = {}
    async function purgeStep(name: string, method: unknown, call: () => Promise<number>) {
      if (typeof method !== 'function') {
        deleted[name] = 'unsupported'
        return
      }
      try {
        deleted[name] = await call()
      } catch (err) {
        app.log.error({ err, store: name, partnerId }, 'user-purge: store delete failed')
        deleted[name] = 'failed'
      }
    }
    await purgeStep('intentSignals', intentSignalStore.deleteByUser, () =>
      intentSignalStore.deleteByUser(partnerId, targetKey),
    )
    await purgeStep('uploadedFiles', uploadedFiles.deleteByUser, () =>
      uploadedFiles.deleteByUser(partnerId, targetKey),
    )
    await purgeStep('alerts', alertStore.deleteByUser, () =>
      alertStore.deleteByUser(partnerId, targetKey),
    )
    await purgeStep('identities', identities.deleteByUser, () =>
      identities.deleteByUser(partnerId, usernameLower),
    )
    // Billing counts survive erasure by design; name it so the report is
    // complete rather than silently omitting a store that holds the key.
    const report: Record<string, number | 'unsupported' | 'failed' | 'retained'> = {
      ...deleted,
      mauEvents: 'retained',
    }
    return { partnerId, userKey: targetKey, deleted: report }
  })

  return {
    app,
    sessions,
    emit,
    telemetry,
    diagnostics,
    partners,
    plans,
    users,
    identities,
    uploadedFiles,
    alertStore,
    alerts,
    intentSignalStore,
    signals,
    shares,
  }
}

if (process.env.NODE_ENV !== 'test') {
  const { app } = await buildApp()
  await app.listen({ port: PORT, host: '::' })
  // Boot line carries the mode/backing facts an operator needs first: auth
  // mode, session durability and registry backing (every other service
  // prints its equivalent).
  app.log.info(
    {
      port: PORT,
      devMode: process.env.HIPPO_DEV === '1',
      sessions: process.env.REDIS_URL ? 'redis' : 'in-memory',
      stores: process.env.DATABASE_URL ? 'postgres' : 'in-memory',
    },
    'gateway up — sessions, SSE journal, orchestrator live',
  )
}
