/**
 * Minimal per-IP fixed-window rate limiter — zero deps.
 *
 * Mirror of the gateway plugin — deliberately duplicated, like guard.ts:
 * services never import each other's source. Applied app-wide on this panel
 * surface except /health (deploy probes must never be throttled).
 *
 * In-memory buckets are pod-local; that is acceptable for a coarse abuse guard.
 * A distributed limit (Redis token bucket) is the pod-fleet upgrade — same
 * preHandler surface.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

export type RateLimitOptions = {
  /** Max requests per IP per window. */
  max: number
  /** Rolling window length in milliseconds. */
  windowMs: number
}

type Bucket = { count: number; resetAt: number }

/** The preHandler shape createRateLimiter returns (shared with new routes). */
export type RateLimitHandler = ReturnType<typeof createRateLimiter>

export function createRateLimiter(opts: RateLimitOptions) {
  const buckets = new Map<string, Bucket>()
  // Reclaim expired buckets so the map can't grow unbounded under IP churn.
  setInterval(() => {
    const now = Date.now()
    for (const [ip, b] of buckets) if (b.resetAt <= now) buckets.delete(ip)
  }, opts.windowMs).unref()

  return async function rateLimit(req: FastifyRequest, reply: FastifyReply) {
    const now = Date.now()
    const ip = req.ip || 'unknown'
    let bucket = buckets.get(ip)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs }
      buckets.set(ip, bucket)
    }
    bucket.count += 1
    reply.header('x-ratelimit-limit', String(opts.max))
    reply.header('x-ratelimit-remaining', String(Math.max(0, opts.max - bucket.count)))
    if (bucket.count > opts.max) {
      reply.header('retry-after', String(Math.ceil((bucket.resetAt - now) / 1000)))
      reply.code(429)
      return reply.send({ error: 'rate limit exceeded' })
    }
  }
}
