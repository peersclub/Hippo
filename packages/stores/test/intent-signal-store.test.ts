/** Implicit misunderstanding signals (migration 018): record/list/summary,
 * the text bound, and the migration's shape. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  clampSignalText,
  INTENT_SIGNAL_TEXT_CAP,
  InMemoryIntentSignalStore,
  type IntentSignal,
  summarize,
} from '../src/index.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

const signal = (extra: Partial<IntentSignal> = {}): IntentSignal => ({
  id: `is_${Math.random().toString(36).slice(2, 10)}`,
  partnerId: 'koinbx-dev',
  userKey: 'user-1',
  sessionId: 's_1',
  signal: 'rephrase',
  originalText: 'why is btc down',
  classifiedIntent: 'research',
  createdAt: Date.now(),
  ...extra,
})

describe('InMemoryIntentSignalStore', () => {
  it('records and lists newest-first, scoped to the partner and bounded', async () => {
    const store = new InMemoryIntentSignalStore()
    await store.record(signal({ id: 'a', createdAt: 1 }))
    await store.record(signal({ id: 'b', createdAt: 2 }))
    await store.record(signal({ id: 'other', createdAt: 3, partnerId: 'someone-else' }))

    expect((await store.list({ partnerId: 'koinbx-dev' })).map((s) => s.id)).toEqual(['b', 'a'])
    expect((await store.list({ partnerId: 'koinbx-dev', limit: 1 })).map((s) => s.id)).toEqual([
      'b',
    ])
    expect((await store.list({ partnerId: 'someone-else' })).map((s) => s.id)).toEqual(['other'])
  })

  it('filters by since and by signal kind', async () => {
    const store = new InMemoryIntentSignalStore()
    await store.record(signal({ id: 'old', createdAt: 100 }))
    await store.record(signal({ id: 'new', createdAt: 900 }))
    await store.record(signal({ id: 'cancel', createdAt: 950, signal: 'ticket_abandoned' }))

    expect((await store.list({ partnerId: 'koinbx-dev', since: 900 })).map((s) => s.id)).toEqual([
      'cancel',
      'new',
    ])
    expect(
      (await store.list({ partnerId: 'koinbx-dev', signal: 'ticket_abandoned' })).map((s) => s.id),
    ).toEqual(['cancel'])
  })

  it('is idempotent per id', async () => {
    const store = new InMemoryIntentSignalStore()
    await store.record(signal({ id: 'dupe', originalText: 'first' }))
    await store.record(signal({ id: 'dupe', originalText: 'second' }))
    const rows = await store.list({ partnerId: 'koinbx-dev' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.originalText).toBe('first')
  })

  it(`clamps stored trader text to ${INTENT_SIGNAL_TEXT_CAP} chars, and drops empty text`, async () => {
    const store = new InMemoryIntentSignalStore()
    await store.record(signal({ id: 'long', originalText: 'x'.repeat(1000) }))
    await store.record(signal({ id: 'blank', originalText: '   ' }))
    const rows = await store.list({ partnerId: 'koinbx-dev' })
    expect(rows.find((r) => r.id === 'long')?.originalText).toHaveLength(INTENT_SIGNAL_TEXT_CAP)
    expect(rows.find((r) => r.id === 'blank')?.originalText).toBeUndefined()
    // The helper both stores use agrees.
    expect(clampSignalText(undefined)).toBeUndefined()
    expect(clampSignalText(' hi ')).toBe('hi')
  })

  it('summarizes counts by signal and by classified intent (zeros are honest)', async () => {
    const store = new InMemoryIntentSignalStore()
    await store.record(signal({ id: '1', classifiedIntent: 'action' }))
    await store.record(signal({ id: '2', signal: 'ticket_abandoned', classifiedIntent: 'action' }))
    await store.record(
      signal({ id: '3', signal: 'negative_feedback', classifiedIntent: 'research' }),
    )
    // A row we never classified counts toward the total, not toward an intent.
    await store.record(signal({ id: '4', signal: 'draft_dismissed', classifiedIntent: undefined }))

    const summary = await store.summary('koinbx-dev')
    expect(summary.total).toBe(4)
    expect(summary.bySignal).toEqual({
      rephrase: 1,
      ticket_abandoned: 1,
      draft_dismissed: 1,
      negative_feedback: 1,
    })
    expect(summary.byIntent).toEqual({ action: 2, research: 1 })
    // Unknown partner → an all-zero summary, never a throw.
    expect((await store.summary('nobody')).total).toBe(0)
  })

  it('summarize() is pure and shared by both implementations', () => {
    expect(summarize([]).bySignal.rephrase).toBe(0)
    expect(summarize([signal(), signal()]).total).toBe(2)
  })
})

describe('migration 018_intent_signals.sql', () => {
  it('is the next migration in filename order', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    expect(files).toContain('018_intent_signals.sql')
    expect(files.indexOf('018_intent_signals.sql')).toBe(files.indexOf('017_alerts.sql') + 1)
  })

  it('declares the intent_signals table shape the stores expect', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '018_intent_signals.sql'), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS intent_signals')
    expect(sql).toContain('id                text             PRIMARY KEY')
    for (const col of [
      'partner_id',
      'user_key',
      'session_id',
      'signal',
      'original_text',
      'classified_intent',
      'confidence',
      'detail',
      'created_at',
    ]) {
      expect(sql).toContain(col)
    }
    expect(sql).toContain(
      "CHECK (signal IN ('rephrase', 'ticket_abandoned', 'draft_dismissed', 'negative_feedback'))",
    )
    // original_text must stay NULLABLE — that is how the learn opt-out is
    // honored without losing the count.
    expect(sql).not.toMatch(/original_text\s+text\s+NOT NULL/)
    expect(sql).toContain('intent_signals_partner_created_idx')
    expect(sql).toContain('ON intent_signals (partner_id, created_at DESC)')
    expect(sql).toContain('intent_signals_intent_signal_idx')
    expect(sql).toContain('ON intent_signals (classified_intent, signal)')
  })
})
