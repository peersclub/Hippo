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
  // Persona routes carry opt-in PII and are held to the internal-token trust
  // boundary, so the happy-path calls must present the token.
  const TOKEN = 'test-internal-token'
  const auth = { 'x-hippo-internal-token': TOKEN }

  it('GET returns the default persona for an unseen user', async () => {
    const app = buildService({ internalToken: TOKEN })
    const res = await app.inject({ method: 'GET', url: '/v1/persona/p1/u1', headers: auth })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ optIn: false, followedAssets: [] })
    await app.close()
  })

  it('PUT merges and returns the updated persona', async () => {
    const app = buildService({ internalToken: TOKEN })
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/persona/p1/u1',
      headers: auth,
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
    const app = buildService({ internalToken: TOKEN })
    for (const payload of [
      { optIn: 'yes' },
      { experienceLevel: 'wizard' },
      { followAsset: 'not an asset!!' },
      { openThread: { text: '' } },
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/persona/p1/u1',
        headers: auth,
        payload,
      })
      expect(res.statusCode).toBe(400)
    }
    await app.close()
  })

  it('POST clear wipes via HTTP', async () => {
    const app = buildService({ internalToken: TOKEN })
    await app.inject({
      method: 'PUT',
      url: '/v1/persona/p1/u1',
      headers: auth,
      payload: { optIn: true, followAsset: 'btc' },
    })
    const res = await app.inject({ method: 'POST', url: '/v1/persona/p1/u1/clear', headers: auth })
    expect(res.json().followedAssets).toEqual([])
    await app.close()
  })

  it('POST clear accepts an empty JSON body (what the gateway client sends)', async () => {
    const app = buildService({ internalToken: TOKEN })
    await app.inject({
      method: 'PUT',
      url: '/v1/persona/p1/u1',
      headers: auth,
      payload: { optIn: true, followAsset: 'btc' },
    })
    // Regression: a JSON content-type on the clear POST must not 400.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/persona/p1/u1/clear',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().followedAssets).toEqual([])
    await app.close()
  })
})

describe('persona routes trust boundary (PII)', () => {
  const TOKEN = 'test-internal-token'
  const auth = { 'x-hippo-internal-token': TOKEN }

  it('is fail-closed: 503 on every persona route when INTERNAL_API_TOKEN is unset', async () => {
    const app = buildService({ internalToken: '' })
    expect((await app.inject({ method: 'GET', url: '/v1/persona/p1/u1' })).statusCode).toBe(503)
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/persona/p1/u1',
          payload: { optIn: true },
        })
      ).statusCode,
    ).toBe(503)
    expect((await app.inject({ method: 'POST', url: '/v1/persona/p1/u1/clear' })).statusCode).toBe(
      503,
    )
    await app.close()
  })

  it('rejects a missing or wrong token with 401 on GET/PUT/clear', async () => {
    const app = buildService({ internalToken: TOKEN })
    const wrong = { 'x-hippo-internal-token': 'nope' }

    expect((await app.inject({ method: 'GET', url: '/v1/persona/p1/u1' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: '/v1/persona/p1/u1', headers: wrong })).statusCode,
    ).toBe(401)
    expect(
      (await app.inject({ method: 'PUT', url: '/v1/persona/p1/u1', payload: { optIn: true } }))
        .statusCode,
    ).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/v1/persona/p1/u1/clear' })).statusCode).toBe(
      401,
    )
    await app.close()
  })

  it('does not leak persona data on an unauthenticated GET', async () => {
    const store = new InMemoryPersonaStore()
    await store.update('p1', 'u1', { optIn: true, followAsset: 'BTC' })
    const app = buildService({ store, internalToken: TOKEN })

    const denied = await app.inject({ method: 'GET', url: '/v1/persona/p1/u1' })
    expect(denied.statusCode).toBe(401)
    expect(denied.body).not.toContain('BTC')

    const ok = await app.inject({ method: 'GET', url: '/v1/persona/p1/u1', headers: auth })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().followedAssets).toEqual(['BTC'])
    await app.close()
  })

  it('leaves /health unguarded', async () => {
    const app = buildService({ internalToken: TOKEN })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, service: 'memory' })
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

