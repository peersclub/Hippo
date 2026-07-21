/**
 * Demo partner token mint — the piece a REAL partner runs on their own
 * backend. Signs a short-lived HS256 session JWT for the embed to present at
 * gateway mint (data-hippo-token-url → Authorization: Bearer). The partner
 * secret lives in the deployment env only; it never ships to the browser.
 *
 * Claims match what the gateway verifies (services/gateway auth plugin):
 *   iss — partner id (partner lookup)   sub — venue user id (required)
 *   exp — unix seconds (required)
 *
 * Each browser gets a stable random visitor id via cookie, so memory/persona
 * and MAU counting behave like distinct real users across the demo team.
 */
import { createHmac, randomUUID } from 'node:crypto'

type Req = { headers: Record<string, string | string[] | undefined> }
type Res = {
  status: (code: number) => Res
  json: (body: unknown) => void
  setHeader: (name: string, value: string) => void
}

const TOKEN_TTL_S = 15 * 60
const COOKIE = 'hippo_demo_uid'

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function signJwtHS256(claims: Record<string, unknown>, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = b64url(Buffer.from(JSON.stringify(claims)))
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${sig}`
}

export default function handler(req: Req, res: Res): void {
  const secret = process.env.HIPPO_DEMO_JWT_SECRET
  const partnerId = process.env.HIPPO_DEMO_PARTNER_ID ?? 'assetworks-demo'
  if (!secret) {
    // Fail loud, not with a forged token — the SDK treats 5xx as retryable.
    res.status(503).json({ error: 'token mint not configured' })
    return
  }

  const cookieHeader = req.headers.cookie
  const cookies = Array.isArray(cookieHeader) ? cookieHeader.join(';') : (cookieHeader ?? '')
  let sub = new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`).exec(cookies)?.[1]
  if (!sub) {
    sub = `demo-${randomUUID()}`
    res.setHeader(
      'set-cookie',
      `${COOKIE}=${sub}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly`,
    )
  }

  const now = Math.floor(Date.now() / 1000)
  const token = signJwtHS256({ iss: partnerId, sub, iat: now, exp: now + TOKEN_TTL_S }, secret)
  res.setHeader('cache-control', 'no-store')
  res.status(200).json({ token })
}
