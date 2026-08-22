import { describe, expect, it } from 'vitest'
import {
  devPartner,
  InMemoryAuditStore,
  InMemoryHostVenueStateStore,
  InMemoryOperatorStore,
  InMemoryPartnerStore,
  InMemoryPlanStore,
  InMemorySeamAuditStore,
  InMemoryUploadedFileStore,
  InMemoryUserStore,
  type UploadedFile,
} from '../src/index.js'
import { signJwtHS256, verifyJwtHS256 } from '../src/jwt.js'

const WELL_KNOWN_DEV_SECRET = 'koinbx-dev-secret-not-for-production'

describe('InMemoryPartnerStore', () => {
  it('seeds the koinbx-dev partner for dev/tests', async () => {
    const store = new InMemoryPartnerStore()
    const byKey = await store.getByKey('pk_demo')
    expect(byKey?.partnerId).toBe('koinbx-dev')
    expect(byKey?.status).toBe('active')
    // NODE_ENV=test → dev secret is allowed, so local dev keeps working.
    expect(byKey?.jwtSecret).toBe(WELL_KNOWN_DEV_SECRET)
  })

  it('creates, updates, suspends and assigns plans', async () => {
    const store = new InMemoryPartnerStore([])
    await store.create({
      partnerId: 'ex1',
      partnerKey: 'pk_ex1',
      jwtSecret: 's',
      venueName: 'Ex One',
      locales: ['en'],
      suggestedQueries: [],
    })
    expect((await store.get('ex1'))?.venueName).toBe('Ex One')

    await store.update('ex1', { venueName: 'Exchange One' })
    expect((await store.get('ex1'))?.venueName).toBe('Exchange One')

    await store.setStatus('ex1', 'suspended')
    expect((await store.get('ex1'))?.status).toBe('suspended')

    await store.assignPlan('ex1', 'plan-pilot')
    expect((await store.get('ex1'))?.planId).toBe('plan-pilot')
  })

  it('rejects duplicate ids and keys', async () => {
    const store = new InMemoryPartnerStore([])
    const base = {
      partnerId: 'dup',
      partnerKey: 'pk_dup',
      jwtSecret: 's',
      venueName: 'V',
      locales: [],
      suggestedQueries: [],
    }
    await store.create(base)
    await expect(store.create(base)).rejects.toThrow('already exists')
    await expect(store.create({ ...base, partnerId: 'other' })).rejects.toThrow('already in use')
  })
})

describe('devPartner jwtSecret guard', () => {
  const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
    const keys = ['HIPPO_DEV', 'NODE_ENV', 'KOINBX_DEV_JWT_SECRET']
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    try {
      for (const k of keys) {
        if (env[k] === undefined) delete process.env[k]
        else process.env[k] = env[k]
      }
      fn()
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  }

  it('never ships the well-known secret in a prod configuration', () => {
    // No explicit secret, not dev, not test → random ephemeral secret instead.
    withEnv({ HIPPO_DEV: undefined, NODE_ENV: undefined, KOINBX_DEV_JWT_SECRET: undefined }, () => {
      const p = devPartner()
      expect(p.jwtSecret).not.toBe(WELL_KNOWN_DEV_SECRET)
      expect(p.jwtSecret.length).toBeGreaterThanOrEqual(32)
    })
  })

  it('honors KOINBX_DEV_JWT_SECRET when explicitly provided', () => {
    withEnv({ KOINBX_DEV_JWT_SECRET: 'explicit-secret' }, () => {
      expect(devPartner().jwtSecret).toBe('explicit-secret')
    })
  })

  it('uses the well-known secret only when dev mode is opted in', () => {
    withEnv({ HIPPO_DEV: '1', NODE_ENV: undefined, KOINBX_DEV_JWT_SECRET: undefined }, () => {
      expect(devPartner().jwtSecret).toBe(WELL_KNOWN_DEV_SECRET)
    })
  })
})

describe('InMemoryPlanStore', () => {
  it('CRUDs plans and blocks delete while assigned', async () => {
    let assigned = false
    const store = new InMemoryPlanStore(async () => assigned)
    await store.create({
      planId: 'pilot',
      name: 'Pilot',
      tier: 'pilot',
      mauQuota: 1000,
      priceMonthlyUsd: 500,
      entitlements: { streaming: true },
    })
    await store.update('pilot', { mauQuota: 2000 })
    expect((await store.get('pilot'))?.mauQuota).toBe(2000)

    assigned = true
    await expect(store.delete('pilot')).rejects.toThrow('assigned')
    assigned = false
    expect(await store.delete('pilot')).toBe(true)
  })
})

