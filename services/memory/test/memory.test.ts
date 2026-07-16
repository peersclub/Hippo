import { describe, expect, it } from 'vitest'
import { buildService } from '../src/service.js'
import { InMemoryPersonaStore } from '../src/store.js'

describe('persona store', () => {
  it('accrues nothing while opted out — persona, not surveillance', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('p1', 'u1', { followAsset: 'BTC', openThread: { text: 'why is btc down' } })
    const persona = await store.get('p1', 'u1')
    expect(persona.optIn).toBe(false)
    expect(persona.followedAssets).toEqual([])
    expect(persona.openThreads).toEqual([])
  })

  it('records followed assets most-recent-first, deduped, capped at 8', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('p1', 'u1', { optIn: true })
    for (const a of ['btc', 'eth', 'sol', 'btc', 'ada', 'doge', 'xrp', 'matic', 'bnb', 'ltc']) {
      await store.update('p1', 'u1', { followAsset: a })
    }
    const { followedAssets } = await store.get('p1', 'u1')
    expect(followedAssets[0]).toBe('LTC')
    expect(followedAssets).toHaveLength(8)
    expect(new Set(followedAssets).size).toBe(8) // deduped
  })

  it('keeps at most 3 open threads, newest first', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('p1', 'u1', { optIn: true })
    for (const q of ['q1', 'q2', 'q3', 'q4']) {
      await store.update('p1', 'u1', { openThread: { text: q, symbol: 'BTC' } })
    }
    const { openThreads } = await store.get('p1', 'u1')
    expect(openThreads.map((t) => t.text)).toEqual(['q4', 'q3', 'q2'])
  })

  it('scopes personas per partner — partner A never sees partner B', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('pA', 'u1', { optIn: true, followAsset: 'BTC' })
    expect((await store.get('pB', 'u1')).followedAssets).toEqual([])
  })

  it('clear wipes data but preserves the opt-in choice', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('p1', 'u1', { optIn: true, experienceLevel: 'pro', followAsset: 'BTC' })
    const wiped = await store.clear('p1', 'u1')
    expect(wiped.followedAssets).toEqual([])
    expect(wiped.openThreads).toEqual([])
    expect(wiped.experienceLevel).toBeNull()
    expect(wiped.optIn).toBe(true) // clearing is not opting out
  })

  it('lists personas with partner/optIn filters and paging', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('pA', 'u1', { optIn: true, followAsset: 'BTC' })
    await store.update('pA', 'u2', { optIn: false })
    await store.update('pB', 'u3', { optIn: true })

    expect((await store.list()).total).toBe(3)
    expect((await store.list({ partnerId: 'pA' })).total).toBe(2)
    const optedIn = await store.list({ optIn: true })
    expect(optedIn.total).toBe(2)
    expect(optedIn.rows.every((r) => r.persona.optIn)).toBe(true)

    const page = await store.list({ offset: 0, limit: 1 })
    expect(page.rows).toHaveLength(1)
    expect(page.total).toBe(3)
  })

  it('delete is a hard purge — nothing survives, unlike clear', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('p1', 'u1', { optIn: true, followAsset: 'BTC' })
    expect(await store.delete('p1', 'u1')).toBe(true)
    expect(await store.size()).toBe(0)
    // Unseen again: default persona, optIn back to false.
    expect((await store.get('p1', 'u1')).optIn).toBe(false)
    expect(await store.delete('p1', 'u1')).toBe(false)
  })
})

