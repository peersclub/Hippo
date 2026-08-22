/**
 * Deletion surface — GDPR purge (deleteByUser) and partner offboarding
 * (deleteByPartner) across the user-keyed stores, held to the repo's parity
 * discipline: every test in this package drives the in-memory twin, so a
 * divergence in the Postgres backing is structurally invisible unless the two
 * are compared. Same approach as the memory service's scope-store parity
 * suite: the Postgres side runs against a stub pool that captures the SQL and
 * its bound parameters, and each delete must target exactly the keys the
 * in-memory twin deleted by.
 */
import { describe, expect, it } from 'vitest'
import {
  type Alert,
  InMemoryAlertStore,
  InMemoryIntentSignalStore,
  InMemoryUploadedFileStore,
  InMemoryUserIdentityStore,
  type IntentSignal,
  PostgresAlertStore,
  PostgresIntentSignalStore,
  PostgresUploadedFileStore,
  PostgresUserIdentityStore,
  type UploadedFile,
} from '../src/index.js'

type Captured = { sql: string; params: readonly unknown[] }

/** Hand-rolled stub pg pool: records every statement + params and answers with
 * an empty result set (rowCount 0). Enough to observe WHERE keys and verbs. */
function stubPool() {
  const calls: Captured[] = []
  const pool = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params })
      return { rows: [] as Record<string, unknown>[], rowCount: 0 }
    },
  }
  return { calls, pool: pool as unknown as never }
}

const deletesAgainst = (calls: readonly Captured[], table: string) =>
  calls.filter((c) => /^DELETE FROM\s+(\w+)/.exec(c.sql.trim())?.[1] === table)

describe('backing parity — both classes expose the same surface', () => {
  // The Postgres classes carry no private helpers, so their prototypes ARE the
  // interface (the in-memory twins keep private helpers like armedCount, hence
  // one-directional): a method added to the Postgres backing but missing from
  // the in-memory twin shows up here as a failure, not silent drift. The
  // deletes below then pin the reverse direction by driving both.
  it.each([
    ['IntentSignalStore', InMemoryIntentSignalStore, PostgresIntentSignalStore],
    ['UploadedFileStore', InMemoryUploadedFileStore, PostgresUploadedFileStore],
    ['AlertStore', InMemoryAlertStore, PostgresAlertStore],
    ['UserIdentityStore', InMemoryUserIdentityStore, PostgresUserIdentityStore],
  ])('%s', (_name, mem, pg) => {
    const surface = Object.getOwnPropertyNames(pg.prototype).filter((n) => n !== 'constructor')
    expect(surface.length).toBeGreaterThan(0)
    for (const method of surface) {
      expect(
        typeof (mem.prototype as Record<string, unknown>)[method],
        `${_name}: in-memory twin is missing ${method}`,
      ).toBe('function')
    }
  })
})

describe('IntentSignalStore deletion (GDPR: rows carry raw trader text)', () => {
  const signal = (extra: Partial<IntentSignal> = {}): IntentSignal => ({
    id: `is_${Math.random().toString(36).slice(2, 10)}`,
    partnerId: 'pA',
    userKey: 'user-1',
    signal: 'rephrase',
    originalText: 'why is btc down',
    createdAt: Date.now(),
    ...extra,
  })

  it('deleteByUser erases only that (partner, user) and reports the count', async () => {
    const store = new InMemoryIntentSignalStore()
    await store.record(signal({ id: 'a' }))
    await store.record(signal({ id: 'b' }))
    await store.record(signal({ id: 'other-user', userKey: 'user-2' }))
    await store.record(signal({ id: 'other-partner', partnerId: 'pB' }))

    expect(await store.deleteByUser('pA', 'user-1')).toBe(2)
    expect((await store.list({ partnerId: 'pA' })).map((s) => s.id)).toEqual(['other-user'])
    expect(await store.list({ partnerId: 'pB' })).toHaveLength(1)
    expect(await store.deleteByUser('pA', 'user-1')).toBe(0) // idempotent
  })

  it('deleteByPartner erases every signal the partner holds, nothing else', async () => {
    const store = new InMemoryIntentSignalStore()
    await store.record(signal({ id: 'a' }))
    await store.record(signal({ id: 'b', userKey: 'user-2' }))
    await store.record(signal({ id: 'keep', partnerId: 'pB' }))

    expect(await store.deleteByPartner('pA')).toBe(2)
    expect((await store.summary('pA')).total).toBe(0)
    expect((await store.summary('pB')).total).toBe(1)
    expect(await store.deleteByPartner('pA')).toBe(0)
  })

  it('the Postgres backing deletes by the same keys', async () => {
    const { calls, pool } = stubPool()
    const store = new PostgresIntentSignalStore(pool)
    expect(await store.deleteByUser('pA', 'user-1')).toBe(0)
    expect(await store.deleteByPartner('pA')).toBe(0)
    const [byUser, byPartner] = deletesAgainst(calls, 'intent_signals')
    expect(byUser.params).toEqual(['pA', 'user-1'])
    expect(byPartner.params).toEqual(['pA'])
  })
})