describe('InMemoryUserStore', () => {
  it('upserts first/last seen and pages by partner, most-recent first', async () => {
    const store = new InMemoryUserStore()
    await store.upsertSeen('p1', 'u1', 1000)
    await store.upsertSeen('p1', 'u2', 2000)
    await store.upsertSeen('p2', 'u3', 3000)
    await store.upsertSeen('p1', 'u1', 4000) // returning user

    const u1 = await store.get('p1', 'u1')
    expect(u1?.firstSeen).toBe(1000)
    expect(u1?.lastSeen).toBe(4000)

    const page = await store.list({ partnerId: 'p1' })
    expect(page.total).toBe(2)
    expect(page.rows.map((u) => u.userId)).toEqual(['u1', 'u2'])

    const all = await store.list({})
    expect(all.total).toBe(3)
  })

  it('blocks and unblocks', async () => {
    const store = new InMemoryUserStore()
    await store.upsertSeen('p1', 'u1')
    await store.setStatus('p1', 'u1', 'blocked')
    expect((await store.get('p1', 'u1'))?.status).toBe('blocked')
  })
})

describe('operator + audit stores', () => {
  it('creates operators once and counts them', async () => {
    const ops = new InMemoryOperatorStore()
    expect(await ops.count()).toBe(0)
    await ops.create({ email: 'admin@hippo.dev', passwordHash: 'salt:key', role: 'owner' })
    expect(await ops.count()).toBe(1)
    await expect(
      ops.create({ email: 'admin@hippo.dev', passwordHash: 'x', role: 'operator' }),
    ).rejects.toThrow('already exists')
  })

  it('appends audit entries, newest first', async () => {
    const audit = new InMemoryAuditStore()
    await audit.append({
      operatorEmail: 'a@x',
      action: 'partner.create',
      target: 'ex1',
      detail: {},
    })
    await audit.append({
      operatorEmail: 'a@x',
      action: 'partner.suspend',
      target: 'ex1',
      detail: {},
    })
    const page = await audit.list({})
    expect(page.total).toBe(2)
    expect(page.rows[0]?.action).toBe('partner.suspend')
  })
})

describe('InMemorySeamAuditStore', () => {
  const entry = (ts: number, kind: 'prepare' | 'confirm', ticketId = 't_1') => ({
    ts,
    kind,
    ticketId,
    idempotencyKey: `idem_${ts}_${kind}`,
  })

  it('appends verbatim (seam-minted ts + key) and lists newest first', async () => {
    const store = new InMemorySeamAuditStore()
    await store.append(entry(1000, 'prepare'))
    await store.append(entry(2000, 'confirm'))
    // Same-millisecond entries tie-break on id, like Postgres (ts DESC, id DESC).
    await store.append({ ...entry(2000, 'prepare', 't_2'), detail: 'buy 0.05 BTC/USDT' })

    const page = await store.list({})
    expect(page.total).toBe(3)
    expect(page.rows.map((r) => r.ticketId)).toEqual(['t_2', 't_1', 't_1'])
    expect(page.rows[0]?.detail).toBe('buy 0.05 BTC/USDT')
    expect(page.rows[0]?.idempotencyKey).toBe('idem_2000_prepare')
  })

  it('filters by ticketId and pages', async () => {
    const store = new InMemorySeamAuditStore()
    await store.append(entry(1, 'prepare', 't_a'))
    await store.append(entry(2, 'prepare', 't_b'))
    await store.append(entry(3, 'confirm', 't_a'))

    const forA = await store.list({ ticketId: 't_a' })
    expect(forA.total).toBe(2)
    expect(forA.rows.map((r) => r.kind)).toEqual(['confirm', 'prepare'])

    const paged = await store.list({ offset: 1, limit: 1 })
    expect(paged.total).toBe(3)
    expect(paged.rows).toHaveLength(1)
    expect(paged.rows[0]?.ticketId).toBe('t_b')
  })

  it('bounds the tail at 5,000 entries, dropping the oldest', async () => {
    const store = new InMemorySeamAuditStore()
    for (let i = 1; i <= 5_010; i++) await store.append(entry(i, 'prepare', `t_${i}`))
    const page = await store.list({ limit: 6_000 })
    expect(page.total).toBe(5_000)
    // The 10 oldest entries were shifted out; the newest survives.
    expect(page.rows[0]?.ticketId).toBe('t_5010')
    expect(page.rows.at(-1)?.ticketId).toBe('t_11')
  })
})

