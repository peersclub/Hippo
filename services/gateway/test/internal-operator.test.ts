/**
 * Operator purge + visibility surface: POST /internal/user-purge, the alerts/
 * shares/identities reads, the leaked-share kill switch, the intent-signals
 * registry fan-out (no 50-partner silent cap + partnersScanned), and the
 * telemetry MAU month-rollover prune.
 */
import {
  type Alert,
  InMemoryAlertStore,
  InMemoryIntentSignalStore,
  InMemoryPartnerStore,
  InMemoryUploadedFileStore,
  InMemoryUserIdentityStore,
  type IntentSignal,
  type UploadedFile,
} from '@hippo/stores'
import { describe, expect, it } from 'vitest'
import { Telemetry } from '../src/plugins/telemetry.js'
import { InMemoryShareStore, type ShareRecord } from '../src/shares.js'
import { TEST_INTERNAL_TOKEN, testApp } from './helpers.js'

const authed = { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN }

// ── fixtures ────────────────────────────────────────────────────────────────

const alertRow = (id: string, userKey: string, partnerId = 'koinbx-dev'): Alert => ({
  id,
  partnerId,
  userKey,
  symbol: 'BTC/USDT',
  condition: 'above',
  price: 70_000,
  state: 'armed',
  createdAt: Date.now(),
  delivered: false,
})

const fileRow = (fileId: string, userKey: string): UploadedFile => ({
  partnerId: 'koinbx-dev',
  fileId,
  userKey,
  name: 'trades.csv',
  sizeBytes: 128,
  sizeDisplay: '128 B',
  mime: 'text/csv',
  kind: 'csv',
  status: 'analyzed',
  createdAt: Date.now(),
})

const signalRow = (id: string, userKey: string, partnerId = 'koinbx-dev'): IntentSignal => ({
  id,
  partnerId,
  userKey,
  signal: 'rephrase',
  originalText: 'why btc down',
  createdAt: Date.now(),
})

const shareRow = (id: string, partnerId = 'koinbx-dev', expiresInMs = 60_000): ShareRecord => ({
  id,
  partnerId,
  venueName: 'Assetworks',
  symbol: 'BTC/USDT',
  headline: 'BTC is down',
  paragraphs: ['Macro selloff.'],
  createdAt: Date.now(),
  expiresAt: Date.now() + expiresInMs,
})

// ── auth: every new internal route fails closed ────────────────────────────

describe('new /internal routes are token-guarded', () => {
  it('401s each route without the internal token', async () => {
    const { app } = await testApp()
    const requests = [
      { method: 'GET' as const, url: '/internal/alerts?partnerId=koinbx-dev' },
      { method: 'POST' as const, url: '/internal/alerts/al_x/cancel', payload: {} },
      { method: 'GET' as const, url: '/internal/shares?partnerId=koinbx-dev' },
      { method: 'DELETE' as const, url: '/internal/shares/abcdefabcdef', payload: {} },
      { method: 'GET' as const, url: '/internal/identities?partnerId=koinbx-dev' },
      { method: 'POST' as const, url: '/internal/user-purge', payload: {} },
    ]
    for (const req of requests) {
      const res = await app.inject(req)
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(401)
    }
  })
})

// ── visibility reads ────────────────────────────────────────────────────────

