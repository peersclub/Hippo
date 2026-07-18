/**
 * Per-IP rate limiting on the partner-facing mint/turn surface. Internal
 * routes, /health and the SSE stream are never throttled.
 */
import { describe, expect, it } from 'vitest'
import { testApp } from './helpers.js'

const mint = { method: 'POST' as const, url: '/v1/session', payload: { partnerKey: 'pk_demo' } }

describe('rate limiting', () => {
  it('429s /v1/session past the per-IP threshold, with a Retry-After', async () => {
    const { app } = await testApp({ rateLimit: { max: 3, windowMs: 60_000 } })
    for (let i = 0; i < 3; i++) {
      expect((await app.inject(mint)).statusCode).toBe(200)
    }
    const limited = await app.inject(mint)
    expect(limited.statusCode).toBe(429)
    expect((limited.json() as { error: string }).error).toBe('rate limit exceeded')
    expect(limited.headers['retry-after']).toBeDefined()
    expect(limited.headers['x-ratelimit-limit']).toBe('3')
    await app.close()
  })

  it('shares the budget across /v1/session and /v1/turns', async () => {
    const { app } = await testApp({ rateLimit: { max: 2, windowMs: 60_000 } })
    expect((await app.inject(mint)).statusCode).toBe(200)
    expect((await app.inject(mint)).statusCode).toBe(200)
    // Third partner-facing request — a turn this time — is over the shared limit.
    const turn = await app.inject({
      method: 'POST',
      url: '/v1/turns',
      payload: { v: 1, kind: 'user_text', sessionId: 'whatever', text: 'hi', ts: Date.now() },
    })
    expect(turn.statusCode).toBe(429)
    await app.close()
  })

  it('never throttles /health or /internal/* even past the limit', async () => {
    const { app } = await testApp({ rateLimit: { max: 1, windowMs: 60_000 } })
    expect((await app.inject(mint)).statusCode).toBe(200)
    expect((await app.inject(mint)).statusCode).toBe(429) // partner surface is now limited
    // Unrelated surfaces stay open.
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
      expect((await app.inject({ method: 'GET', url: '/internal/metrics' })).statusCode).toBe(200)
    }
    await app.close()
  })
})
