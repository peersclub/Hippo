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
import type { OperatorRole } from '@hippo/stores'
import { signJwtHS256, verifyJwtHS256 } from '@hippo/stores'

export const SESSION_COOKIE = 'hippo_admin'
export const SESSION_TTL_S = 8 * 60 * 60 // 8h

// scrypt hashing lives in @hippo/stores (shared with the partner portal).
export { hashPassword, verifyPassword } from '@hippo/stores'

export type OperatorSession = { email: string; role: OperatorRole }

export function mintSessionToken(op: OperatorSession, secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  return signJwtHS256({ sub: op.email, role: op.role, iat: now, exp: now + SESSION_TTL_S }, secret)
}

export function sessionCookie(token: string): string {
  // Secure by default in production (opt out only with ADMIN_COOKIE_SECURE=0 for
  // an http-only deploy); off by default in dev, opt in with =1 for local https.
  const secure = cookieSecure() ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_S}${secure}`
}

function cookieSecure(): boolean {
  const flag = process.env.ADMIN_COOKIE_SECURE
  if (flag === '1') return true
  if (flag === '0') return false
  return process.env.NODE_ENV === 'production'
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
