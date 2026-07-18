/**
 * scrypt password hashing shared by every human-login surface (operator
 * panel, partner portal). 16-byte random salt, 32-byte key, stored as
 * `salthex:keyhex`. Verification is timing-safe. Plaintext is never stored,
 * logged, or echoed. Lifted from services/admin/opauth.ts so the portal and
 * the panel share one hardened implementation.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const KEY_LEN = 32

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, KEY_LEN)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, keyHex] = stored.split(':')
  if (!saltHex || !keyHex) return false
  const expected = Buffer.from(keyHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_LEN)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** One-way digest for single-use invite/claim tokens — the plaintext token
 * is shown exactly once; only this hash is ever persisted. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
