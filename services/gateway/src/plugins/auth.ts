/**
 * Sessions & partner auth.
 *
 * Two modes (BE doc §1 "Session lifecycle"):
 *  (a) Dev mode (default, HIPPO_DEV unset or =1): POST /v1/session {partnerKey}
 *      mints an anonymous session exactly like the mock gateway, so the SDK
 *      works unchanged against either.
 *  (b) JWT mode: the partner backend mints a short-lived HS256 JWT asserting
 *      the venue user (`sub` = venue_user_id, plus iat/exp). We verify it
 *      against the per-partner shared secret and bind the session to that
 *      user. Production hardens this to JWKS/RS256 per partner — the seam is
 *      `verifyJwtHS256` below; nothing else changes.
 *
 * Session store is an in-memory Map with TTL refresh. In regional pods this
 * is replaced by Redis (TTL-refreshed keys) behind the same SessionStore
 * surface — see Build Plan/10 BE Architecture §4.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { devPartner, type PartnerRecord, type PartnerStore } from '@hippo/stores'
import { createRedisClient, type RedisClient } from './redis.js'
import { InMemoryJournal, type Journal, type JournalEntry, RedisJournal } from './sse.js'

export type PartnerConfig = {
  partnerId: string
  /** Public embed key the loader ships with (`data-hippo-key`). */
  partnerKey: string
  /** HS256 shared secret for partner-signed JWTs. Dev-only value below. */
  jwtSecret: string
  venueName: string
  locales: string[]
  suggestedQueries: string[]
}

/**
 * Partner registry moved to @hippo/stores (PartnerStore: the `partners`
 * table when DATABASE_URL is set, in-memory otherwise — BE doc §4). This
 * legacy export remains for tests and the partner simulator: it is exactly
 * the seed the in-memory store ships with.
 */
export const PARTNERS: readonly PartnerConfig[] = [devPartner()]

/** Quote captured when a ticket was prepared; the simulated fill reads its
 * actuals from here. Phase 3: the seam's venue events replace this. */
export type TicketQuote = {
  side: 'buy' | 'sell'
  instrument: string
  sizeDisplay: string
  sizeNum: number
  price: number
  feeRate: number
  fillTimer?: ReturnType<typeof setTimeout>
}

export type Session = {
  id: string
  partner: PartnerConfig
  /** venue_user_id from the partner JWT; null for anonymous dev sessions. */
  venueUserId: string | null
  seq: number
  journal: Journal
  live: ((entry: JournalEntry) => void) | null
  expiresAt: number
  /** Preferred language from settings uplinks; passed to the intent service. */
  language?: string
  /** Degraded banner is emitted once per session per degradation episode. */
  degradedBannerShown: boolean
  /** Prepared tickets awaiting confirm/cancel. */
  tickets: Map<string, TicketQuote>
  /** Force-close the live SSE socket (set by streamSession) — admin revoke. */
  closeStream?: (() => void) | null
}

/** What the admin panel sees per live session — no journal, no tickets. */
export type SessionSummary = {
  id: string
  partnerId: string
  venueUserId: string | null
  expiresAt: number
  /** An SSE client is currently attached. */
  connected: boolean
}

const SESSION_TTL_MS = 30 * 60_000
const SWEEP_INTERVAL_MS = 60_000

