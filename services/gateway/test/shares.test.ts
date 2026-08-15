/**
 * Share cards (baseline §6): POST /v1/shares mints a short id for a brief the
 * session actually received; GET /s/:id is the public co-branded page that
 * re-grounds on the live market at open time. The tenancy law under test:
 * a share record carries market-level content only, so the public page can
 * never leak a person.
 */
import { describe, expect, it } from 'vitest'
import { SHARE_DISCLAIMER } from '../src/shares.js'
import {
  briefFixture,
  createSession,
  deadMarket,
  frameOfType,
  sendTurn,
  stubIntel,
  testApp,
  waitForJournal,
} from './helpers.js'

/** Mint a session with a research_brief in its journal, then share it. */
async function sessionWithBrief(app: Awaited<ReturnType<typeof testApp>>) {
  const session = await createSession(app.app, app.sessions)
  await sendTurn(app.app, session.id, { kind: 'user_text', text: 'why is btc down?' })
  await waitForJournal(session, (t) => t.includes('research_brief'))
  const brief = frameOfType<{ id: string }>(session, 'research_brief')
  return { session, brief }
}

async function mintShare(
  app: Awaited<ReturnType<typeof testApp>>,
): Promise<{ id: string; url: string; sessionId: string }> {
  const { session, brief } = await sessionWithBrief(app)
  const res = await app.app.inject({
    method: 'POST',
    url: '/v1/shares',
    payload: { sessionId: session.id, frameId: brief.id },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json() as { id: string; url: string }
  return { ...body, sessionId: session.id }
}

describe('POST /v1/shares', () => {
  it('mints a short id + resolving URL for a brief the session received', async () => {
    const app = await testApp()
    const { id, url } = await mintShare(app)
    expect(id).toMatch(/^[a-f0-9]{12}$/)
    expect(url.endsWith(`/s/${id}`)).toBe(true)
    expect(url).toMatch(/^https?:\/\//)
    await app.app.close()
  })

  it('400s a malformed body (missing sessionId/frameId)', async () => {
    const app = await testApp()
    for (const payload of [
      {},
      { sessionId: 's' },
      { frameId: 'f' },
      { sessionId: '', frameId: '' },
    ]) {
      const res = await app.app.inject({ method: 'POST', url: '/v1/shares', payload })
      expect(res.statusCode).toBe(400)
    }
    await app.app.close()
  })

  it('404s an unknown session', async () => {
    const app = await testApp()
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/shares',
      payload: { sessionId: 'sess_nope', frameId: 'frame_nope' },
    })
    expect(res.statusCode).toBe(404)
    await app.app.close()
  })

  it('404s a frame the session never received — you can only share what the server sent you', async () => {
    const app = await testApp()
    const { session } = await sessionWithBrief(app)
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/shares',
      payload: { sessionId: session.id, frameId: 'frame_fabricated' },
    })
    expect(res.statusCode).toBe(404)
    await app.app.close()
  })

  it('404s a frame id that exists but is not a research_brief', async () => {
    const app = await testApp()
    const { session } = await sessionWithBrief(app)
    // Every session journal starts with non-brief frames (e.g. onboarding);
    // pick one and try to share it.
    const nonBrief = session.journal.after(0).find((e) => e.frame.type !== 'research_brief')
    expect(nonBrief).toBeDefined()
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/shares',
      payload: { sessionId: session.id, frameId: nonBrief?.frame.id },
    })
    expect(res.statusCode).toBe(404)
    await app.app.close()
  })
})

describe('GET /s/:id', () => {
  it('renders the co-branded card: headline, prose, venue, printed disclaimer, live re-ground', async () => {
    const app = await testApp()
    const { id } = await mintShare(app)
    const res = await app.app.inject({ method: 'GET', url: `/s/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    const html = res.body
    expect(html).toContain(briefFixture.headline)
    expect(html).toContain(briefFixture.paragraphs[0])
    // Co-branding draws the partner's venue name.
    expect(html).toMatch(/on [A-Za-z]/)
    // The advice line is printed IN the body, not just a meta tag.
    expect(html).toContain(SHARE_DISCLAIMER)
    // Re-grounded live strip from market-data at open time (stub fixture).
    expect(html).toContain('NOW')
    expect(html).toContain('61,240')
    // Share pages are unlisted-by-design.
    expect(html).toContain('noindex')
    await app.app.close()
  })

  it('never leaks identity: the page carries no session id', async () => {
    const app = await testApp()
    const { id, sessionId } = await mintShare(app)
    const res = await app.app.inject({ method: 'GET', url: `/s/${id}` })
    expect(res.body).not.toContain(sessionId)
    await app.app.close()
  })

  it('renders honestly when the market feed is down — no fake current price', async () => {
    const app = await testApp({ market: deadMarket })
    const { id } = await mintShare(app)
    const res = await app.app.inject({ method: 'GET', url: `/s/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('LIVE PRICE UNAVAILABLE')
    expect(res.body).not.toContain('NOW</span>')
    await app.app.close()
  })

  it('404s an unknown or malformed id with the honest expired page', async () => {
    const app = await testApp()
    for (const id of ['aaaaaaaaaaaa', 'not-a-share-id', '../etc/passwd']) {
      const res = await app.app.inject({ method: 'GET', url: `/s/${encodeURIComponent(id)}` })
      expect(res.statusCode).toBe(404)
      expect(res.body).toContain('expired')
      expect(res.body).toContain(SHARE_DISCLAIMER)
    }
    await app.app.close()
  })

  it('expires shares after the TTL — an old link renders the expired page', async () => {
    const app = await testApp({ shareTtlMs: 0 })
    const { id } = await mintShare(app)
    const res = await app.app.inject({ method: 'GET', url: `/s/${id}` })
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('expired')
    await app.app.close()
  })

  it('escapes brief content — a hostile headline cannot script the share page', async () => {
    const hostile = '<script>alert(1)</script> & "BTC" <b>down</b>'
    const app = await testApp({
      intel: stubIntel({
        respond: () => ({
          ...briefFixture,
          headline: hostile,
          paragraphs: ['<img src=x onerror=1>'],
        }),
      }),
    })
    const { id } = await mintShare(app)
    const res = await app.app.inject({ method: 'GET', url: `/s/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('<script>alert')
    expect(res.body).not.toContain('<img src=x')
    expect(res.body).toContain('&lt;script&gt;')
    await app.app.close()
  })
})