describe('UploadedFileStore deletion (GDPR: filenames + excerpts are personal)', () => {
  const file = (extra: Partial<UploadedFile> = {}): UploadedFile => ({
    partnerId: 'pA',
    fileId: `u_${Math.random().toString(36).slice(2, 10)}`,
    userKey: 'sub_a',
    name: 'holdings.csv',
    sizeBytes: 1024,
    sizeDisplay: '1 KB',
    mime: 'text/csv',
    kind: 'csv',
    status: 'analyzing',
    createdAt: 1000,
    ...extra,
  })

  it('deleteByUser erases only that (partner, userKey) and reports the count', async () => {
    const store = new InMemoryUploadedFileStore()
    await store.insert(file({ fileId: 'u_1' }))
    await store.insert(file({ fileId: 'u_2' }))
    await store.insert(file({ fileId: 'u_3', userKey: 'id:victor' }))
    await store.insert(file({ fileId: 'u_4', partnerId: 'pB' }))

    expect(await store.deleteByUser('pA', 'sub_a')).toBe(2)
    expect(await store.listByUser('pA', 'sub_a')).toEqual([])
    expect(await store.listByUser('pA', 'id:victor')).toHaveLength(1)
    expect(await store.listByUser('pB', 'sub_a')).toHaveLength(1)
    expect(await store.deleteByUser('pA', 'sub_a')).toBe(0) // idempotent
  })

  it('the Postgres backing deletes by the same keys', async () => {
    const { calls, pool } = stubPool()
    const store = new PostgresUploadedFileStore(pool)
    expect(await store.deleteByUser('pA', 'sub_a')).toBe(0)
    const [byUser] = deletesAgainst(calls, 'uploaded_files')
    expect(byUser.params).toEqual(['pA', 'sub_a'])
  })
})

describe('AlertStore deletion (hard delete — distinct from the cancel state-flip)', () => {
  const alert = (extra: Partial<Alert> = {}): Alert => ({
    id: `al_${Math.random().toString(36).slice(2, 10)}`,
    partnerId: 'pA',
    userKey: 'user-1',
    symbol: 'BTC/USDT',
    condition: 'above',
    price: 70_000,
    state: 'armed',
    createdAt: Date.now(),
    delivered: false,
    ...extra,
  })

  it('deleteByUser removes rows in EVERY state, only for that (partner, user)', async () => {
    const store = new InMemoryAlertStore()
    await store.create(alert({ id: 'armed' }))
    await store.create(alert({ id: 'was-armed' }))
    await store.markTriggered('was-armed')
    await store.create(alert({ id: 'cancelled-one' }))
    await store.cancel('cancelled-one', 'pA', 'user-1')
    await store.create(alert({ id: 'other-user', userKey: 'user-2' }))
    await store.create(alert({ id: 'other-partner', partnerId: 'pB' }))

    // Cancel keeps the row (state flip); delete removes it — 3 rows, 3 states.
    expect(await store.deleteByUser('pA', 'user-1')).toBe(3)
    expect(await store.listByUser('pA', 'user-1')).toEqual([])
    expect(await store.listByUser('pA', 'user-2')).toHaveLength(1)
    expect(await store.listByUser('pB', 'user-1')).toHaveLength(1)
    expect(await store.deleteByUser('pA', 'user-1')).toBe(0) // idempotent
  })

  it('the Postgres backing deletes by the same keys', async () => {
    const { calls, pool } = stubPool()
    const store = new PostgresAlertStore(pool)
    expect(await store.deleteByUser('pA', 'user-1')).toBe(0)
    const [byUser] = deletesAgainst(calls, 'alerts')
    expect(byUser.params).toEqual(['pA', 'user-1'])
  })
})

describe('UserIdentityStore deletion (identity + every link pointing at it)', () => {
  it('deleteByUser erases the identity AND its sub-links, counting both', async () => {
    const store = new InMemoryUserIdentityStore()
    await store.create('pA', 'Victor', 'salt:key')
    await store.link('pA', 'sub-1', 'victor')
    await store.link('pA', 'sub-2', 'victor')
    await store.create('pA', 'Other', 'salt:key')
    await store.link('pA', 'sub-3', 'other')
    await store.create('pB', 'Victor', 'salt:key') // same name, other partner

    expect(await store.deleteByUser('pA', 'victor')).toBe(3) // identity + 2 links
    expect(await store.get('pA', 'victor')).toBeUndefined()
    // No browser can auto-restore the erased identity...
    expect(await store.linkedIdentity('pA', 'sub-1')).toBeUndefined()
    expect(await store.linkedIdentity('pA', 'sub-2')).toBeUndefined()
    // ...while the other identity, its link, and the other partner survive.
    expect((await store.linkedIdentity('pA', 'sub-3'))?.usernameLower).toBe('other')
    expect(await store.get('pB', 'victor')).toBeDefined()
    expect(await store.deleteByUser('pA', 'victor')).toBe(0) // idempotent
  })

  it('the Postgres backing deletes links then the identity, by the same keys', async () => {
    const { calls, pool } = stubPool()
    const store = new PostgresUserIdentityStore(pool)
    expect(await store.deleteByUser('pA', 'victor')).toBe(0)
    const [links] = deletesAgainst(calls, 'user_identity_links')
    const [identity] = deletesAgainst(calls, 'user_identities')
    expect(links.params).toEqual(['pA', 'victor'])
    expect(identity.params).toEqual(['pA', 'victor'])
    // Links go first, so a failure between the two statements never leaves a
    // link pointing at a deleted identity.
    expect(calls.indexOf(links)).toBeLessThan(calls.indexOf(identity))
  })
})
