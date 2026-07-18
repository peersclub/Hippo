import { describe, expect, it } from 'vitest'
import { registerSandbox, renderRegisterText } from '../src/register/run.js'

const REGISTER_RESPONSE = {
  partnerId: 'new-venue-a1b2',
  partnerKey: 'pk_sandbox_abc123',
  status: 'sandbox',
  claimPath: '/v1/provision/claim/tok123',
  claimExpiresInS: 900,
}

function stubFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (url: unknown) => {
    for (const [needle, make] of Object.entries(handlers)) {
      if (String(url).includes(needle)) return make()
    }
    throw new Error(`unexpected fetch: ${String(url)}`)
  }) as typeof fetch
}

describe('hippo register', () => {
  it('provisions and returns the claim URL without the secret', async () => {
    const fetchImpl = stubFetch({
      '/v1/provision/sandbox': () =>
        new Response(JSON.stringify(REGISTER_RESPONSE), { status: 200 }),
    })
    const r = await registerSandbox(
      { apiUrl: 'http://localhost:8794/', email: 'a@b.co', venueName: 'New Venue' },
      fetchImpl,
    )
    expect(r).toMatchObject({
      ok: true,
      partnerId: 'new-venue-a1b2',
      partnerKey: 'pk_sandbox_abc123',
      claimUrl: 'http://localhost:8794/v1/provision/claim/tok123',
    })
    if (r.ok) expect(r.jwtSecret).toBeUndefined()
    // Human rendering points at a one-time curl, never the secret itself.
    const text = renderRegisterText(r)
    expect(text).toContain('curl http://localhost:8794/v1/provision/claim/tok123')
    expect(text).toContain('ONCE')
  })

  it('--claim fetches the secret exactly once and renders the vault warning', async () => {
    let claims = 0
    const fetchImpl = stubFetch({
      '/v1/provision/claim/': () => {
        claims += 1
        return new Response(JSON.stringify({ partnerId: 'x', jwtSecret: 's3cr3t'.repeat(8) }), {
          status: 200,
        })
      },
      '/v1/provision/sandbox': () =>
        new Response(JSON.stringify(REGISTER_RESPONSE), { status: 200 }),
    })
    const r = await registerSandbox(
      { apiUrl: 'http://localhost:8794', email: 'a@b.co', venueName: 'New Venue', claim: true },
      fetchImpl,
    )
    expect(claims).toBe(1)
    expect(r.ok && r.jwtSecret).toBeTruthy()
    expect(renderRegisterText(r)).toContain('store it in your vault')
  })

  it('surfaces API errors (rate limit) and unreachable hosts honestly', async () => {
    const limited = await registerSandbox(
      { apiUrl: 'http://x', email: 'a@b.co', venueName: 'V V' },
      stubFetch({
        '/v1/provision/sandbox': () =>
          new Response(JSON.stringify({ error: 'provisioning rate limit — try again later' }), {
            status: 429,
          }),
      }),
    )
    expect(limited).toMatchObject({ ok: false, status: 429 })

    const down = await registerSandbox(
      { apiUrl: 'http://localhost:1', email: 'a@b.co', venueName: 'V V' },
      (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    )
    expect(down.ok).toBe(false)
    if (!down.ok) expect(down.error).toContain('unreachable')
  })
})
