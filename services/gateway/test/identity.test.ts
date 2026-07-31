/**
 * In-panel username+PIN identity (identity_claim uplink → identity frames).
 * Covers create/taken/signin/wrong_pin/rate_limited/signout, the effective-
 * userId switch (memory keys to `id:<username_lower>` from adoption), and
 * the link-based restore at the next session start for the same sub.
 */
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { Session } from '../src/plugins/auth.js'
import { signJwtHS256 } from '../src/plugins/auth.js'
import { createSession, sendTurn, stubMemory, testApp, waitForJournal } from './helpers.js'

type IdentityFrame = {
  type: 'identity'
  status: 'ok' | 'taken' | 'wrong_pin' | 'invalid' | 'rate_limited' | 'signed_out'
  username?: string
  note?: string
}

function identityFrames(session: Session): IdentityFrame[] {
  return session.journal
    .after(0)
    .filter((e) => e.frame.type === 'identity')
    .map((e) => e.frame as unknown as IdentityFrame)
}

/** Send an identity_claim and wait for its answering identity frame. */
async function claim(
  app: FastifyInstance,
  session: Session,
  body: Record<string, unknown>,
): Promise<IdentityFrame> {
  const before = identityFrames(session).length
  const status = await sendTurn(app, session.id, { kind: 'identity_claim', ...body })
  expect(status).toBe(200)
  await waitForJournal(session, (t) => t.filter((x) => x === 'identity').length > before)
  const frames = identityFrames(session)
  return frames[frames.length - 1] as IdentityFrame
}

/** Mint a JWT-authenticated session for a stable sub (dev partner secret). */
async function createSessionForSub(
  app: FastifyInstance,
  sessions: { get(id: string): Session | null },
  sub: string,
): Promise<Session> {
  const token = signJwtHS256(
    {
      iss: 'koinbx-dev',
      sub,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    'koinbx-dev-secret-not-for-production',
  )
  const res = await app.inject({
    method: 'POST',
    url: '/v1/session',
    headers: { authorization: `Bearer ${token}` },
    payload: { partnerKey: 'pk_demo' },
  })
  expect(res.statusCode).toBe(200)
  const { sessionId } = res.json() as { sessionId: string }
  const session = sessions.get(sessionId)
  if (!session) throw new Error('minted session missing from store')
  return session
}

describe('identity_claim → identity frames', () => {
  it('create claims a free username and answers ok', async () => {
    const { app, sessions } = await testApp()
    const session = await createSession(app, sessions)
    const frame = await claim(app, session, { mode: 'create', username: 'Alice', pin: '1234' })
    expect(frame.status).toBe('ok')
    expect(frame.username).toBe('Alice')
    expect(session.identity).toEqual({ username: 'Alice', usernameLower: 'alice' })
  })

  it('create answers taken for a claimed username — case-insensitively', async () => {
    const { app, sessions } = await testApp()
    const a = await createSession(app, sessions)
    expect((await claim(app, a, { mode: 'create', username: 'alice', pin: '1234' })).status).toBe(
      'ok',
    )
    const b = await createSession(app, sessions)
    const frame = await claim(app, b, { mode: 'create', username: 'ALICE', pin: '9999' })
    expect(frame.status).toBe('taken')
    expect(b.identity).toBeUndefined()
  })

  it('create without a pin answers invalid; malformed fields 400 at the schema', async () => {
    const { app, sessions } = await testApp()
    const session = await createSession(app, sessions)
    const frame = await claim(app, session, { mode: 'create', username: 'bob' })
    expect(frame.status).toBe('invalid')
    // Regex-invalid username / PIN never reach the orchestrator (zod 400s).
    expect(
      await sendTurn(app, session.id, {
        kind: 'identity_claim',
        mode: 'create',
        username: 'x!',
        pin: '1234',
      }),
    ).toBe(400)
    expect(
      await sendTurn(app, session.id, {
        kind: 'identity_claim',
        mode: 'create',
        username: 'bob',
        pin: '12345',
      }),
    ).toBe(400)
  })

  it('signin verifies the PIN; a wrong PIN (or unknown username) answers wrong_pin', async () => {
    const { app, sessions } = await testApp()
    const a = await createSession(app, sessions)
    await claim(app, a, { mode: 'create', username: 'carol', pin: '4321' })

    const b = await createSession(app, sessions)
    expect((await claim(app, b, { mode: 'signin', username: 'carol', pin: '0000' })).status).toBe(
      'wrong_pin',
    )
    expect((await claim(app, b, { mode: 'signin', username: 'nobody', pin: '0000' })).status).toBe(
      'wrong_pin',
    )
    const ok = await claim(app, b, { mode: 'signin', username: 'CAROL', pin: '4321' })
    expect(ok.status).toBe('ok')
    expect(ok.username).toBe('carol') // display casing as first claimed
    expect(b.identity).toEqual({ username: 'carol', usernameLower: 'carol' })
  })

  it('rate-limits after 5 failed PIN attempts per session+username', async () => {
    const { app, sessions } = await testApp()
    const a = await createSession(app, sessions)
    await claim(app, a, { mode: 'create', username: 'dave', pin: '7777' })

    const b = await createSession(app, sessions)
    for (let i = 0; i < 5; i++) {
      expect((await claim(app, b, { mode: 'signin', username: 'dave', pin: '0000' })).status).toBe(
        'wrong_pin',
      )
    }
    // 6th attempt — even with the CORRECT pin — is rate limited.
    expect((await claim(app, b, { mode: 'signin', username: 'dave', pin: '7777' })).status).toBe(
      'rate_limited',
    )
    // A different username on the same session is not affected.
    expect((await claim(app, b, { mode: 'signin', username: 'other', pin: '0000' })).status).toBe(
      'wrong_pin',
    )
  })

  it('signout reverts to the host-minted sub and answers signed_out', async () => {
    const { app, sessions } = await testApp()
    const session = await createSession(app, sessions)
    await claim(app, session, { mode: 'create', username: 'erin', pin: '1111' })
    const frame = await claim(app, session, { mode: 'signout' })
    expect(frame.status).toBe('signed_out')
    expect(session.identity).toBeNull()
  })
})

describe('effective userId switch (memory keying)', () => {
  it('keys persona/memory to id:<username_lower> after adoption, and back after signout', async () => {
    const memory = stubMemory({ optIn: true })
    const { app, sessions } = await testApp({ memory })
    const session = await createSession(app, sessions)

    await claim(app, session, { mode: 'create', username: 'Frank', pin: '2468' })
    await sendTurn(app, session.id, { kind: 'user_text', text: 'What is BTC doing?' })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(memory.updates.length).toBeGreaterThan(0)
    expect(memory.updates.at(-1)?.userId).toBe('id:frank')

    await claim(app, session, { mode: 'signout' })
    const before = memory.updates.length
    await sendTurn(app, session.id, { kind: 'user_text', text: 'What is ETH doing?' })
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 2)
    expect(memory.updates.length).toBeGreaterThan(before)
    // Anonymous dev session: the sub is the session id.
    expect(memory.updates.at(-1)?.userId).toBe(session.id)
  })
})