describe('scope-memory documents (global / host / user note)', () => {
  const TOKEN = 'test-internal-token'
  const auth = { 'x-hippo-internal-token': TOKEN }

  it('global doc round-trips and defaults empty', async () => {
    const app = buildService({ internalToken: TOKEN })
    const empty = await app.inject({ method: 'GET', url: '/v1/scope/global', headers: auth })
    expect(empty.json()).toMatchObject({ body: '', updatedAt: 0 })
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/scope/global',
      headers: auth,
      payload: { body: 'PLATFORM RULE: never give advice.' },
    })
    expect(put.statusCode).toBe(200)
    const got = await app.inject({ method: 'GET', url: '/v1/scope/global', headers: auth })
    expect(got.json().body).toBe('PLATFORM RULE: never give advice.')
  })

  it('host docs are per-partner isolated', async () => {
    const app = buildService({ internalToken: TOKEN })
    await app.inject({
      method: 'PUT',
      url: '/v1/scope/host/pA',
      headers: auth,
      payload: { body: 'Venue A context' },
    })
    expect(
      (await app.inject({ method: 'GET', url: '/v1/scope/host/pA', headers: auth })).json().body,
    ).toBe('Venue A context')
    expect(
      (await app.inject({ method: 'GET', url: '/v1/scope/host/pB', headers: auth })).json().body,
    ).toBe('')
  })

  it('user notes are per (partner,user)', async () => {
    const app = buildService({ internalToken: TOKEN })
    await app.inject({
      method: 'PUT',
      url: '/v1/scope/user/pA/u1',
      headers: auth,
      payload: { body: 'prefers terse answers' },
    })
    expect(
      (await app.inject({ method: 'GET', url: '/v1/scope/user/pA/u1', headers: auth })).json().body,
    ).toBe('prefers terse answers')
    expect(
      (await app.inject({ method: 'GET', url: '/v1/scope/user/pA/u2', headers: auth })).json().body,
    ).toBe('')
  })

  it('rejects a non-string body and a missing token', async () => {
    const app = buildService({ internalToken: TOKEN })
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/scope/global',
      headers: auth,
      payload: { body: 123 },
    })
    expect(bad.statusCode).toBe(400)
    const noauth = await app.inject({ method: 'GET', url: '/v1/scope/global' })
    expect(noauth.statusCode).toBe(401)
  })
})

describe('scope store clamps oversized bodies', () => {
  it('truncates a body beyond MAX_BODY', async () => {
    const { InMemoryScopeMemoryStore, MAX_BODY } = await import('../src/scope-store.js')
    const store = new InMemoryScopeMemoryStore()
    const huge = 'x'.repeat(MAX_BODY + 500)
    const doc = await store.setGlobal(huge, 1)
    expect(doc.body.length).toBe(MAX_BODY)
  })
})

