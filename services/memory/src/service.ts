/**
 * Memory service HTTP surface (regional pod — PII stays in-region, L1):
 *   GET  /v1/persona/:partnerId/:userId        → persona (default if unseen)
 *   PUT  /v1/persona/:partnerId/:userId        → merge a PersonaUpdate
 *   POST /v1/persona/:partnerId/:userId/clear  → wipe data (settings promise)
 *   GET  /health
 */
import Fastify, { type FastifyInstance } from 'fastify'
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

export function buildService(store: PersonaStore = new InMemoryPersonaStore()): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && { level: 'info' } })

  type Params = { partnerId: string; userId: string }

  app.get<{ Params: Params }>('/v1/persona/:partnerId/:userId', async (req) => {
    const { partnerId, userId } = req.params
    return store.get(partnerId, userId)
  })

  app.put<{ Params: Params }>('/v1/persona/:partnerId/:userId', async (req, reply) => {
    const patch = parseUpdate(req.body)
    if (patch === null) return reply.code(400).send({ error: 'invalid persona update' })
    const { partnerId, userId } = req.params
    return store.update(partnerId, userId, patch)
  })

  app.post<{ Params: Params }>('/v1/persona/:partnerId/:userId/clear', async (req) => {
    const { partnerId, userId } = req.params
    return store.clear(partnerId, userId)
  })

  app.get('/health', async () => ({ ok: true, service: 'memory', personas: store.size() }))

  return app
}
