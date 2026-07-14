import { describe, expect, it } from 'vitest'
import { isStale, STALE_AFTER_MS } from '../src/freshness.js'

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
