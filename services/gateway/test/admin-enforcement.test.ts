/**
 * Admin-panel enforcement at the gateway: suspended partners, blocked users,
 * plan MAU quotas, lazy user registration, entitlement pass-through.
 */
import {
  devPartner,
  InMemoryPartnerStore,
  InMemoryPlanStore,
  InMemoryUserStore,
} from '@hippo/stores'
import { describe, expect, it } from 'vitest'
import { PARTNERS, signJwtHS256 } from '../src/plugins/auth.js'
import { testApp } from './helpers.js'

const partner = PARTNERS[0]
if (!partner) throw new Error('no dev partner configured')

const now = Math.floor(Date.now() / 1000)
const jwtFor = (sub: string) =>
  signJwtHS256({ iss: partner.partnerId, sub, iat: now, exp: now + 300 }, partner.jwtSecret)

async function mint(app: Awaited<ReturnType<typeof testApp>>['app'], opts: { sub?: string } = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/session',
    ...(opts.sub ? { headers: { authorization: `Bearer ${jwtFor(opts.sub)}` } } : {}),
    payload: { partnerKey: 'pk_demo' },
  })
}

describe('suspended partners', () => {
  it('401s session mint for a suspended partner, in dev and JWT mode', async () => {
    const partnerStore = new InMemoryPartnerStore()
    await partnerStore.setStatus('koinbx-dev', 'suspended')
    const { app } = await testApp({ partnerStore })

    const anon = await mint(app)
    expect(anon.statusCode).toBe(401)
    expect(anon.json().error).toBe('partner suspended')

    const jwt = await mint(app, { sub: 'venue-user-1' })
    expect(jwt.statusCode).toBe(401)
    await app.close()
  })

  it('reactivating restores session mint', async () => {
    const partnerStore = new InMemoryPartnerStore()
    await partnerStore.setStatus('koinbx-dev', 'suspended')
    const { app } = await testApp({ partnerStore })
    expect((await mint(app)).statusCode).toBe(401)

    await partnerStore.setStatus('koinbx-dev', 'active')
    expect((await mint(app)).statusCode).toBe(200)
    await app.close()
  })
})

describe('blocked users + lazy registration', () => {
  it('registers authenticated users on session create; anonymous never', async () => {
    const userStore = new InMemoryUserStore()
    const { app } = await testApp({ userStore })

    await mint(app) // anonymous
    expect((await userStore.list({})).total).toBe(0)

    await mint(app, { sub: 'venue-user-7' })
    // upsert is fire-and-forget; give the microtask a beat
    await new Promise((r) => setTimeout(r, 10))
    const page = await userStore.list({})
    expect(page.total).toBe(1)
    expect(page.rows[0]).toMatchObject({ partnerId: 'koinbx-dev', userId: 'venue-user-7' })
    await app.close()
  })

  it('401s a blocked user while other users keep working', async () => {
    const userStore = new InMemoryUserStore()
    await userStore.upsertSeen('koinbx-dev', 'bad-actor')
    await userStore.setStatus('koinbx-dev', 'bad-actor', 'blocked')
    const { app } = await testApp({ userStore })

    const blocked = await mint(app, { sub: 'bad-actor' })
    expect(blocked.statusCode).toBe(401)
    expect(blocked.json().error).toBe('user blocked')

    expect((await mint(app, { sub: 'good-actor' })).statusCode).toBe(200)
    await app.close()
  })
})

describe('plan MAU quota', () => {
  async function quotaApp(mauQuota: number | null) {
    const partnerStore = new InMemoryPartnerStore([{ ...devPartner(), planId: 'pilot' }])
    const planStore = new InMemoryPlanStore()
    await planStore.create({
      planId: 'pilot',
      name: 'Pilot',
      tier: 'pilot',
      mauQuota,
      priceMonthlyUsd: null,
      entitlements: { streaming: true },
    })
    return testApp({ partnerStore, planStore })
  }

  it('429s the (quota+1)th distinct user; returning users stay unaffected', async () => {
    const { app } = await quotaApp(2)

    expect((await mint(app, { sub: 'u1' })).statusCode).toBe(200)
    expect((await mint(app, { sub: 'u2' })).statusCode).toBe(200)

    const third = await mint(app, { sub: 'u3' })
    expect(third.statusCode).toBe(429)
    expect(third.json().error).toBe('plan MAU quota reached')

    // u1 is already counted this month — still welcome.
    expect((await mint(app, { sub: 'u1' })).statusCode).toBe(200)
    await app.close()
  })

  it('null quota means unlimited', async () => {
    const { app } = await quotaApp(null)
    for (const sub of ['u1', 'u2', 'u3', 'u4']) {
      expect((await mint(app, { sub })).statusCode).toBe(200)
    }
    await app.close()
  })

  it('passes plan entitlements through in session config', async () => {
    const { app } = await quotaApp(10)
    const res = await mint(app, { sub: 'u1' })
    expect(res.json().config.entitlements).toEqual({ streaming: true })
    await app.close()
  })

  it('no plan assigned → no quota, no entitlements (current default)', async () => {
    const { app } = await testApp()
    const res = await mint(app)
    expect(res.statusCode).toBe(200)
    expect(res.json().config.entitlements).toBeUndefined()
    await app.close()
  })
})