describe('GET /internal/alerts + POST /internal/alerts/:id/cancel', () => {
  it('lists a partner alerts and requires partnerId', async () => {
    const alertStore = new InMemoryAlertStore()
    await alertStore.create(alertRow('al_1', 'u1'))
    await alertStore.create(alertRow('al_2', 'u2'))
    const { app } = await testApp({ alertStore })

    const missing = await app.inject({ method: 'GET', url: '/internal/alerts', headers: authed })
    expect(missing.statusCode).toBe(400)

    const res = await app.inject({
      method: 'GET',
      url: '/internal/alerts?partnerId=koinbx-dev',
      headers: authed,
    })
    expect(res.statusCode).toBe(200)
    const { alerts } = res.json() as { alerts: Alert[] }
    expect(alerts.map((a) => a.id).sort()).toEqual(['al_1', 'al_2'])
  })

  it('cancels an armed alert by owner fields; unknown ids are an idempotent no-op', async () => {
    const alertStore = new InMemoryAlertStore()
    await alertStore.create(alertRow('al_1', 'u1'))
    const { app } = await testApp({ alertStore })

    const res = await app.inject({
      method: 'POST',
      url: '/internal/alerts/al_1/cancel',
      headers: authed,
      payload: { partnerId: 'koinbx-dev', userKey: 'u1' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { cancelled: boolean; alert: Alert }).cancelled).toBe(true)
    expect((res.json() as { alert: Alert }).alert.state).toBe('cancelled')

    // Second cancel (already terminal) and a foreign owner both report false.
    const again = await app.inject({
      method: 'POST',
      url: '/internal/alerts/al_1/cancel',
      headers: authed,
      payload: { partnerId: 'koinbx-dev', userKey: 'u1' },
    })
    expect((again.json() as { cancelled: boolean }).cancelled).toBe(false)

    const noBody = await app.inject({
      method: 'POST',
      url: '/internal/alerts/al_1/cancel',
      headers: authed,
      payload: {},
    })
    expect(noBody.statusCode).toBe(400)
  })
})

describe('GET /internal/shares + DELETE /internal/shares/:id', () => {
  it('lists live shares only and the kill switch removes a leaked link', async () => {
    const shareStore = new InMemoryShareStore()
    shareStore.create(shareRow('aaaaaaaaaaaa'))
    shareStore.create(shareRow('bbbbbbbbbbbb', 'koinbx-dev', -1)) // already expired
    shareStore.create(shareRow('cccccccccccc', 'other-partner'))
    const { app } = await testApp({ shareStore })

    const missing = await app.inject({ method: 'GET', url: '/internal/shares', headers: authed })
    expect(missing.statusCode).toBe(400)

    const res = await app.inject({
      method: 'GET',
      url: '/internal/shares?partnerId=koinbx-dev',
      headers: authed,
    })
    const { shares } = res.json() as { shares: ShareRecord[] }
    expect(shares.map((s) => s.id)).toEqual(['aaaaaaaaaaaa'])

    // Kill switch: the public page 404s from the next open.
    const del = await app.inject({
      method: 'DELETE',
      url: '/internal/shares/aaaaaaaaaaaa',
      headers: authed,
      payload: {},
    })
    expect((del.json() as { deleted: boolean }).deleted).toBe(true)
    expect((await app.inject({ method: 'GET', url: '/s/aaaaaaaaaaaa' })).statusCode).toBe(404)
    // Idempotent: a second delete reports false, never an error.
    const again = await app.inject({
      method: 'DELETE',
      url: '/internal/shares/aaaaaaaaaaaa',
      headers: authed,
      payload: {},
    })
    expect((again.json() as { deleted: boolean }).deleted).toBe(false)
  })
})

describe('GET /internal/identities', () => {
  it('lists a partner identities with pinHash stripped', async () => {
    const identityStore = new InMemoryUserIdentityStore()
    await identityStore.create('koinbx-dev', 'Ravi', 'salt:key')
    const { app } = await testApp({ identityStore })

    const missing = await app.inject({
      method: 'GET',
      url: '/internal/identities',
      headers: authed,
    })
    expect(missing.statusCode).toBe(400)

    const res = await app.inject({
      method: 'GET',
      url: '/internal/identities?partnerId=koinbx-dev',
      headers: authed,
    })
    expect(res.statusCode).toBe(200)
    const { identities } = res.json() as { identities: Array<Record<string, unknown>> }
    expect(identities).toHaveLength(1)
    expect(identities[0]?.usernameLower).toBe('ravi')
    expect(identities[0]).not.toHaveProperty('pinHash')
  })
})

// ── user purge ──────────────────────────────────────────────────────────────

describe('POST /internal/user-purge', () => {
  it('deletes one user across signals, files, alerts and identities — others untouched', async () => {
    const alertStore = new InMemoryAlertStore()
    const uploadedFileStore = new InMemoryUploadedFileStore()
    const intentSignalStore = new InMemoryIntentSignalStore()
    const identityStore = new InMemoryUserIdentityStore()

    // The purge target is an in-panel identity: effective key `id:ravi`.
    await identityStore.create('koinbx-dev', 'Ravi', 'salt:key')
    await identityStore.link('koinbx-dev', 'sub_1', 'ravi')
    await alertStore.create(alertRow('al_1', 'id:ravi'))
    await alertStore.create(alertRow('al_keep', 'other-user'))
    await uploadedFileStore.insert(fileRow('f_1', 'id:ravi'))
    await uploadedFileStore.insert(fileRow('f_keep', 'other-user'))
    await intentSignalStore.record(signalRow('s_1', 'id:ravi'))
    await intentSignalStore.record(signalRow('s_2', 'id:ravi'))
    await intentSignalStore.record(signalRow('s_keep', 'other-user'))

    const { app } = await testApp({
      alertStore,
      uploadedFileStore,
      intentSignalStore,
      identityStore,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/internal/user-purge',
      headers: authed,
      payload: { partnerId: 'koinbx-dev', userKey: 'id:ravi' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      partnerId: 'koinbx-dev',
      userKey: 'id:ravi',
      // identities: the row + the sub link = 2 (the store counts both).
      // mauEvents is 'retained' by design — billing counts survive erasure,
      // and the report names that instead of omitting the store.
      deleted: {
        intentSignals: 2,
        uploadedFiles: 1,
        alerts: 1,
        identities: 2,
        mauEvents: 'retained',
      },
    })

    // The purged user's data is gone; the other user's rows survive.
    expect(await alertStore.listByUser('koinbx-dev', 'id:ravi')).toEqual([])
    expect(await uploadedFileStore.listByUser('koinbx-dev', 'id:ravi')).toEqual([])
    expect(await intentSignalStore.list({ partnerId: 'koinbx-dev' })).toHaveLength(1)
    expect(await identityStore.get('koinbx-dev', 'ravi')).toBeUndefined()
    expect((await alertStore.listByUser('koinbx-dev', 'other-user')).length).toBe(1)

    // Second purge is idempotent — honest zeros, never an error.
    const again = await app.inject({
      method: 'POST',
      url: '/internal/user-purge',
      headers: authed,
      payload: { partnerId: 'koinbx-dev', userKey: 'id:ravi' },
    })
    expect((again.json() as { deleted: Record<string, number | string> }).deleted).toEqual({
      intentSignals: 0,
      uploadedFiles: 0,
      alerts: 0,
      identities: 0,
      mauEvents: 'retained',
    })
  })

  it('400s on missing fields and reports unsupported stores honestly', async () => {
    // An injected store WITHOUT deleteByUser (the seam the finding names):
    // the purge still runs the other stores and says so per-store.
    const alertStore = new InMemoryAlertStore()
    const crippled = Object.create(alertStore) as InMemoryAlertStore
    Object.defineProperty(crippled, 'deleteByUser', { value: undefined })
    const { app } = await testApp({ alertStore: crippled })

    const bad = await app.inject({
      method: 'POST',
      url: '/internal/user-purge',
      headers: authed,
      payload: { partnerId: 'koinbx-dev' },
    })
    expect(bad.statusCode).toBe(400)

    const res = await app.inject({
      method: 'POST',
      url: '/internal/user-purge',
      headers: authed,
      payload: { partnerId: 'koinbx-dev', userKey: 'u1' },
    })
    const { deleted } = res.json() as { deleted: Record<string, unknown> }
    expect(deleted.alerts).toBe('unsupported')
    expect(deleted.intentSignals).toBe(0)
    expect(deleted.identities).toBe(0)
  })
})

// ── intent-signals fan-out: no 50-partner silent cap ────────────────────────

describe('GET /internal/intent-signals scans the whole registry', () => {
  it('includes partners past the old 50-partner slice and reports partnersScanned', async () => {
    const partnerStore = new InMemoryPartnerStore()
    for (let i = 1; i <= 60; i++) {
      await partnerStore.create({
        partnerId: `p${String(i).padStart(2, '0')}`,
        partnerKey: `pk_p${i}`,
        jwtSecret: 's',
        venueName: `Venue ${i}`,
        locales: ['en'],
        suggestedQueries: [],
      })
    }
    const intentSignalStore = new InMemoryIntentSignalStore()
    // The signal lives on the 55th partner — dropped by the old slice(0, 50).
    await intentSignalStore.record(signalRow('s_55', 'u1', 'p55'))
    const { app } = await testApp({ partnerStore, intentSignalStore })

    const res = await app.inject({
      method: 'GET',
      url: '/internal/intent-signals',
      headers: authed,
    })
    const body = res.json() as {
      signals: IntentSignal[]
      summary: { total: number }
      partnersScanned: number
    }
    // 60 created + the seeded koinbx-dev dev partner.
    expect(body.partnersScanned).toBe(61)
    expect(body.signals.map((s) => s.id)).toContain('s_55')
    expect(body.summary.total).toBe(1)

    // A one-partner read reports exactly one partner scanned.
    const one = await app.inject({
      method: 'GET',
      url: '/internal/intent-signals?partnerId=p55&limit=1',
      headers: authed,
    })
    expect((one.json() as { partnersScanned: number }).partnersScanned).toBe(1)
  })
})

// ── telemetry MAU prune on month rollover ───────────────────────────────────

describe('Telemetry.pruneMau', () => {
  it('drops last month keys from all three MAU sets on rollover', () => {
    let nowIso = '2026-07-14T09:00:00.000Z'
    const telemetry = new Telemetry({}, () => new Date(nowIso))
    telemetry.recordPartnerUser('koinbx-dev', 'u1')
    telemetry.recordPartnerUser('koinbx-dev', 'u2')
    telemetry.recordResearchAnswered('u1')
    telemetry.recordOrderExecuted('u1')
    expect(telemetry.partnerMau('koinbx-dev')).toBe(2)

    // Month rolls over: counts reset AND the sets actually shrink — the old
    // code filtered by suffix (same external numbers) but retained every key
    // forever, which is exactly what this asserts against.
    nowIso = '2026-08-01T00:00:01.000Z'
    telemetry.recordPartnerUser('koinbx-dev', 'u3')
    expect(telemetry.partnerMau('koinbx-dev')).toBe(1)
    const sets = telemetry as unknown as {
      partnerMauSet: Set<string>
      researchMau: Set<string>
      orderMau: Set<string>
    }
    expect(sets.partnerMauSet.size).toBe(1)

    const snap = telemetry.snapshot() as {
      mau: { month: string; research_answered: number; order_executed: number }
    }
    expect(snap.mau.month).toBe('2026-08')
    expect(snap.mau.research_answered).toBe(0)
    expect(snap.mau.order_executed).toBe(0)
    expect(sets.researchMau.size).toBe(0)
    expect(sets.orderMau.size).toBe(0)

    // Same-month churn never prunes live keys.
    telemetry.recordPartnerUser('koinbx-dev', 'u4')
    expect(telemetry.partnerMau('koinbx-dev')).toBe(2)
    expect(telemetry.hasPartnerUser('koinbx-dev', 'u3')).toBe(true)
  })
})