describe('identity restore at session start', () => {
  it('adopts the linked identity for a returning sub and emits a journaled ok frame', async () => {
    const { app, sessions } = await testApp()
    const first = await createSessionForSub(app, sessions, 'venue-user-42')
    await claim(app, first, { mode: 'create', username: 'grace', pin: '1357' })

    // Same sub, brand-new session: connecting the stream restores the identity.
    const second = await createSessionForSub(app, sessions, 'venue-user-42')
    await app.listen({ port: 0, host: '127.0.0.1' })
    try {
      const address = app.server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      const ctrl = new AbortController()
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/stream?session=${second.id}`, {
        headers: { accept: 'text/event-stream' },
        signal: ctrl.signal,
      })
      expect(res.status).toBe(200)
      await waitForJournal(second, (t) => t.includes('identity'))
      ctrl.abort()
    } finally {
      await app.close()
    }
    const frame = identityFrames(second)[0]
    expect(frame?.status).toBe('ok')
    expect(frame?.username).toBe('grace')
    expect(second.identity).toEqual({ username: 'grace', usernameLower: 'grace' })
  })

  it('does not restore after signout (the link is removed)', async () => {
    const { app, sessions } = await testApp()
    const first = await createSessionForSub(app, sessions, 'venue-user-43')
    await claim(app, first, { mode: 'create', username: 'heidi', pin: '9753' })
    await claim(app, first, { mode: 'signout' })

    const second = await createSessionForSub(app, sessions, 'venue-user-43')
    await app.listen({ port: 0, host: '127.0.0.1' })
    try {
      const address = app.server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      const ctrl = new AbortController()
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/stream?session=${second.id}`, {
        headers: { accept: 'text/event-stream' },
        signal: ctrl.signal,
      })
      expect(res.status).toBe(200)
      // The connect-time frames (orders_snapshot) land; no identity frame does.
      await waitForJournal(second, (t) => t.includes('orders_snapshot'))
      ctrl.abort()
    } finally {
      await app.close()
    }
    expect(identityFrames(second)).toEqual([])
    expect(second.identity).toBeUndefined()
  })
})
