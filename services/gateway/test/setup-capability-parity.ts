/**
 * SUITE-WIDE capability parity check — runs for every gateway test, not just
 * the ones that thought to assert it.
 *
 * The invariant: the gateway must never hand the seam a plan for a capability
 * the venue does not advertise. Three shipped defects all reduced to breaking
 * it (a perp ask silently downgraded to spot, a spot draft prepared against a
 * perp-only venue, a close carrying a fabricated leverage) and none of them
 * were caught, because every capability stub in the existing suite happened to
 * advertise both spot and futures_perp.
 *
 * So the check is global rather than per-case: beforeEach arms it, afterEach
 * drains the audit that helpers.ts's stubSeam records on every prepare and
 * fails the test that violated it. Any future order path that reaches the seam
 * is covered the day it is written.
 */
import { afterEach, beforeEach, expect } from 'vitest'
import { preparedCapabilityAudit } from './helpers.js'

beforeEach(() => {
  preparedCapabilityAudit.length = 0
})

afterEach(() => {
  const violations = preparedCapabilityAudit
    .filter((entry) => entry.caps[entry.capability] === undefined)
    .map((entry) => `${entry.capability} (venue advertises: ${Object.keys(entry.caps).join(', ')})`)
  preparedCapabilityAudit.length = 0
  expect(
    violations,
    'the gateway prepared an order for a capability the venue does not advertise',
  ).toEqual([])
})