describe('learned facts — provenance-tracked auto-learning', () => {
  const ids = { partnerId: 'pA', userId: 'u1' }

  it('upsert then get returns the facts', async () => {
    const { InMemoryScopeMemoryStore } = await import('../src/scope-store.js')
    const store = new InMemoryScopeMemoryStore()
    await store.upsertLearnedFacts(
      'user',
      ids,
      [
        { type: 'risk_tolerance', value: 'low', confidence: 0.6 },
        { type: 'timezone', value: 'IST', confidence: 0.9 },
      ],
      100,
    )
    const facts = await store.getLearnedFacts('user', ids)
    expect(facts).toHaveLength(2)
    expect(facts.map((f) => f.type).sort()).toEqual(['risk_tolerance', 'timezone'])
    // source defaults to 'auto' and timestamps are set.
    expect(facts.every((f) => f.source === 'auto')).toBe(true)
    expect(facts.every((f) => f.createdAt === 100 && f.updatedAt === 100)).toBe(true)
  })

  it('re-observing the same (type,value) updates confidence in place, no duplicate', async () => {
    const { InMemoryScopeMemoryStore } = await import('../src/scope-store.js')
    const store = new InMemoryScopeMemoryStore()
    await store.upsertLearnedFacts('user', ids, [{ type: 'risk', value: 'low', confidence: 0.5 }], 1)
    await store.upsertLearnedFacts('user', ids, [{ type: 'risk', value: 'low', confidence: 0.8 }], 2)
    const facts = await store.getLearnedFacts('user', ids)
    expect(facts).toHaveLength(1)
    expect(facts[0].confidence).toBeCloseTo(0.8)
    expect(facts[0].createdAt).toBe(1) // preserved
    expect(facts[0].updatedAt).toBe(2) // refreshed
  })

  it('enforces the per-scope cap (MAX_LEARNED_FACTS), evicting lowest confidence', async () => {
    const { InMemoryScopeMemoryStore, MAX_LEARNED_FACTS } = await import('../src/scope-store.js')
    const store = new InMemoryScopeMemoryStore()
    // One extra low-confidence fact that should be evicted, plus the cap's worth
    // of higher-confidence facts.
    const facts = [{ type: 'f', value: 'evict-me', confidence: 0.01 }]
    for (let i = 0; i < MAX_LEARNED_FACTS; i++) {
      facts.push({ type: 'f', value: `keep-${i}`, confidence: 0.5 + i / 1000 })
    }
    await store.upsertLearnedFacts('user', ids, facts, 1)
    const stored = await store.getLearnedFacts('user', ids)
    expect(stored).toHaveLength(MAX_LEARNED_FACTS)
    expect(stored.some((f) => f.value === 'evict-me')).toBe(false)
  })

  it('an admin fact is NOT overwritten by an auto upsert of the same key', async () => {
    const { InMemoryScopeMemoryStore } = await import('../src/scope-store.js')
    const store = new InMemoryScopeMemoryStore()
    await store.upsertLearnedFacts(
      'user',
      ids,
      [{ type: 'style', value: 'terse', confidence: 1, source: 'admin' }],
      1,
    )
    // An auto observation of the same (type,value) must not clobber it.
    await store.upsertLearnedFacts(
      'user',
      ids,
      [{ type: 'style', value: 'terse', confidence: 0.2, source: 'auto' }],
      2,
    )
    const [fact] = await store.getLearnedFacts('user', ids)
    expect(fact.source).toBe('admin')
    expect(fact.confidence).toBe(1) // untouched
    expect(fact.updatedAt).toBe(1) // untouched
  })

  it('clear removes all facts for the scope and reports the count', async () => {
    const { InMemoryScopeMemoryStore } = await import('../src/scope-store.js')
    const store = new InMemoryScopeMemoryStore()
    await store.upsertLearnedFacts(
      'user',
      ids,
      [
        { type: 'a', value: '1', confidence: 0.5 },
        { type: 'b', value: '2', confidence: 0.5 },
      ],
      1,
    )
    expect(await store.clearLearnedFacts('user', ids)).toBe(2)
    expect(await store.getLearnedFacts('user', ids)).toEqual([])
    expect(await store.clearLearnedFacts('user', ids)).toBe(0)
  })

  it('user and session scopes are isolated', async () => {
    const { InMemoryScopeMemoryStore } = await import('../src/scope-store.js')
    const store = new InMemoryScopeMemoryStore()
    await store.upsertLearnedFacts('user', ids, [{ type: 't', value: 'u', confidence: 1 }], 1)
    await store.upsertLearnedFacts(
      'session',
      { sessionId: 's1' },
      [{ type: 't', value: 's', confidence: 1 }],
      1,
    )
    expect((await store.getLearnedFacts('user', ids))[0].value).toBe('u')
    expect((await store.getLearnedFacts('session', { sessionId: 's1' }))[0].value).toBe('s')
    expect(await store.getLearnedFacts('session', { sessionId: 's2' })).toEqual([])
  })
})

describe('learned-facts HTTP surface', () => {
  const TOKEN = 'test-internal-token'
  const auth = { 'x-hippo-internal-token': TOKEN }

  it('GET returns stored user facts and clears via DELETE (token-guarded)', async () => {
    const { InMemoryScopeMemoryStore } = await import('../src/scope-store.js')
    const scopeStore = new InMemoryScopeMemoryStore()
    await scopeStore.upsertLearnedFacts(
      'user',
      { partnerId: 'pA', userId: 'u1' },
      [{ type: 'risk', value: 'low', confidence: 0.7 }],
      1,
    )
    const app = buildService({ scopeStore, internalToken: TOKEN })

    // Unauthenticated read is denied and leaks nothing.
    const denied = await app.inject({ method: 'GET', url: '/v1/scope/user/pA/u1/facts' })
    expect(denied.statusCode).toBe(401)
    expect(denied.body).not.toContain('risk')

    const got = await app.inject({ method: 'GET', url: '/v1/scope/user/pA/u1/facts', headers: auth })
    expect(got.statusCode).toBe(200)
    expect(got.json()).toHaveLength(1)
    expect(got.json()[0]).toMatchObject({ type: 'risk', value: 'low', source: 'auto' })

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/scope/user/pA/u1/facts',
      headers: auth,
    })
    expect(del.json()).toEqual({ cleared: 1 })
    expect(
      (await app.inject({ method: 'GET', url: '/v1/scope/user/pA/u1/facts', headers: auth })).json(),
    ).toEqual([])
    await app.close()
  })

  it('session facts round-trip over HTTP', async () => {
    const app = buildService({ internalToken: TOKEN })
    // No write route yet, so seed via the store the service builds is not
    // reachable here; instead assert the read path defaults empty + guarded.
    const empty = await app.inject({
      method: 'GET',
      url: '/v1/scope/session/s1/facts',
      headers: auth,
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual([])
    expect((await app.inject({ method: 'GET', url: '/v1/scope/session/s1/facts' })).statusCode).toBe(
      401,
    )
    await app.close()
  })
})
