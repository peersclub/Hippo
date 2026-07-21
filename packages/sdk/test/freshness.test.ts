import { describe, expect, it } from 'vitest'
import { isStale, STALE_AFTER_MS, staleAgeLabel } from '../src/freshness.js'

const now = Date.parse('2026-07-14T12:00:00.000Z')

describe('stale threshold', () => {
  it('is fresh under 3 minutes', () => {
    expect(isStale('2026-07-14T11:58:30.000Z', now)).toBe(false)
  })

  it('is not stale exactly at the threshold', () => {
    expect(isStale(new Date(now - STALE_AFTER_MS).toISOString(), now)).toBe(false)
  })

  it('is stale past 3 minutes', () => {
    expect(isStale('2026-07-14T11:56:59.000Z', now)).toBe(true)
  })

  it('never flags an unparseable timestamp as stale', () => {
    expect(isStale('not-a-date', now)).toBe(false)
  })
})

describe('staleAgeLabel', () => {
  const iso = (agoMs: number, now: number) => new Date(now - agoMs).toISOString()
  const NOW = 1_752_480_000_000

  it('null while fresh — the prefix only appears past the stale threshold', () => {
    expect(staleAgeLabel(iso(60_000, NOW), NOW)).toBeNull()
  })

  it('minutes form: "⚠ 14 MIN OLD · "', () => {
    expect(staleAgeLabel(iso(14 * 60_000, NOW), NOW)).toBe('⚠ 14 MIN OLD · ')
  })

  it('hours form past 60 minutes', () => {
    expect(staleAgeLabel(iso(2 * 60 * 60_000, NOW), NOW)).toBe('⚠ 2 HR OLD · ')
  })

  it('unparseable dates never label — same guard as isStale', () => {
    expect(staleAgeLabel('not-a-date', NOW)).toBeNull()
  })
})
