/**
 * Partner-admin sessions for the portal. Deliberately a DIFFERENT cookie
 * name, secret, and claim shape from the operator panel — the two token
 * universes must never intersect: a stolen portal session cannot touch
 * operator routes, and vice versa.
 *
 * scrypt password hashing is shared via @hippo/stores.
 */
import type { PartnerAdminRole } from '@hippo/stores'
import { signJwtHS256, verifyJwtHS256 } from '@hippo/stores'

export const SESSION_COOKIE = 'hippo_portal'
export const SESSION_TTL_S = 8 * 60 * 60 // 8h

export type PortalSession = { email: string; partnerId: string; role: PartnerAdminRole }

export function mintSessionToken(session: PortalSession, secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  return signJwtHS256(
    {
      sub: session.email,
      pid: session.partnerId,
      role: session.role,
      iat: now,
      exp: now + SESSION_TTL_S,
    },
    secret,
  )
}

export function sessionCookie(token: string): string {
  // Secure by default in production (opt out with PORTAL_COOKIE_SECURE=0);
  // off by default in dev, opt in with =1 for local https.
  const secure = cookieSecure() ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_S}${secure}`
}

function cookieSecure(): boolean {
  const flag = process.env.PORTAL_COOKIE_SECURE
  if (flag === '1') return true
  if (flag === '0') return false
  return process.env.NODE_ENV === 'production'
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
}

/** Parse the portal session out of a Cookie header; null when absent/invalid.
 * A session without a partner id is invalid by definition — tenancy hangs
 * off this claim. */
export function readSession(
  cookieHeader: string | undefined,
  secret: string,
): PortalSession | null {
  if (!cookieHeader) return null
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (!match) return null
  const token = match.slice(SESSION_COOKIE.length + 1)
  const claims = verifyJwtHS256(token, secret)
  if (!claims || typeof claims.sub !== 'string' || typeof claims.pid !== 'string') return null
  const role = claims.role === 'viewer' ? 'viewer' : 'admin'
  return { email: claims.sub, partnerId: claims.pid, role }
}