function newSessionId(): string {
  return `s_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

function clearTicketTimers(session: Session): void {
  for (const ticket of session.tickets.values()) {
    if (ticket.fillTimer) clearTimeout(ticket.fillTimer)
  }
}

/**
 * Session store surface. In-memory by default; a Redis-backed implementation
 * (selected by REDIS_URL) sits behind the SAME interface — see BE doc §4.
 * `resume` is the optional cold-reconnect path: reconstruct a session (and
 * replay its durable frame journal) on a pod that never saw its `create`.
 */
export interface SessionStore {
  create(partner: PartnerConfig, venueUserId: string | null): Session
  /** The live session, TTL refreshed; null if unknown/expired on this pod. */
  get(id: string): Session | null
  /** Live-session inventory for the admin panel (this pod's sessions). */
  list(): SessionSummary[]
  /** Admin kill switch: force-close the SSE socket (if any) and evict. */
  revoke(id: string): boolean
  /** Durable cold-start resume (Redis only); undefined for in-memory. */
  resume?(id: string): Promise<Session | null>
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>()

  constructor() {
    // Lazy expiry happens in get(); the sweep just reclaims memory.
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS).unref()
  }

  create(partner: PartnerConfig, venueUserId: string | null): Session {
    const session: Session = {
      id: newSessionId(),
      partner,
      venueUserId,
      seq: 0,
      journal: new InMemoryJournal(),
      live: null,
      expiresAt: Date.now() + SESSION_TTL_MS,
      degradedBannerShown: false,
      tickets: new Map(),
    }
    this.sessions.set(session.id, session)
    return session
  }

  /** Returns the session and refreshes its TTL; null if unknown or expired. */
  get(id: string): Session | null {
    const session = this.sessions.get(id)
    if (!session) return null
    if (session.expiresAt < Date.now()) {
      this.evict(session)
      return null
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS
    return session
  }

  /** Live-session inventory for the admin panel (expired entries skipped). */
  list(): SessionSummary[] {
    const now = Date.now()
    const out: SessionSummary[] = []
    for (const s of this.sessions.values()) {
      if (s.expiresAt < now) continue
      out.push({
        id: s.id,
        partnerId: s.partner.partnerId,
        venueUserId: s.venueUserId,
        expiresAt: s.expiresAt,
        connected: s.live !== null,
      })
    }
    return out.sort((a, b) => b.expiresAt - a.expiresAt)
  }

  /** Admin kill switch: close the SSE socket (if any) and evict. The next
   * /v1/turns or reconnect 404s — the client must mint a fresh session. */
  revoke(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.closeStream?.()
    this.evict(session)
    return true
  }

  private evict(session: Session): void {
    clearTicketTimers(session)
    this.sessions.delete(session.id)
  }

  private sweep(): void {
    const now = Date.now()
    for (const session of this.sessions.values()) {
      if (session.expiresAt < now) this.evict(session)
    }
  }
}

type StoreLog = { error: (obj: object, msg: string) => void }

/** Serialized session metadata mirrored to Redis (`session:{id}:meta`). */
type SessionMeta = {
  partnerId: string
  venueUserId: string | null
  seq: number
  language: string | null
  degradedBannerShown: boolean
}

/**
 * Redis-backed session store (BE doc §4). Live session OBJECTS stay pod-local
 * (they carry the live SSE writer + in-process fill timers, so SSE is sticky-
 * routed) while their metadata and frame journal are mirrored to Redis with a
 * TTL-refreshed key. That durability powers `resume`: a cold pod rebuilds the
 * session from `session:{id}:meta` and replays `session:{id}:frames`, so
 * Last-Event-ID reconnects survive a restart. The synchronous `create`/`get`
 * surface is identical to the in-memory store.
 */
export class RedisSessionStore implements SessionStore {
  private local = new Map<string, Session>()
  private pending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly redis: RedisClient,
    private readonly log?: StoreLog,
    /** Resolves a partnerId on durable resume — the PartnerStore in app.ts
     * (the old hardcoded partnerById fell away with the partners table). */
    private readonly partnerLookup: (
      partnerId: string,
    ) => Promise<PartnerConfig | undefined> = async (id) =>
      PARTNERS.find((p) => p.partnerId === id),
  ) {
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS).unref()
  }

  private metaKey(id: string): string {
    return `session:${id}:meta`
  }

  private framesKey(id: string): string {
    return `session:${id}:frames`
  }

  create(partner: PartnerConfig, venueUserId: string | null): Session {
    const id = newSessionId()
    const session: Session = {
      id,
      partner,
      venueUserId,
      seq: 0,
      journal: new RedisJournal(this.redis, this.framesKey(id), this.log),
      live: null,
      expiresAt: Date.now() + SESSION_TTL_MS,
      degradedBannerShown: false,
      tickets: new Map(),
    }
    this.local.set(id, session)
    this.persist(session)
    return session
  }

  get(id: string): Session | null {
    const session = this.local.get(id)
    if (!session) return null
    if (session.expiresAt < Date.now()) {
      this.evict(session)
      return null
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS
    this.enqueue(() => this.redis.pexpire(this.metaKey(id), SESSION_TTL_MS))
    return session
  }

  async resume(id: string): Promise<Session | null> {
    const live = this.local.get(id)
    if (live && live.expiresAt >= Date.now()) return this.get(id)

    const raw = await this.redis.get(this.metaKey(id))
    if (!raw) return null
    let meta: SessionMeta
    try {
      meta = JSON.parse(raw) as SessionMeta
    } catch {
      return null
    }
    const partner = await this.partnerLookup(meta.partnerId)
    if (!partner) return null

    const journal = new RedisJournal(this.redis, this.framesKey(id), this.log)
    await journal.hydrate()
    const session: Session = {
      id,
      partner,
      venueUserId: meta.venueUserId ?? null,
      // The journal is the source of truth for the sequence high-water mark.
      seq: journal.lastSeq(),
      journal,
      live: null,
      expiresAt: Date.now() + SESSION_TTL_MS,
      ...(meta.language ? { language: meta.language } : {}),
      degradedBannerShown: Boolean(meta.degradedBannerShown),
      tickets: new Map(),
    }
    this.local.set(id, session)
    this.persist(session)
    return session
  }

  /** Live-session inventory (this pod's local sessions — SSE is sticky). */
  list(): SessionSummary[] {
    const now = Date.now()
    const out: SessionSummary[] = []
    for (const s of this.local.values()) {
      if (s.expiresAt < now) continue
      out.push({
        id: s.id,
        partnerId: s.partner.partnerId,
        venueUserId: s.venueUserId,
        expiresAt: s.expiresAt,
        connected: s.live !== null,
      })
    }
    return out.sort((a, b) => b.expiresAt - a.expiresAt)
  }

  /** Admin kill switch — also deletes the durable meta/journal keys so the
   * session cannot cold-resume on another pod. */
  revoke(id: string): boolean {
    const session = this.local.get(id)
    if (!session) return false
    session.closeStream?.()
    this.evict(session)
    return true
  }

  /** Await all pending metadata + journal writes (resume + tests need this). */
  async flush(): Promise<void> {
    await this.pending
    for (const session of this.local.values()) {
      if (session.journal instanceof RedisJournal) await session.journal.flush()
    }
  }

  private persist(session: Session): void {
    const meta: SessionMeta = {
      partnerId: session.partner.partnerId,
      venueUserId: session.venueUserId,
      seq: session.seq,
      language: session.language ?? null,
      degradedBannerShown: session.degradedBannerShown,
    }
    this.enqueue(() =>
      this.redis.set(this.metaKey(session.id), JSON.stringify(meta), 'PX', SESSION_TTL_MS),
    )
  }

  private enqueue(op: () => Promise<unknown>): void {
    this.pending = this.pending
      .then(op)
      .catch((err) => this.log?.error({ err }, 'redis session store write failed'))
  }

  private evict(session: Session): void {
    clearTicketTimers(session)
    this.local.delete(session.id)
    this.enqueue(() => this.redis.del(this.metaKey(session.id), this.framesKey(session.id)))
  }

  private sweep(): void {
    const now = Date.now()
    for (const session of this.local.values()) {
      if (session.expiresAt < now) this.evict(session)
    }
  }
}

/**
 * Pick the session store: Redis when configured (REDIS_URL or an injected
 * client — the latter is how tests use ioredis-mock), else in-memory. Local
 * dev and the test suite run with no Redis at all.
 */
export function createSessionStore(
  opts: {
    redis?: RedisClient
    redisUrl?: string
    log?: StoreLog
    partnerLookup?: (partnerId: string) => Promise<PartnerConfig | undefined>
  } = {},
): SessionStore {
  const redis = opts.redis ?? (opts.redisUrl ? createRedisClient(opts.redisUrl) : undefined)
  return redis
    ? new RedisSessionStore(redis, opts.log, opts.partnerLookup)
    : new InMemorySessionStore()
}

// ── JWT (HS256, compact serialization) ──────────────────────────────────────
// Implemented against node:crypto rather than a dependency: the surface we
// need (verify HS256 + exp) is ~30 lines and fully deterministic for tests.

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Mint an HS256 JWT — used by tests and the partner simulator, never by the
 * gateway itself (partners sign their own tokens). */
export function signJwtHS256(claims: Record<string, unknown>, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = b64url(Buffer.from(JSON.stringify(claims)))
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${sig}`
}

