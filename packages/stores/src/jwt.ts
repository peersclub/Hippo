/**
 * Hand-rolled HS256 JWT on node:crypto — lifted verbatim from
 * services/gateway/src/plugins/auth.ts so the admin service can mint/verify
 * operator sessions with the same audited code path. The gateway continues to
 * own partner-token verification; this copy exists so services/admin does not
 * import from a service package.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function signJwtHS256(claims: Record<string, unknown>, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = b64url(Buffer.from(JSON.stringify(claims)))
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${sig}`
}

/** Verify signature + exp. Returns the claims, or null for any invalid token. */
export function verifyJwtHS256(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts as [string, string, string]
  const head = decodeJson(header)
  if (head?.alg !== 'HS256') return null
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest()
  const actual = Buffer.from(sig, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  const claims = decodeJson(payload)
  if (!claims) return null
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
  return claims
}
