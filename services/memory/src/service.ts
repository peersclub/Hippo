/**
 * Memory service HTTP surface (regional pod — PII stays in-region, L1):
 *   GET  /v1/persona/:partnerId/:userId        → persona (default if unseen)
 *   PUT  /v1/persona/:partnerId/:userId        → merge a PersonaUpdate
 *   POST /v1/persona/:partnerId/:userId/clear  → wipe data (settings promise)
 *   GET  /admin/personas                       → enumerate (admin panel; token)
 *   DELETE /admin/personas/:partnerId/:userId  → hard delete/purge (token)
 *   GET  /health                                → unguarded liveness
 *
 * Every route except /health is guarded by `x-hippo-internal-token` against
 * INTERNAL_API_TOKEN (timing-safe). The /v1/persona routes carry opt-in PII
 * (experience level, followed assets, open threads), so they share the same
 * trust boundary as /admin/*: no network peer may read or wipe a user's
 * memory by guessing IDs. Fail-closed: no env token → the guarded surface is
 * 503, never open. In pods this sits on the cluster network behind mTLS, same
 * as the gateway's /internal routes.
 */
import { timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { InMemoryScopeMemoryStore, MAX_BODY, type ScopeMemoryStore } from './scope-store.js'
import {
  type ExperienceLevel,
  InMemoryPersonaStore,
  type PersonaStore,
  type PersonaUpdate,
} from './store.js'

const LEVELS: ReadonlySet<string> = new Set(['new', 'intermediate', 'pro'])

/** Hand-validated (this service deliberately has zero schema deps). */
function parseUpdate(body: unknown): PersonaUpdate | null {
  if (typeof body !== 'object' || body === null) return null
  const raw = body as Record<string, unknown>
  const patch: PersonaUpdate = {}
  if (raw.optIn !== undefined) {
    if (typeof raw.optIn !== 'boolean') return null
    patch.optIn = raw.optIn
  }
  if (raw.experienceLevel !== undefined) {
    if (raw.experienceLevel !== null && !LEVELS.has(String(raw.experienceLevel))) return null
    patch.experienceLevel = raw.experienceLevel as ExperienceLevel | null
  }
  if (raw.followAsset !== undefined) {
    if (typeof raw.followAsset !== 'string' || !/^[A-Za-z]{2,10}$/.test(raw.followAsset))
      return null
    patch.followAsset = raw.followAsset
  }
  if (raw.openThread !== undefined) {
    const t = raw.openThread as Record<string, unknown>
    if (typeof t !== 'object' || t === null || typeof t.text !== 'string' || !t.text.trim())
      return null
    patch.openThread = {
      text: t.text.slice(0, 300),
      ...(typeof t.symbol === 'string' ? { symbol: t.symbol.toUpperCase() } : {}),
    }
  }
  return patch
}

export type ServiceOptions = {
  store?: PersonaStore
  /** Freeform scope-memory store (global/host/user-note). Defaults in-memory. */
  scopeStore?: ScopeMemoryStore
  /** Shared secret for every guarded route; defaults to INTERNAL_API_TOKEN env. */
  internalToken?: string
}

export function buildService(opts: ServiceOptions = {}): FastifyInstance {
  const store = opts.store ?? new InMemoryPersonaStore()
  const scopeStore = opts.scopeStore ?? new InMemoryScopeMemoryStore()
  const internalToken = opts.internalToken ?? process.env.INTERNAL_API_TOKEN ?? ''
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test' && { level: process.env.LOG_LEVEL ?? 'info' },
  })

  type Params = { partnerId: string; userId: string }

  // ── internal trust boundary (x-hippo-internal-token) ───────────────────
  // Guards every route that touches persona data — the /v1/persona PII surface
  // and the /admin/* panel alike. Fail-closed: no env token → 503, never open.
  function requireInternalToken(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!internalToken) {
      reply.code(503).send({ error: 'memory service disabled: INTERNAL_API_TOKEN not set' })
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

  app.get<{ Params: Params }>('/v1/persona/:partnerId/:userId', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    const { partnerId, userId } = req.params
    return store.get(partnerId, userId)
  })

  app.put<{ Params: Params }>('/v1/persona/:partnerId/:userId', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    const patch = parseUpdate(req.body)
    if (patch === null) return reply.code(400).send({ error: 'invalid persona update' })
    const { partnerId, userId } = req.params
    return store.update(partnerId, userId, patch)
  })

  app.post<{ Params: Params }>('/v1/persona/:partnerId/:userId/clear', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    const { partnerId, userId } = req.params
    return store.clear(partnerId, userId)
  })

  // ── admin surface (panel-only; same internal token) ────────────────────
  app.get<{
    Querystring: { partnerId?: string; optIn?: string; offset?: string; limit?: string }
  }>('/admin/personas', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    const { partnerId, optIn, offset, limit } = req.query
    return store.list({
      ...(partnerId ? { partnerId } : {}),
      ...(optIn === 'true' ? { optIn: true } : optIn === 'false' ? { optIn: false } : {}),
      offset: Number(offset ?? 0) || 0,
      limit: Math.min(Number(limit ?? 50) || 50, 200),
    })
  })

  app.delete<{ Params: Params }>('/admin/personas/:partnerId/:userId', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    const { partnerId, userId } = req.params
    const deleted = await store.delete(partnerId, userId)
    return { deleted }
  })

  // Bulk purge for partner offboarding — partnerId is mandatory: there is
  // deliberately no "delete everything" surface.
  app.delete<{ Querystring: { partnerId?: string } }>('/admin/personas', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    const { partnerId } = req.query
    if (!partnerId) return reply.code(400).send({ error: 'partnerId required' })
    const deleted = await store.deleteByPartner(partnerId)
    return { deleted }
  })

  // ── scope-memory documents (global / host / user note) ────────────────
  // Freeform prose a super-admin curates; the gateway composes these (super-
  // admin → host → user → session) into the prompt. Same internal-token
  // trust boundary. Bodies are size-bounded server-side (MAX_BODY).
  const readBody = (b: unknown): string | null =>
    typeof (b as { body?: unknown } | null)?.body === 'string' ? (b as { body: string }).body : null

  app.get('/v1/scope/global', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    return scopeStore.getGlobal()
  })
  app.put('/v1/scope/global', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    const body = readBody(req.body)
    if (body === null) return reply.code(400).send({ error: 'body (string) required' })
    return scopeStore.setGlobal(body, Date.now())
  })

  app.get<{ Params: { partnerId: string } }>('/v1/scope/host/:partnerId', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    return scopeStore.getHost(req.params.partnerId)
  })
  app.put<{ Params: { partnerId: string } }>('/v1/scope/host/:partnerId', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    const body = readBody(req.body)
    if (body === null) return reply.code(400).send({ error: 'body (string) required' })
    return scopeStore.setHost(req.params.partnerId, body, Date.now())
  })

  app.get<{ Params: Params }>('/v1/scope/user/:partnerId/:userId', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    return scopeStore.getUserNote(req.params.partnerId, req.params.userId)
  })
  app.put<{ Params: Params }>('/v1/scope/user/:partnerId/:userId', async (req, reply) => {
    if (!requireInternalToken(req, reply)) return reply
    const body = readBody(req.body)
    if (body === null) return reply.code(400).send({ error: 'body (string) required' })
    return scopeStore.setUserNote(req.params.partnerId, req.params.userId, body, Date.now())
  })

  app.get('/health', async () => ({
    ok: true,
    service: 'memory',
    personas: await store.size(),
    maxBody: MAX_BODY,
  }))

  return app
}
