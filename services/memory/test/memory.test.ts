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

  it('round-trips learnOptOut (Phase C opt-out) and preserves it across a clear', async () => {
    const app = buildService({ internalToken: TOKEN })
    // Default persona is opted IN to auto-learning (learnOptOut false).
    const def = await app.inject({ method: 'GET', url: '/v1/persona/p1/u1', headers: auth })
    expect(def.json().learnOptOut).toBe(false)

    // PUT accepts the flag and echoes it back.
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/persona/p1/u1',
      headers: auth,
      payload: { learnOptOut: true },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().learnOptOut).toBe(true)

    // It survives a clear — a consent choice, like optIn (clearing wipes DATA).
    const cleared = await app.inject({
      method: 'POST',
      url: '/v1/persona/p1/u1/clear',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(cleared.json().learnOptOut).toBe(true)

    // A non-boolean value is rejected with 400.
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/persona/p1/u1',
      headers: auth,
      payload: { learnOptOut: 'nope' },
    })
    expect(bad.statusCode).toBe(400)
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

  it('leaves /health unguarded and reports build provenance', async () => {
    const app = buildService({ internalToken: TOKEN })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    // sha/builtAt prove from outside which build is running ("unknown" when
    // the image was not stamped — never a fabricated value).
    expect(res.json()).toMatchObject({
      ok: true,
      service: 'memory',
      sha: expect.any(String),
      builtAt: expect.any(String),
    })
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
    expect(ok.json()).toEqual({ deleted: 1, facts: 0, notes: 0 })
    await app.close()
  })

  it('DELETE /admin/personas also purges the partner’s learned facts and user notes', async () => {
    const { InMemoryScopeMemoryStore } = await import('../src/scope-store.js')
    const store = new InMemoryPersonaStore()
    const scopeStore = new InMemoryScopeMemoryStore()
    await store.update('pA', 'u1', { optIn: true })
    await scopeStore.setUserNote('pA', 'u1', 'prefers terse answers', 1)
    await scopeStore.setUserNote('pB', 'u2', 'unrelated partner', 1)
    await scopeStore.upsertLearnedFacts(
      'user',
      { partnerId: 'pA', userId: 'u1' },
      [
        { type: 'risk', value: 'low', confidence: 0.7 },
        { type: 'style', value: 'terse', confidence: 0.9 },
      ],
      Date.now(),
    )
    const app = buildService({ store, scopeStore, internalToken: 'tok' })

    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/personas?partnerId=pA',
      headers: { 'x-hippo-internal-token': 'tok' },
    })
    expect(res.json()).toEqual({ deleted: 1, facts: 2, notes: 1 })

    // pA holds nothing anymore; pB is untouched.
    expect(await scopeStore.getLearnedFacts('user', { partnerId: 'pA', userId: 'u1' })).toEqual([])
    expect((await scopeStore.getUserNote('pA', 'u1')).body).toBe('')
    expect((await scopeStore.getUserNote('pB', 'u2')).body).toBe('unrelated partner')
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

  it('DELETE removes a user note (token-guarded), idempotently', async () => {
    const app = buildService({ internalToken: TOKEN })
    await app.inject({
      method: 'PUT',
      url: '/v1/scope/user/pA/u1',
      headers: auth,
      payload: { body: 'prefers terse answers' },
    })

    // Unauthenticated delete is denied — the note survives.
    expect((await app.inject({ method: 'DELETE', url: '/v1/scope/user/pA/u1' })).statusCode).toBe(
      401,
    )
    expect(
      (await app.inject({ method: 'GET', url: '/v1/scope/user/pA/u1', headers: auth })).json().body,
    ).toBe('prefers terse answers')

    const del = await app.inject({ method: 'DELETE', url: '/v1/scope/user/pA/u1', headers: auth })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ deleted: true })
    expect(
      (await app.inject({ method: 'GET', url: '/v1/scope/user/pA/u1', headers: auth })).json(),
    ).toMatchObject({ body: '', updatedAt: 0 })
    // Second delete is a no-op, never an error.
    const again = await app.inject({ method: 'DELETE', url: '/v1/scope/user/pA/u1', headers: auth })
    expect(again.json()).toEqual({ deleted: false })
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

/**
 * The scope store's header promises "two backings, one surface": an in-memory
 * Map for dev/tests and Postgres in production, behaving identically. Every
 * test in this repo drives the in-memory twin, so a divergence in the Postgres
 * backing is structurally invisible — which is exactly how `putComposed` came
 * to clamp the composed snapshot to MAX_BODY on one side and store it whole on
 * the other.
 *
 * This suite drives EVERY write method on the surface through BOTH backings and
 * asserts they persist the same thing. The Postgres side runs against a stub
 * pool that captures the SQL and its bound parameters (no new dependency, and
 * the captured params are the actual bytes the column would receive).
 */
describe('scope-store parity — one surface, two backings', () => {
  type Captured = { sql: string; params: readonly unknown[] }

  /** Pulls the value bound to `table`.`column` out of a captured INSERT, by
   * mapping the statement's column list onto its `$n` placeholders. */
  function insertedValues(calls: readonly Captured[], table: string, column: string): string[] {
    const out: string[] = []
    for (const { sql, params } of calls) {
      const m = /INSERT INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/is.exec(sql)
      if (!m || m[1] !== table) continue
      const columns = m[2].split(',').map((c) => c.trim())
      const placeholders = m[3].split(',').map((p) => p.trim())
      const at = columns.indexOf(column)
      if (at === -1) continue
      const n = Number(placeholders[at]?.replace('$', ''))
      out.push(String(params[n - 1]))
    }
    return out
  }

  /** Statements the store issued against `table`, whatever the verb. */
  function statementsFor(calls: readonly Captured[], table: string): Captured[] {
    return calls.filter((c) => c.sql.includes(table))
  }

  /** Hand-rolled stub pg pool: records every statement + params and answers
   * reads with an empty result set. Enough to observe what the Postgres backing
   * WRITES, which is the thing that drifted. */
  function stubPool() {
    const calls: Captured[] = []
    const query = async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params })
      return { rows: [] as Record<string, unknown>[], rowCount: 0 }
    }
    const pool = {
      query,
      connect: async () => ({ query, release: () => {} }),
    }
    return { calls, pool }
  }

  async function bothBackings() {
    const { InMemoryScopeMemoryStore, PostgresScopeMemoryStore } = await import(
      '../src/scope-store.js'
    )
    const { calls, pool } = stubPool()
    return {
      memory: new InMemoryScopeMemoryStore(),
      // The store only ever calls .query/.connect; the stub satisfies both.
      postgres: new PostgresScopeMemoryStore(pool as unknown as never),
      calls,
    }
  }

  const NOW = 1_700_000_000_000
  const IDS = { partnerId: 'pA', userId: 'u1' }

  // Every write on ScopeMemoryStore that persists a string, with how to read
  // that string back out of each backing. Adding a write to the interface
  // without adding it here fails the exhaustiveness test below.
  type ParityCase = {
    method: string
    /** Oversized on purpose: parity only matters where a clamp could apply. */
    write: (store: {
      setGlobal: (b: string, n: number) => Promise<unknown>
      setHost: (p: string, b: string, n: number) => Promise<unknown>
      setUserNote: (p: string, u: string, b: string, n: number) => Promise<unknown>
      putComposed: (s: string, p: string, u: string, c: string, n: number) => Promise<unknown>
      // biome-ignore lint/suspicious/noExplicitAny: structural call across both backings
      upsertLearnedFacts: (...args: any[]) => Promise<unknown>
    }) => Promise<unknown>
    /** What the in-memory twin ended up holding. */
    // biome-ignore lint/suspicious/noExplicitAny: reads differ per method
    readMemory: (store: any) => Promise<string[]>
    /** What the Postgres backing bound into its INSERT. */
    readPostgres: (calls: readonly Captured[]) => string[]
  }

  const OVERSIZED = 8_000 * 3

  const CASES: ParityCase[] = [
    {
      method: 'setGlobal',
      write: (s) => s.setGlobal('g'.repeat(OVERSIZED), NOW),
      readMemory: async (s) => [(await s.getGlobal()).body],
      readPostgres: (c) => insertedValues(c, 'memory_global', 'body'),
    },
    {
      method: 'setHost',
      write: (s) => s.setHost('pA', 'h'.repeat(OVERSIZED), NOW),
      readMemory: async (s) => [(await s.getHost('pA')).body],
      readPostgres: (c) => insertedValues(c, 'memory_host', 'body'),
    },
    {
      method: 'setUserNote',
      write: (s) => s.setUserNote('pA', 'u1', 'n'.repeat(OVERSIZED), NOW),
      readMemory: async (s) => [(await s.getUserNote('pA', 'u1')).body],
      readPostgres: (c) => insertedValues(c, 'memory_user_notes', 'body'),
    },
    {
      method: 'putComposed',
      // The regression that started this: a real composed block is four layers
      // deep, so it routinely exceeds a single layer's MAX_BODY.
      write: (s) => s.putComposed('s1', 'pA', 'u1', 'c'.repeat(OVERSIZED), NOW),
      readMemory: async (s) => [(await s.getSession('s1')).composed],
      readPostgres: (c) => insertedValues(c, 'memory_session', 'composed'),
    },
    {
      method: 'upsertLearnedFacts',
      write: (s) =>
        s.upsertLearnedFacts(
          'user',
          IDS,
          [{ type: 't', value: 'v'.repeat(OVERSIZED), confidence: 1 }],
          NOW,
        ),
      readMemory: async (s) =>
        (await s.getLearnedFacts('user', IDS, NOW)).map((f: { value: string }) => f.value),
      readPostgres: (c) => insertedValues(c, 'memory_learned_facts', 'fact_value'),
    },
  ]

  it('the parity table covers every write method on the surface', async () => {
    const { InMemoryScopeMemoryStore, PostgresScopeMemoryStore } = await import(
      '../src/scope-store.js'
    )
    // The Postgres class carries no private helpers, so its prototype IS the
    // surface. Both backings must implement all of it, and every write must be
    // covered here — a new one shows up as a failure, not as silent drift.
    const surface = Object.getOwnPropertyNames(PostgresScopeMemoryStore.prototype)
      .filter((n) => n !== 'constructor')
      .sort()
    const reads = ['getGlobal', 'getHost', 'getLearnedFacts', 'getSession', 'getUserNote']
    // The deletes persist no string; each has its own parity test below.
    const writes = [
      ...CASES.map((c) => c.method),
      'clearLearnedFacts',
      'deleteLearnedFactsByPartner',
      'deleteUserNote',
      'deleteUserNotesByPartner',
    ]
    expect(surface).toEqual([...reads, ...writes].sort())

    const twin = new InMemoryScopeMemoryStore() as unknown as Record<string, unknown>
    for (const method of surface) expect(typeof twin[method]).toBe('function')
  })

  it.each(
    CASES.map((c) => [c.method, c] as const),
  )('%s persists an identical payload in both backings', async (_name, testCase) => {
    const { memory, postgres, calls } = await bothBackings()
    await testCase.write(memory)
    await testCase.write(postgres as unknown as Parameters<typeof testCase.write>[0])

    const stored = await testCase.readMemory(memory)
    const sent = testCase.readPostgres(calls)
    // Length first — that is the invariant that actually broke.
    expect(sent.map((v) => v.length)).toEqual(stored.map((v) => v.length))
    expect(sent).toEqual(stored)
  })

  it('clearLearnedFacts targets the same scope keys in both backings', async () => {
    const { memory, postgres, calls } = await bothBackings()
    await memory.upsertLearnedFacts('user', IDS, [{ type: 't', value: 'v', confidence: 1 }], NOW)

    expect(await memory.clearLearnedFacts('user', IDS)).toBe(1)
    expect(await memory.getLearnedFacts('user', IDS, NOW)).toEqual([])

    await postgres.clearLearnedFacts('user', IDS)
    const [del] = statementsFor(calls, 'memory_learned_facts')
    expect(del.sql).toMatch(/^DELETE FROM memory_learned_facts/)
    expect(del.params).toEqual([IDS.partnerId, IDS.userId])

    // Session scope keys on the session id alone, same on both sides.
    const session = await bothBackings()
    await session.memory.upsertLearnedFacts(
      'session',
      { sessionId: 's1' },
      [{ type: 't', value: 'v', confidence: 1 }],
      NOW,
    )
    expect(await session.memory.clearLearnedFacts('session', { sessionId: 's1' })).toBe(1)
    await session.postgres.clearLearnedFacts('session', { sessionId: 's1' })
    const [sessionDel] = statementsFor(session.calls, 'memory_learned_facts')
    expect(sessionDel.params).toEqual(['s1'])
  })

  it('deleteUserNote targets the same (partner,user) keys in both backings', async () => {
    const { memory, postgres, calls } = await bothBackings()
    await memory.setUserNote('pA', 'u1', 'note', NOW)
    expect(await memory.deleteUserNote('pA', 'u1')).toBe(true)
    expect((await memory.getUserNote('pA', 'u1')).body).toBe('')
    expect(await memory.deleteUserNote('pA', 'u1')).toBe(false) // idempotent

    await postgres.deleteUserNote('pA', 'u1')
    const [del] = statementsFor(calls, 'memory_user_notes')
    expect(del.sql).toMatch(/^DELETE FROM memory_user_notes/)
    expect(del.params).toEqual(['pA', 'u1'])
  })

  it('deleteUserNotesByPartner purges only that partner in both backings', async () => {
    const { memory, postgres, calls } = await bothBackings()
    await memory.setUserNote('pA', 'u1', 'a', NOW)
    await memory.setUserNote('pA', 'u2', 'b', NOW)
    await memory.setUserNote('pB', 'u3', 'keep', NOW)
    expect(await memory.deleteUserNotesByPartner('pA')).toBe(2)
    expect((await memory.getUserNote('pB', 'u3')).body).toBe('keep')

    await postgres.deleteUserNotesByPartner('pA')
    const [del] = statementsFor(calls, 'memory_user_notes')
    expect(del.sql).toMatch(/^DELETE FROM memory_user_notes/)
    expect(del.params).toEqual(['pA'])
  })

  it('deleteLearnedFactsByPartner reaches user-scope facts only, in both backings', async () => {
    const { memory, postgres, calls } = await bothBackings()
    await memory.upsertLearnedFacts('user', IDS, [{ type: 't', value: 'v', confidence: 1 }], NOW)
    await memory.upsertLearnedFacts(
      'user',
      { partnerId: 'pA', userId: 'u2' },
      [{ type: 't', value: 'w', confidence: 1 }],
      NOW,
    )
    // Session facts key on the session id alone — out of a partner purge's
    // reach on both sides (the Postgres WHERE matches scope='user').
    await memory.upsertLearnedFacts(
      'session',
      { sessionId: 's1' },
      [{ type: 't', value: 's', confidence: 1 }],
      NOW,
    )
    expect(await memory.deleteLearnedFactsByPartner('pA')).toBe(2)
    expect(await memory.getLearnedFacts('user', IDS, NOW)).toEqual([])
    expect(await memory.getLearnedFacts('session', { sessionId: 's1' }, NOW)).toHaveLength(1)

    await postgres.deleteLearnedFactsByPartner('pA')
    const [del] = statementsFor(calls, 'memory_learned_facts')
    expect(del.sql).toMatch(/^DELETE FROM memory_learned_facts WHERE scope = 'user'/)
    expect(del.params).toEqual(['pA'])
  })

  it('keeps the composed snapshot whole past MAX_BODY — it is an audit record', async () => {
    const { MAX_BODY, MAX_COMPOSED } = await import('../src/scope-store.js')
    const { memory, postgres, calls } = await bothBackings()
    // A four-layer composed block: what composeMemory actually produces at the
    // limit. Clamping this to MAX_BODY dropped the TAIL, i.e. the user and
    // session layers — precisely what an operator opens the inspector to read.
    const composed = ['PLATFORM', 'VENUE', 'USER', 'SESSION']
      .map((label) => `[${label}]\n${label[0].repeat(MAX_BODY)}`)
      .join('\n\n')
    expect(composed.length).toBeGreaterThan(MAX_BODY)
    expect(composed.length).toBeLessThanOrEqual(MAX_COMPOSED)

    await memory.putComposed('s1', 'pA', 'u1', composed, NOW)
    await postgres.putComposed('s1', 'pA', 'u1', composed, NOW)

    expect((await memory.getSession('s1')).composed).toBe(composed)
    expect(insertedValues(calls, 'memory_session', 'composed')).toEqual([composed])
    // The tail — the layers the old clamp ate — is intact.
    expect((await memory.getSession('s1')).composed).toContain('[SESSION]')
  })

  it('clamps the composed snapshot at MAX_COMPOSED in both backings', async () => {
    const { MAX_COMPOSED } = await import('../src/scope-store.js')
    const { memory, postgres, calls } = await bothBackings()
    const huge = 'z'.repeat(MAX_COMPOSED + 500)
    await memory.putComposed('s1', 'pA', 'u1', huge, NOW)
    await postgres.putComposed('s1', 'pA', 'u1', huge, NOW)

    expect((await memory.getSession('s1')).composed.length).toBe(MAX_COMPOSED)
    expect(insertedValues(calls, 'memory_session', 'composed')[0].length).toBe(MAX_COMPOSED)
  })

  it('still clamps prose bodies at MAX_BODY in both backings', async () => {
    const { MAX_BODY } = await import('../src/scope-store.js')
    const { memory, postgres, calls } = await bothBackings()
    const huge = 'x'.repeat(MAX_BODY + 500)

    expect((await memory.setGlobal(huge, NOW)).body.length).toBe(MAX_BODY)
    expect((await memory.setHost('pA', huge, NOW)).body.length).toBe(MAX_BODY)
    expect((await memory.setUserNote('pA', 'u1', huge, NOW)).body.length).toBe(MAX_BODY)

    await postgres.setGlobal(huge, NOW)
    await postgres.setHost('pA', huge, NOW)
    await postgres.setUserNote('pA', 'u1', huge, NOW)
    for (const [table] of [['memory_global'], ['memory_host'], ['memory_user_notes']]) {
      expect(insertedValues(calls, table, 'body')[0].length).toBe(MAX_BODY)
    }
  })

  it('reads learned facts back against the same `now` the upsert wrote with', async () => {
    const { LEARNED_FACT_TTL_MS } = await import('../src/scope-store.js')
    const { postgres, calls } = await bothBackings()
    // The in-memory twin filters its return with the injected `now`; the
    // Postgres backing used to fall through to the wall clock, so a write at an
    // older timestamp came back empty. The read-back's TTL cutoff pins it.
    const past = Date.now() - LEARNED_FACT_TTL_MS * 2
    await postgres.upsertLearnedFacts('user', IDS, [{ type: 't', value: 'v', confidence: 1 }], past)
    const select = statementsFor(calls, 'memory_learned_facts').find((c) =>
      c.sql.startsWith('SELECT'),
    )
    expect(select?.params).toEqual([IDS.partnerId, IDS.userId, past - LEARNED_FACT_TTL_MS])
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
    const facts = await store.getLearnedFacts('user', ids, 100)
    expect(facts).toHaveLength(2)
    expect(facts.map((f) => f.type).sort()).toEqual(['risk_tolerance', 'timezone'])
    // source defaults to 'auto' and timestamps are set.
    expect(facts.every((f) => f.source === 'auto')).toBe(true)
    expect(facts.every((f) => f.createdAt === 100 && f.updatedAt === 100)).toBe(true)
  })

  it('re-observing the same (type,value) updates confidence in place, no duplicate', async () => {
    const { InMemoryScopeMemoryStore } = await import('../src/scope-store.js')
    const store = new InMemoryScopeMemoryStore()
    await store.upsertLearnedFacts(
      'user',
      ids,
      [{ type: 'risk', value: 'low', confidence: 0.5 }],
      1,
    )
    await store.upsertLearnedFacts(
      'user',
      ids,
      [{ type: 'risk', value: 'low', confidence: 0.8 }],
      2,
    )
    const facts = await store.getLearnedFacts('user', ids, 2)
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
    const stored = await store.getLearnedFacts('user', ids, 1)
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

  it('decay: a fact not re-observed within the TTL ages out of reads (Phase D)', async () => {
    const { InMemoryScopeMemoryStore, LEARNED_FACT_TTL_MS } = await import('../src/scope-store.js')
    const store = new InMemoryScopeMemoryStore()
    // Observed once, longer ago than the TTL, and never again.
    const longAgo = Date.now() - LEARNED_FACT_TTL_MS - 60_000
    await store.upsertLearnedFacts(
      'user',
      ids,
      [{ type: 'stale', value: 's', confidence: 0.9 }],
      longAgo,
    )
    // getLearnedFacts reads against Date.now(), so the stale fact is past TTL.
    expect(await store.getLearnedFacts('user', ids)).toEqual([])

    // A freshly observed fact IS returned, and that upsert opportunistically
    // pruned the stale one for good.
    await store.upsertLearnedFacts(
      'user',
      ids,
      [{ type: 'fresh', value: 'f', confidence: 0.9 }],
      Date.now(),
    )
    expect((await store.getLearnedFacts('user', ids)).map((f) => f.type)).toEqual(['fresh'])
  })

  it('decay: admin-curated facts never age out (exempt from the TTL)', async () => {
    const { InMemoryScopeMemoryStore, LEARNED_FACT_TTL_MS } = await import('../src/scope-store.js')
    const store = new InMemoryScopeMemoryStore()
    const longAgo = Date.now() - LEARNED_FACT_TTL_MS - 60_000
    await store.upsertLearnedFacts(
      'user',
      ids,
      [{ type: 'style', value: 'terse', confidence: 1, source: 'admin' }],
      longAgo,
    )
    const facts = await store.getLearnedFacts('user', ids)
    expect(facts).toHaveLength(1)
    expect(facts[0].source).toBe('admin')
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
    expect((await store.getLearnedFacts('user', ids, 1))[0].value).toBe('u')
    expect((await store.getLearnedFacts('session', { sessionId: 's1' }, 1))[0].value).toBe('s')
    expect(await store.getLearnedFacts('session', { sessionId: 's2' }, 1)).toEqual([])
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
      Date.now(), // fresh: the HTTP read applies the TTL against the wall clock
    )
    const app = buildService({ scopeStore, internalToken: TOKEN })

    // Unauthenticated read is denied and leaks nothing.
    const denied = await app.inject({ method: 'GET', url: '/v1/scope/user/pA/u1/facts' })
    expect(denied.statusCode).toBe(401)
    expect(denied.body).not.toContain('risk')

    const got = await app.inject({
      method: 'GET',
      url: '/v1/scope/user/pA/u1/facts',
      headers: auth,
    })
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
      (
        await app.inject({ method: 'GET', url: '/v1/scope/user/pA/u1/facts', headers: auth })
      ).json(),
    ).toEqual([])
    await app.close()
  })

  it('session facts round-trip over HTTP', async () => {
    const app = buildService({ internalToken: TOKEN })
    // Read path defaults to empty + is token-guarded (write round-trip is
    // covered by the PUT test below).
    const empty = await app.inject({
      method: 'GET',
      url: '/v1/scope/session/s1/facts',
      headers: auth,
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual([])
    expect(
      (await app.inject({ method: 'GET', url: '/v1/scope/session/s1/facts' })).statusCode,
    ).toBe(401)
    await app.close()
  })

  it('PUT upserts facts (token-guarded) and GET reads them back — user + session', async () => {
    const app = buildService({ internalToken: TOKEN })

    // Unauthenticated write is denied.
    const denied = await app.inject({
      method: 'PUT',
      url: '/v1/scope/session/s1/facts',
      payload: { facts: [{ type: 'followed_asset', value: 'BTC', confidence: 0.9 }] },
    })
    expect(denied.statusCode).toBe(401)

    // Authenticated session upsert round-trips.
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/scope/session/s1/facts',
      headers: auth,
      payload: {
        facts: [
          { type: 'followed_asset', value: 'BTC', confidence: 0.9 },
          { type: 'answer_style', value: 'concise', confidence: 0.8 },
        ],
      },
    })
    expect(put.statusCode).toBe(200)
    const got = await app.inject({
      method: 'GET',
      url: '/v1/scope/session/s1/facts',
      headers: auth,
    })
    expect(
      got
        .json()
        .map((f: { value: string }) => f.value)
        .sort(),
    ).toEqual(['BTC', 'concise'])

    // Malformed entries are dropped, not fatal (fire-and-forget must not 500).
    const junk = await app.inject({
      method: 'PUT',
      url: '/v1/scope/user/pA/u1/facts',
      headers: auth,
      payload: { facts: [{ type: 'x' }, 42, { type: 'ok', value: 'v', confidence: 0.5 }] },
    })
    expect(junk.statusCode).toBe(200)
    expect(junk.json()).toHaveLength(1)
    await app.close()
  })
})
