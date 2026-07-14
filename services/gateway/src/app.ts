/**
 * Production gateway — SKELETON. Same route surface as mock-gateway;
 * Phase 2 replaces scripted frames with the orchestrator
 * (intent → cache → research → seam). See vault: Build Plan/10 BE Architecture.
 */
import cors from '@fastify/cors'
import Fastify from 'fastify'

const PORT = Number(process.env.PORT ?? 8788)

const app = Fastify({ logger: { level: 'info' } })
await app.register(cors, { origin: false })

// plugins/auth.ts — partner-signed JWT (JWKS per partner) → hippo session. TODO Phase 2.
// plugins/sse.ts — frame journal (Redis Stream) + Last-Event-ID resume.   TODO Phase 2.
// orchestrator/ — the card state machine.                                 TODO Phase 2.

app.post('/v1/session', async (_req, reply) => {
  reply.code(501)
  return { error: 'not implemented — use @hippo/mock-gateway for development' }
})

app.get('/v1/stream', async (_req, reply) => {
  reply.code(501)
  return { error: 'not implemented — use @hippo/mock-gateway for development' }
})

app.post('/v1/turns', async (_req, reply) => {
  reply.code(501)
  return { error: 'not implemented — use @hippo/mock-gateway for development' }
})

app.get('/health', async () => ({ ok: true, service: 'gateway', phase: 'skeleton' }))

if (process.env.NODE_ENV !== 'test') {
  await app.listen({ port: PORT, host: '0.0.0.0' })
}

export { app }
