import { ApiError } from '../src/api.js'
import { describe, expect, it } from 'vitest'
import { purgeRows } from '../src/purge-report.js'
import { identityMatchesUserKey, personaStatusFromError } from '../src/user-detail-format.js'

describe('personaStatusFromError', () => {
  // Regression: a memory-service 502 used to render the definitive "No memory
  // held for this user." — an outage must classify as unknown, never absence.
  it('classifies a 404 as confirmed absence', () => {
    expect(personaStatusFromError(new ApiError(404, 'no memory held for this user'))).toBe('none')
  })

  it('classifies a 502 / network failure as unavailable, never none', () => {
    expect(personaStatusFromError(new ApiError(502, 'memory service unreachable'))).toBe(
      'unavailable',
    )
    expect(personaStatusFromError(new TypeError('fetch failed'))).toBe('unavailable')
  })
})

describe('identityMatchesUserKey', () => {
  it('matches the id:<usernameLower> effective key and bare venue ids', () => {
    expect(identityMatchesUserKey('satoshi', 'id:satoshi')).toBe(true)
    expect(identityMatchesUserKey('satoshi', 'Satoshi')).toBe(true)
    expect(identityMatchesUserKey('satoshi', 'someone-else')).toBe(false)
    expect(identityMatchesUserKey('satoshi', 'id:someone-else')).toBe(false)
  })
})

describe('purgeRows', () => {
  const okLeg = { ok: true as const, detail: { deleted: 1 } }

  it('reports every leg, and never summarizes a failed leg as success', () => {
    const rows = purgeRows({
      persona: okLeg,
      learnedFacts: { ok: false, error: 'upstream error', status: 500 },
      userNote: okLeg,
      gateway: { ok: false, error: 'unreachable' },
    })
    expect(rows).toHaveLength(4)
    expect(rows.filter((r) => !r.ok)).toHaveLength(2)
    const facts = rows.find((r) => r.store.startsWith('Learned facts'))
    expect(facts?.ok).toBe(false)
    expect(facts?.note).toContain('FAILED')
    expect(facts?.note).toContain('500')
    const gw = rows.find((r) => r.store.startsWith('Gateway'))
    expect(gw?.note).toContain('unreachable')
    expect(gw?.note).toContain('data may remain')
  })

  it('all-green purge reports four purged rows', () => {
    const rows = purgeRows({ persona: okLeg, learnedFacts: okLeg, userNote: okLeg, gateway: okLeg })
    expect(rows.every((r) => r.ok && r.note === 'purged')).toBe(true)
  })
})