/** Verify signature + exp. Returns the claims, or null for any invalid token. */
export function verifyJwtHS256(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts as [string, string, string]
  const head = decodeJson(header)
  if (head?.alg !== 'HS256') return null
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest()
  const actual = Buffer.from(sig, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  const claims = decodeJson(payload)
  if (!claims) return null
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
  return claims
}

export type AuthResult =
  | { ok: true; partner: PartnerRecord; venueUserId: string | null }
  | { ok: false; error: string }

/**
 * Resolve a session-mint request against the partner registry. A Bearer
 * token, when present, is ALWAYS verified (even in dev mode — a bad token
 * must never silently downgrade to an anonymous session). Without a token,
 * dev mode mints an anonymous session from the partnerKey; JWT mode rejects.
 * Suspended partners are rejected in every mode.
 */
export async function authenticate(
  partners: PartnerStore,
  authHeader: string | undefined,
  partnerKey: string | undefined,
  devMode: boolean,
): Promise<AuthResult> {
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim()
    // Partner is identified by the `iss` claim, falling back to the embed key.
    const unverified = decodeJson(token.split('.')[1] ?? '')
    const issuer = typeof unverified?.iss === 'string' ? unverified.iss : null
    const partner =
      (issuer ? await partners.get(issuer) : undefined) ??
      (partnerKey ? await partners.getByKey(partnerKey) : undefined)
    if (!partner) return { ok: false, error: 'unknown partner' }
    if (partner.status === 'suspended') return { ok: false, error: 'partner suspended' }
    const claims = verifyJwtHS256(token, partner.jwtSecret)
    if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) {
      return { ok: false, error: 'invalid partner token' }
    }
    return { ok: true, partner, venueUserId: claims.sub }
  }

  if (devMode) {
    const partner =
      (partnerKey ? await partners.getByKey(partnerKey) : undefined) ??
      (await partners.get('koinbx-dev'))
    if (!partner) return { ok: false, error: 'no partner configured' }
    if (partner.status === 'suspended') return { ok: false, error: 'partner suspended' }
    return { ok: true, partner, venueUserId: null }
  }

  return { ok: false, error: 'partner token required' }
}
