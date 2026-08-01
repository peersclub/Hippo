/** Price alerts store (migration 017): cap, one-way state machine, delivery. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type Alert, InMemoryAlertStore, MAX_ARMED_ALERTS_PER_USER } from '../src/index.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

const alert = (extra: Partial<Alert> = {}): Alert => ({
  id: `al_${Math.random().toString(36).slice(2, 10)}`,
  partnerId: 'koinbx-dev',
  userKey: 'user-1',
  symbol: 'BTC/USDT',
  condition: 'above',
  price: 70_000,
  state: 'armed',
  createdAt: Date.now(),
  delivered: false,
  ...extra,
})

describe('InMemoryAlertStore', () => {
  it('creates and lists armed alerts, newest first per user', async () => {
    const store = new InMemoryAlertStore()
    expect(await store.create(alert({ id: 'a1', createdAt: 1 }))).toBe('ok')
    expect(await store.create(alert({ id: 'a2', createdAt: 2 }))).toBe('ok')
    expect(await store.create(alert({ id: 'b1', userKey: 'user-2', createdAt: 3 }))).toBe('ok')

    expect((await store.listArmed()).map((a) => a.id).sort()).toEqual(['a1', 'a2', 'b1'])
    expect((await store.listByUser('koinbx-dev', 'user-1')).map((a) => a.id)).toEqual(['a2', 'a1'])
    expect((await store.listByUser('koinbx-dev', 'user-1', 1)).map((a) => a.id)).toEqual(['a2'])
  })

  it(`caps armed alerts at ${MAX_ARMED_ALERTS_PER_USER} per user — creation beyond fails honestly`, async () => {
    const store = new InMemoryAlertStore()
    for (let i = 0; i < MAX_ARMED_ALERTS_PER_USER; i++) {
      expect(await store.create(alert({ id: `a${i}` }))).toBe('ok')
    }
    expect(await store.create(alert({ id: 'overflow' }))).toBe('capped')
    // Cap is per (partner, user) and counts ARMED only.
    expect(await store.create(alert({ id: 'other-user', userKey: 'user-2' }))).toBe('ok')
    expect(await store.cancel('a0', 'koinbx-dev', 'user-1')).not.toBeNull()
    expect(await store.create(alert({ id: 'after-cancel' }))).toBe('ok')
  })

  it('cancel flips only armed→cancelled, only for the owner, idempotently', async () => {
    const store = new InMemoryAlertStore()
    await store.create(alert({ id: 'a1' }))

    // Foreign owner / wrong partner / unknown id → null, state untouched.
    expect(await store.cancel('a1', 'koinbx-dev', 'someone-else')).toBeNull()
    expect(await store.cancel('a1', 'other-partner', 'user-1')).toBeNull()
    expect(await store.cancel('nope', 'koinbx-dev', 'user-1')).toBeNull()
    expect((await store.listArmed()).map((a) => a.id)).toEqual(['a1'])

    const cancelled = await store.cancel('a1', 'koinbx-dev', 'user-1')
    expect(cancelled?.state).toBe('cancelled')
    // Second cancel is a no-op, never an error.
    expect(await store.cancel('a1', 'koinbx-dev', 'user-1')).toBeNull()
    expect(await store.listArmed()).toEqual([])

    // A triggered alert can't be cancelled either.
    await store.create(alert({ id: 'a2' }))
    await store.markTriggered('a2')
    expect(await store.cancel('a2', 'koinbx-dev', 'user-1')).toBeNull()
  })

  it('markTriggered wins exactly once; markDelivered flips the flag', async () => {
    const store = new InMemoryAlertStore()
    await store.create(alert({ id: 'a1' }))
    expect(await store.markTriggered('a1', 123)).toBe(true)
    expect(await store.markTriggered('a1')).toBe(false) // already triggered
    expect(await store.markTriggered('unknown')).toBe(false)

    const [row] = await store.listByUser('koinbx-dev', 'user-1')
    expect(row?.state).toBe('triggered')
    expect(row?.triggeredAt).toBe(123)
    expect(row?.delivered).toBe(false)

    await store.markDelivered('a1')
    expect((await store.listByUser('koinbx-dev', 'user-1'))[0]?.delivered).toBe(true)
  })
})

describe('migration 017_alerts.sql', () => {
  it('is the next migration in filename order', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    expect(files).toContain('017_alerts.sql')
    expect(files.indexOf('017_alerts.sql')).toBe(files.indexOf('016_uploaded_files.sql') + 1)
  })

  it('declares the alerts table shape the stores expect', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '017_alerts.sql'), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS alerts')
    expect(sql).toContain('id           text    PRIMARY KEY')
    for (const col of [
      'partner_id',
      'user_key',
      'symbol',
      'condition',
      'price',
      'state',
      'created_at',
      'triggered_at',
      'delivered',
    ]) {
      expect(sql).toContain(col)
    }
    expect(sql).toContain("CHECK (condition IN ('above', 'below'))")
    expect(sql).toContain("CHECK (state IN ('armed', 'triggered', 'cancelled'))")
    expect(sql).toContain('alerts_state_idx ON alerts (state)')
    expect(sql).toContain('alerts_partner_user_idx ON alerts (partner_id, user_key)')
  })
})
