/**
 * Request signing verification — the exact inverse of what the parasite's
 * venue adapter computes. The adapter signs:
 *
 *   x-signature = hex( HMAC-SHA256( bodyJSON + timestamp, secret ) )
 *
 * with `bodyJSON` byte-identical to the request body it sends, and
 * `x-timestamp` an ISO 8601 string. We must verify against the RAW body bytes,
 * never a re-serialization — a re-`JSON.stringify` can reorder keys or change
 * spacing and silently break a correct signature. Fastify hands us the raw
 * buffer via a content-type parser (see service.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** apiKey → the secret it signs with, and the userId it is scoped to (the
 *  venue binds identity to the key server-side, exactly like the pilot). */
export type ApiKeyRecord = { secret: string; userId: string }

/** Clock skew tolerated on x-timestamp. A real venue rejects stale signatures
 *  to blunt replay; 5 min is generous for a local test host. */
const MAX_SKEW_MS = 5 * 60_000

export type VerifyResult = { ok: true; userId: string } | { ok: false; code: number; error: string }

export function verifySignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  keys: Map<string, ApiKeyRecord>,
): VerifyResult {
  const apiKey = str(headers['x-api-key'])
  const timestamp = str(headers['x-timestamp'])
  const signature = str(headers['x-signature'])
  if (!apiKey || !timestamp || !signature)
    return { ok: false, code: 401, error: 'missing x-api-key / x-timestamp / x-signature' }

  const record = keys.get(apiKey)
  if (!record) return { ok: false, code: 401, error: 'unknown api key' }

  const ts = Date.parse(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS)
    return { ok: false, code: 401, error: 'timestamp missing or outside allowed skew' }

  const expected = createHmac('sha256', record.secret)
    .update(rawBody + timestamp)
    .digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, code: 401, error: 'bad signature' }

  return { ok: true, userId: record.userId }
}

function str(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v : ''
}