describe('InMemoryHostVenueStateStore', () => {
  it('round-trips a snapshot per venue and upserts on re-save', async () => {
    const store = new InMemoryHostVenueStateStore()
    expect(await store.load('assetworks')).toBeNull()

    await store.save('assetworks', { v: 1, nextOrderId: 10_001 }, 1000)
    expect(await store.load('assetworks')).toEqual({ v: 1, nextOrderId: 10_001 })

    // Re-save overwrites (ON CONFLICT DO UPDATE semantics), other venues untouched.
    await store.save('assetworks', { v: 1, nextOrderId: 10_002 }, 2000)
    await store.save('other-venue', { v: 1, nextOrderId: 50 }, 2000)
    expect(await store.load('assetworks')).toEqual({ v: 1, nextOrderId: 10_002 })
    expect(await store.load('other-venue')).toEqual({ v: 1, nextOrderId: 50 })
  })

  it('stores a deep copy — later mutation of the live object does not leak in', async () => {
    const store = new InMemoryHostVenueStateStore()
    const state = { orders: [{ id: 1 }] }
    await store.save('assetworks', state, 1000)
    state.orders.push({ id: 2 })
    expect(await store.load('assetworks')).toEqual({ orders: [{ id: 1 }] })
  })
})

describe('jwt helpers (lifted from gateway auth)', () => {
  it('round-trips valid tokens and rejects tampering/expiry', () => {
    const claims = { sub: 'op@hippo.dev', exp: Math.floor(Date.now() / 1000) + 60 }
    const token = signJwtHS256(claims, 'secret')
    expect(verifyJwtHS256(token, 'secret')?.sub).toBe('op@hippo.dev')
    expect(verifyJwtHS256(token, 'wrong')).toBeNull()
    expect(verifyJwtHS256(`${token}x`, 'secret')).toBeNull()

    const expired = signJwtHS256({ sub: 'x', exp: Math.floor(Date.now() / 1000) - 1 }, 'secret')
    expect(verifyJwtHS256(expired, 'secret')).toBeNull()
  })
})

describe('InMemoryMauStore', () => {
  it('records idempotently per (partner,user,month), counts and groups', async () => {
    const { InMemoryMauStore } = await import('../src/mau-store.js')
    const store = new InMemoryMauStore()
    await store.record('p1', 'u1', '2026-07')
    await store.record('p1', 'u1', '2026-07') // dup — idempotent
    await store.record('p1', 'u2', '2026-07')
    await store.record('p2', 'u1', '2026-07')
    await store.record('p1', 'u1', '2026-08') // next month is distinct

    expect(await store.count('p1', '2026-07')).toBe(2)
    expect(await store.count('p1', '2026-08')).toBe(1)
    expect(await store.byPartner('2026-07')).toEqual({ p1: 2, p2: 1 })

    const entries = await store.entries('2026-07')
    expect(entries).toHaveLength(3)
    expect(entries).toContainEqual({ partnerId: 'p1', userKey: 'u2' })
  })

  it('monthKey buckets to YYYY-MM', async () => {
    const { monthKey } = await import('../src/mau-store.js')
    expect(monthKey(new Date('2026-07-16T10:00:00Z'))).toBe('2026-07')
  })
})

describe('user search (q)', () => {
  it('matches userId substrings case-insensitively', async () => {
    const store = new InMemoryUserStore()
    await store.upsertSeen('p1', 'rahul.verma')
    await store.upsertSeen('p1', 'priya.patel')
    await store.upsertSeen('p2', 'rahul.k')

    expect((await store.list({ q: 'RAHUL' })).total).toBe(2)
    expect((await store.list({ q: 'rahul', partnerId: 'p1' })).total).toBe(1)
    expect((await store.list({ q: 'nobody' })).total).toBe(0)
  })
})

