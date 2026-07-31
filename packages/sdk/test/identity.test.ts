import { describe, expect, it } from 'vitest'
import {
  identityClaimUplink,
  PIN_RE,
  signOutUplink,
  statusMessageKey,
  USERNAME_RE,
  validateClaim,
} from '../src/identity.js'

// Local validation mirrors the uplink schema exactly — an invalid claim must
// never leave the panel (the gateway would reject it anyway; failing locally
// is faster and kinder).
describe('validateClaim', () => {
  it('accepts the schema shape: 3–24 of [a-zA-Z0-9_-] + a 4-digit PIN', () => {
    expect(validateClaim('vik', '0000')).toBe(true)
    expect(validateClaim('Vik_tor-99', '1234')).toBe(true)
    expect(validateClaim('a'.repeat(24), '9999')).toBe(true)
  })

  it('rejects usernames outside the regex', () => {
    expect(validateClaim('ab', '1234')).toBe(false) // too short
    expect(validateClaim('a'.repeat(25), '1234')).toBe(false) // too long
    expect(validateClaim('vik tor', '1234')).toBe(false) // space
    expect(validateClaim('vik.tor', '1234')).toBe(false) // dot
    expect(validateClaim('विक्टर', '1234')).toBe(false) // non-ASCII
    expect(validateClaim('', '1234')).toBe(false)
  })

  it('rejects PINs that are not exactly 4 digits', () => {
    expect(validateClaim('victor', '123')).toBe(false)
    expect(validateClaim('victor', '12345')).toBe(false)
    expect(validateClaim('victor', '12a4')).toBe(false)
    expect(validateClaim('victor', '')).toBe(false)
  })

  it('exports the exact wire regexes (drift here is a protocol bug)', () => {
    expect(USERNAME_RE.source).toBe('^[a-zA-Z0-9_-]{3,24}$')
    expect(PIN_RE.source).toBe('^\\d{4}$')
  })
})

describe('uplink builders', () => {
  it('builds identity_claim exactly like other uplinks (envelope stamped by send)', () => {
    expect(identityClaimUplink('create', 'victor', '1234')).toEqual({
      kind: 'identity_claim',
      mode: 'create',
      username: 'victor',
      pin: '1234',
    })
    expect(identityClaimUplink('signin', 'victor', '1234').mode).toBe('signin')
  })

  it('sign-out carries no credentials', () => {
    expect(signOutUplink()).toEqual({ kind: 'identity_claim', mode: 'signout' })
  })
})

describe('statusMessageKey — every server status renders', () => {
  it('maps each non-ok status to a chrome key', () => {
    expect(statusMessageKey('taken')).toBe('id_taken')
    expect(statusMessageKey('wrong_pin')).toBe('id_wrong_pin')
    expect(statusMessageKey('invalid')).toBe('id_invalid')
    expect(statusMessageKey('rate_limited')).toBe('id_rate_limited')
    expect(statusMessageKey('signed_out')).toBe('id_signed_out')
  })

  it('ok (and absence) has no error line — the card flips to signed-in instead', () => {
    expect(statusMessageKey('ok')).toBeNull()
    expect(statusMessageKey(null)).toBeNull()
    expect(statusMessageKey(undefined)).toBeNull()
  })
})
