/**
 * Operator authentication: scrypt password hashing + HS256 cookie sessions.
 *
 * Passwords: scrypt (node:crypto), 16-byte random salt, 32-byte key, stored
 * as `salthex:keyhex`. Verification is timing-safe. Plaintext is never
 * stored, logged, or echoed.
 *
 * Sessions: signed HS256 JWT (same hand-rolled implementation the gateway
 * uses for partner tokens, lifted into @hippo/stores) carried in an
 * httpOnly SameSite=Strict cookie — the SPA never touches the token.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { OperatorRole } from '@hippo/stores'
import { signJwtHS256, verifyJwtHS256 } from '@hippo/stores'

const KEY_LEN = 32
export const SESSION_COOKIE = 'hippo_admin'
export const SESSION_TTL_S = 8 * 60 * 60 // 8h

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

export type OperatorSession = { email: string; role: OperatorRole }

export function mintSessionToken(op: OperatorSession, secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  return signJwtHS256({ sub: op.email, role: op.role, iat: now, exp: now + SESSION_TTL_S }, secret)
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_S}`
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
}

/** Parse the operator session out of a Cookie header; null when absent/invalid. */
export function readSession(
  cookieHeader: string | undefined,
  secret: string,
): OperatorSession | null {
  if (!cookieHeader) return null
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (!match) return null
  const token = match.slice(SESSION_COOKIE.length + 1)
  const claims = verifyJwtHS256(token, secret)
  if (!claims || typeof claims.sub !== 'string') return null
  const role = claims.role === 'owner' ? 'owner' : 'operator'
  return { email: claims.sub, role }
}
