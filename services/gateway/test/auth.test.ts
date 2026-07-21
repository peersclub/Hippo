import { describe, expect, it } from 'vitest'
import { PARTNERS, signJwtHS256, verifyJwtHS256 } from '../src/plugins/auth.js'
import { testApp, testAppRaw } from './helpers.js'

const partner = PARTNERS[0]
if (!partner) throw new Error('no dev partner configured')

const now = Math.floor(Date.now() / 1000)
const validClaims = { iss: partner.partnerId, sub: 'venue-user-42', iat: now, exp: now + 300 }

describe('auth: dev mode', () => {
  it('mints an anonymous session from a partnerKey, mock-compatible shape', async () => {
    const { app, sessions } = await testApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/session',
      payload: { partnerKey: 'pk_demo' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      sessionId: string
      config: { venueName: string; locales: string[]; suggestedQueries: string[] }
    }
    expect(body.sessionId).toMatch(/^s_/)
    expect(body.config.venueName).toBe('Assetworks')
    expect(body.config.locales).toContain('hinglish')
    expect(body.config.suggestedQueries.length).toBeGreaterThan(0)
    expect(sessions.get(body.sessionId)?.venueUserId).toBeNull()
    await app.close()
  })

  it('rejects anonymous sessions when dev mode is off', async () => {
    const { app } = await testApp({ devMode: false })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/session',
      payload: { partnerKey: 'pk_demo' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('is safe by default: anonymous mint is rejected when devMode is unset (opt-in)', async () => {
    // Neither opts.devMode nor HIPPO_DEV=1 → dev mode is OFF (prod-safe).
    const saved = process.env.HIPPO_DEV
    delete process.env.HIPPO_DEV
    try {
      const { app } = await testAppRaw()
      const res = await app.inject({
        method: 'POST',
        url: '/v1/session',
        payload: { partnerKey: 'pk_demo' },
      })
      expect(res.statusCode).toBe(401)
      await app.close()
    } finally {
      if (saved === undefined) delete process.env.HIPPO_DEV
      else process.env.HIPPO_DEV = saved
    }
  })
})

describe('auth: JWT mode', () => {
  it('binds the session to the venue user from a valid partner JWT', async () => {
    const { app, sessions } = await testApp({ devMode: false })
    const token = signJwtHS256(validClaims, partner.jwtSecret)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/session',
      headers: { authorization: `Bearer ${token}` },
      payload: { partnerKey: 'pk_demo' },
    })
    expect(res.statusCode).toBe(200)
    const { sessionId } = res.json() as { sessionId: string }
    expect(sessions.get(sessionId)?.venueUserId).toBe('venue-user-42')
    await app.close()
  })

  it('401s a JWT signed with the wrong secret', async () => {
    const { app } = await testApp()
    const token = signJwtHS256(validClaims, 'not-the-partner-secret')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/session',
      headers: { authorization: `Bearer ${token}` },
      payload: { partnerKey: 'pk_demo' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('401s an expired JWT', async () => {
    const { app } = await testApp()
    const token = signJwtHS256({ ...validClaims, exp: now - 10 }, partner.jwtSecret)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/session',
      headers: { authorization: `Bearer ${token}` },
      payload: { partnerKey: 'pk_demo' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('401s garbage bearer tokens even in dev mode (no silent downgrade)', async () => {
    const { app } = await testApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/session',
      headers: { authorization: 'Bearer not.a.jwt' },
      payload: { partnerKey: 'pk_demo' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})

describe('verifyJwtHS256', () => {
  it('round-trips claims and rejects tampered payloads', () => {
    const token = signJwtHS256(validClaims, 'secret')
    expect(verifyJwtHS256(token, 'secret')?.sub).toBe('venue-user-42')

    const [h, , s] = token.split('.') as [string, string, string]
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...validClaims, sub: 'attacker' })).toString('base64url')}.${s}`
    expect(verifyJwtHS256(forged, 'secret')).toBeNull()
  })
})
