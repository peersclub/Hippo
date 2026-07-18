import { describe, expect, it } from 'vitest'
import {
  devPartner,
  InMemoryAuditStore,
  InMemoryOperatorStore,
  InMemoryPartnerStore,
  InMemoryPlanStore,
  InMemoryUserStore,
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
