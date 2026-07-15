import { describe, expect, it } from 'vitest'
import { buildService } from '../src/service.js'
import { InMemoryPersonaStore } from '../src/store.js'

describe('persona store', () => {
  it('accrues nothing while opted out — persona, not surveillance', () => {
    const store = new InMemoryPersonaStore()
    store.update('p1', 'u1', { followAsset: 'BTC', openThread: { text: 'why is btc down' } })
    const persona = store.get('p1', 'u1')
    expect(persona.optIn).toBe(false)
    expect(persona.followedAssets).toEqual([])
    expect(persona.openThreads).toEqual([])
  })

  it('records followed assets most-recent-first, deduped, capped at 8', () => {
    const store = new InMemoryPersonaStore()
    store.update('p1', 'u1', { optIn: true })
    for (const a of ['btc', 'eth', 'sol', 'btc', 'ada', 'doge', 'xrp', 'matic', 'bnb', 'ltc']) {
      store.update('p1', 'u1', { followAsset: a })
    }
    const { followedAssets } = store.get('p1', 'u1')
    expect(followedAssets[0]).toBe('LTC')
    expect(followedAssets).toHaveLength(8)
    expect(new Set(followedAssets).size).toBe(8) // deduped
  })

  it('keeps at most 3 open threads, newest first', () => {
    const store = new InMemoryPersonaStore()
    store.update('p1', 'u1', { optIn: true })
    for (const q of ['q1', 'q2', 'q3', 'q4']) {
      store.update('p1', 'u1', { openThread: { text: q, symbol: 'BTC' } })
    }
    const { openThreads } = store.get('p1', 'u1')
    expect(openThreads.map((t) => t.text)).toEqual(['q4', 'q3', 'q2'])
  })

  it('scopes personas per partner — partner A never sees partner B', () => {
    const store = new InMemoryPersonaStore()
    store.update('pA', 'u1', { optIn: true, followAsset: 'BTC' })
    expect(store.get('pB', 'u1').followedAssets).toEqual([])
  })

  it('clear wipes data but preserves the opt-in choice', () => {
    const store = new InMemoryPersonaStore()
    store.update('p1', 'u1', { optIn: true, experienceLevel: 'pro', followAsset: 'BTC' })
    const wiped = store.clear('p1', 'u1')
    expect(wiped.followedAssets).toEqual([])
    expect(wiped.openThreads).toEqual([])
    expect(wiped.experienceLevel).toBeNull()
    expect(wiped.optIn).toBe(true) // clearing is not opting out
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