describe('memory service HTTP surface', () => {
  it('GET returns the default persona for an unseen user', async () => {
    const app = buildService()
    const res = await app.inject({ method: 'GET', url: '/v1/persona/p1/u1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ optIn: false, followedAssets: [] })
    await app.close()
  })

  it('PUT merges and returns the updated persona', async () => {
    const app = buildService()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/persona/p1/u1',
      payload: { optIn: true, experienceLevel: 'new', followAsset: 'sol' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      optIn: true,
      experienceLevel: 'new',
      followedAssets: ['SOL'],
    })
    await app.close()
  })

  it('rejects malformed updates with 400', async () => {
    const app = buildService()
    for (const payload of [
      { optIn: 'yes' },
      { experienceLevel: 'wizard' },
      { followAsset: 'not an asset!!' },
      { openThread: { text: '' } },
    ]) {
      const res = await app.inject({ method: 'PUT', url: '/v1/persona/p1/u1', payload })
      expect(res.statusCode).toBe(400)
    }
    await app.close()
  })

  it('POST clear wipes via HTTP', async () => {
    const app = buildService()
    await app.inject({
      method: 'PUT',
      url: '/v1/persona/p1/u1',
      payload: { optIn: true, followAsset: 'btc' },
    })
    const res = await app.inject({ method: 'POST', url: '/v1/persona/p1/u1/clear' })
    expect(res.json().followedAssets).toEqual([])
    await app.close()
  })

  it('POST clear accepts an empty JSON body (what the gateway client sends)', async () => {
    const app = buildService()
    await app.inject({
      method: 'PUT',
      url: '/v1/persona/p1/u1',
      payload: { optIn: true, followAsset: 'btc' },
    })
    // Regression: a JSON content-type on the clear POST must not 400.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/persona/p1/u1/clear',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().followedAssets).toEqual([])
    await app.close()
  })
})

describe('admin surface', () => {
  const TOKEN = 'test-internal-token'

  it('is fail-closed: 503 when INTERNAL_API_TOKEN is not configured', async () => {
    const app = buildService({ internalToken: '' })
    const res = await app.inject({ method: 'GET', url: '/admin/personas' })
    expect(res.statusCode).toBe(503)
    await app.close()
  })

  it('rejects a missing or wrong token with 401', async () => {
    const app = buildService({ internalToken: TOKEN })
    expect((await app.inject({ method: 'GET', url: '/admin/personas' })).statusCode).toBe(401)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/admin/personas',
          headers: { 'x-hippo-internal-token': 'wrong' },
        })
      ).statusCode,
    ).toBe(401)
    await app.close()
  })

  it('lists personas with filters for a valid token', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('pA', 'u1', { optIn: true, followAsset: 'BTC' })
    await store.update('pB', 'u2', { optIn: false })
    const app = buildService({ store, internalToken: TOKEN })

    const res = await app.inject({
      method: 'GET',
      url: '/admin/personas?partnerId=pA',
      headers: { 'x-hippo-internal-token': TOKEN },
    })
    expect(res.statusCode).toBe(200)
    const page = res.json()
    expect(page.total).toBe(1)
    expect(page.rows[0]).toMatchObject({ partnerId: 'pA', userId: 'u1' })
    await app.close()
  })

  it('hard-deletes a persona for a valid token', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('pA', 'u1', { optIn: true })
    const app = buildService({ store, internalToken: TOKEN })

    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/personas/pA/u1',
      headers: { 'x-hippo-internal-token': TOKEN },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ deleted: true })
    expect(await store.size()).toBe(0)
    await app.close()
  })
})

describe('bulk purge (partner offboarding)', () => {
  it('deleteByPartner removes only that partner and reports the count', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('pA', 'u1', { optIn: true })
    await store.update('pA', 'u2', { optIn: false })
    await store.update('pB', 'u3', { optIn: true })
    expect(await store.deleteByPartner('pA')).toBe(2)
    expect(await store.size()).toBe(1)
    expect((await store.list({ partnerId: 'pB' })).total).toBe(1)
    expect(await store.deleteByPartner('pA')).toBe(0)
  })

  it('DELETE /admin/personas requires partnerId and the token', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('pA', 'u1', { optIn: true })
    const app = buildService({ store, internalToken: 'tok' })

    expect(
      (await app.inject({ method: 'DELETE', url: '/admin/personas?partnerId=pA' })).statusCode,
    ).toBe(401) // no token
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/admin/personas',
          headers: { 'x-hippo-internal-token': 'tok' },
        })
      ).statusCode,
    ).toBe(400) // no partnerId
    const ok = await app.inject({
      method: 'DELETE',
      url: '/admin/personas?partnerId=pA',
      headers: { 'x-hippo-internal-token': 'tok' },
    })
    expect(ok.json()).toEqual({ deleted: 1 })
    await app.close()
  })
})