describe('InMemoryUploadedFileStore', () => {
  const base = (over: Partial<UploadedFile> = {}): UploadedFile => ({
    partnerId: 'p1',
    fileId: 'u_1',
    userKey: 'sub_a',
    name: 'holdings.csv',
    sizeBytes: 1024,
    sizeDisplay: '1 KB',
    mime: 'text/csv',
    kind: 'csv',
    status: 'analyzing',
    createdAt: 1000,
    ...over,
  })

  it('inserts a record and lists it by user key', async () => {
    const store = new InMemoryUploadedFileStore()
    await store.insert(base())
    const files = await store.listByUser('p1', 'sub_a')
    expect(files).toHaveLength(1)
    expect(files[0]?.fileId).toBe('u_1')
    expect(files[0]?.status).toBe('analyzing')
  })

  it('insert is idempotent per (partnerId, fileId)', async () => {
    const store = new InMemoryUploadedFileStore()
    await store.insert(base())
    await store.insert(base({ name: 'other.csv' })) // same id — ignored
    const files = await store.listByUser('p1', 'sub_a')
    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe('holdings.csv')
  })

  it('markAnalyzed sets the summary and clears any reason', async () => {
    const store = new InMemoryUploadedFileStore()
    await store.insert(base({ status: 'failed', reason: 'oops' }))
    await store.markAnalyzed('p1', 'u_1', 'BTC is down 4%')
    const [file] = await store.listByUser('p1', 'sub_a')
    expect(file?.status).toBe('analyzed')
    expect(file?.summary).toBe('BTC is down 4%')
    expect(file?.reason).toBeUndefined()
  })

  it('markFailed sets the reason and clears any summary', async () => {
    const store = new InMemoryUploadedFileStore()
    await store.insert(base({ status: 'analyzed', summary: 'a brief' }))
    await store.markFailed('p1', 'u_1', 'unreachable')
    const [file] = await store.listByUser('p1', 'sub_a')
    expect(file?.status).toBe('failed')
    expect(file?.reason).toBe('unreachable')
    expect(file?.summary).toBeUndefined()
  })

  it('lists a user’s own files only, never another user’s or partner’s', async () => {
    const store = new InMemoryUploadedFileStore()
    await store.insert(base({ fileId: 'u_1', userKey: 'sub_a' }))
    await store.insert(base({ fileId: 'u_2', userKey: 'id:victor' }))
    await store.insert(base({ fileId: 'u_3', userKey: 'sub_a', partnerId: 'p2' }))
    const files = await store.listByUser('p1', 'sub_a')
    expect(files.map((f) => f.fileId)).toEqual(['u_1'])
  })

  it('returns newest first', async () => {
    const store = new InMemoryUploadedFileStore()
    await store.insert(base({ fileId: 'u_1', createdAt: 1000 }))
    await store.insert(base({ fileId: 'u_2', createdAt: 3000 }))
    await store.insert(base({ fileId: 'u_3', createdAt: 2000 }))
    const files = await store.listByUser('p1', 'sub_a')
    expect(files.map((f) => f.fileId)).toEqual(['u_2', 'u_3', 'u_1'])
  })

  it('caps the result at the requested limit', async () => {
    const store = new InMemoryUploadedFileStore()
    for (let i = 0; i < 60; i++) {
      await store.insert(base({ fileId: `u_${i}`, createdAt: i }))
    }
    const capped = await store.listByUser('p1', 'sub_a', 50)
    expect(capped).toHaveLength(50)
    // Newest 50 (createdAt 59..10), so the oldest kept is u_10.
    expect(capped[0]?.fileId).toBe('u_59')
    expect(capped[49]?.fileId).toBe('u_10')
  })
})

describe('InMemoryUserIdentityStore listByPartner', () => {
  it('lists a partner’s identities, most recently seen first, bounded', async () => {
    const { InMemoryUserIdentityStore } = await import('../src/user-identity-store.js')
    const store = new InMemoryUserIdentityStore()
    await store.create('p1', 'Alice', 'salt:key')
    await store.create('p1', 'Bob', 'salt:key')
    await store.create('p2', 'Carol', 'salt:key')
    await store.touch('p1', 'alice', Date.now() + 60_000) // most recently seen

    const rows = await store.listByPartner('p1')
    expect(rows.map((i) => i.usernameLower)).toEqual(['alice', 'bob'])
    expect((await store.listByPartner('p1', 1)).map((i) => i.usernameLower)).toEqual(['alice'])
    expect(await store.listByPartner('nobody')).toEqual([])
  })
})

describe('migration 019_usage_indexes.sql', () => {
  const MIGRATIONS_DIR = new URL('../migrations', import.meta.url).pathname

  it('is the next migration in filename order', async () => {
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    expect(files).toContain('019_usage_indexes.sql')
    expect(files.indexOf('019_usage_indexes.sql')).toBe(files.indexOf('018_intent_signals.sql') + 1)
  })

  it('declares the month and last_seen reporting indexes', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const sql = readFileSync(join(MIGRATIONS_DIR, '019_usage_indexes.sql'), 'utf8')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS mau_events_month_idx ON mau_events (month)')
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS users_last_seen_idx ON users (last_seen DESC)',
    )
    // Indexes only — a usage migration must never mutate table shapes.
    expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP/i)
  })
})
