/**
 * Live-session inventory + admin kill switch: /internal/sessions.
 */
import { describe, expect, it } from 'vitest'
import { PARTNERS, signJwtHS256 } from '../src/plugins/auth.js'
import { testApp } from './helpers.js'

const TOKEN = 'test-internal'
const partner = PARTNERS[0]
if (!partner) throw new Error('no dev partner configured')

const now = Math.floor(Date.now() / 1000)
const jwtFor = (sub: string) =>
  signJwtHS256({ iss: partner.partnerId, sub, iat: now, exp: now + 300 }, partner.jwtSecret)

describe('/internal/sessions', () => {
  it('fail-closed 503 without a configured token; 401 on wrong token', async () => {
    const closed = await testApp({ internalToken: '' })
    expect((await closed.app.inject({ method: 'GET', url: '/internal/sessions' })).statusCode).toBe(
      503,
    )
    await closed.app.close()

    const { app } = await testApp({ internalToken: TOKEN })
    expect((await app.inject({ method: 'GET', url: '/internal/sessions' })).statusCode).toBe(401)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/internal/sessions',
          headers: { 'x-hippo-internal-token': 'nope' },
        })
      ).statusCode,
    ).toBe(401)
    await app.close()
  })

  it('lists live sessions with partner/user identity and connect state', async () => {
    const { app } = await testApp({ internalToken: TOKEN })
    await app.inject({ method: 'POST', url: '/v1/session', payload: { partnerKey: 'pk_demo' } })
    await app.inject({
      method: 'POST',
      url: '/v1/session',
      headers: { authorization: `Bearer ${jwtFor('venue-user-5')}` },
      payload: { partnerKey: 'pk_demo' },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/internal/sessions',
      headers: { 'x-hippo-internal-token': TOKEN },
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{
      partnerId: string
      venueUserId: string | null
      connected: boolean
    }>
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.partnerId === 'koinbx-dev')).toBe(true)
    expect(rows.map((r) => r.venueUserId).sort()).toEqual([null, 'venue-user-5'].sort())
    expect(rows.every((r) => r.connected === false)).toBe(true) // no SSE attached in this test
    await app.close()
  })

  it('revoke kills the session: turns 404 afterwards; unknown id → revoked:false', async () => {
    const { app } = await testApp({ internalToken: TOKEN })
    const mint = await app.inject({
      method: 'POST',
      url: '/v1/session',
      payload: { partnerKey: 'pk_demo' },
    })
    const { sessionId } = mint.json() as { sessionId: string }

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/internal/sessions/${sessionId}`,
      headers: { 'x-hippo-internal-token': TOKEN },
    })
    expect(revoke.json()).toEqual({ revoked: true })

    // The revoked session is gone for real traffic.
    const turn = await app.inject({
      method: 'POST',
      url: '/v1/turns',
      payload: { v: 1, kind: 'user_text', sessionId, text: 'hello', ts: Date.now() },
    })
    expect(turn.statusCode).toBe(404)

    const again = await app.inject({
      method: 'DELETE',
      url: `/internal/sessions/${sessionId}`,
      headers: { 'x-hippo-internal-token': TOKEN },
    })
    expect(again.json()).toEqual({ revoked: false })
    await app.close()
  })
})

describe('/internal/venue-events (same internal guard)', () => {
  const evt = { ticketId: 't_x', phase: 'filled', statusLine: 'FILLED' }

  it('fail-closed 503 when INTERNAL_API_TOKEN is unset', async () => {
    const { app } = await testApp({ internalToken: '' })
    const res = await app.inject({ method: 'POST', url: '/internal/venue-events', payload: evt })
    expect(res.statusCode).toBe(503)
    await app.close()
  })

  it('401 on a missing or wrong token — no forged lifecycle frames', async () => {
    const { app } = await testApp({ internalToken: TOKEN })
    const missing = await app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      payload: evt,
    })
    expect(missing.statusCode).toBe(401)
    const bad = await app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      headers: { 'x-hippo-internal-token': 'nope' },
      payload: evt,
    })
    expect(bad.statusCode).toBe(401)
    await app.close()
  })

  it('accepts a correctly-tokened event (unknown ticket → routed:false)', async () => {
    const { app } = await testApp({ internalToken: TOKEN })
    const res = await app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      headers: { 'x-hippo-internal-token': TOKEN },
      payload: evt,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, routed: false })
    await app.close()
  })
})
