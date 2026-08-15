import { describe, expect, it } from 'vitest'
import { healthPayload } from '../src/health.js'

describe('health payload (build provenance)', () => {
  it('reports sha + builtAt with the honest "unknown" fallback', () => {
    const body = healthPayload(true)
    expect(body).toMatchObject({ ok: true, service: 'market-data', mode: 'fixtures' })
    // Unstamped env must yield "unknown" — never a fabricated value.
    expect(body.sha).toBe(process.env.GIT_SHA || 'unknown')
    expect(body.builtAt).toBe(process.env.BUILT_AT || 'unknown')
  })

  it('reflects fixtures vs live mode', () => {
    expect(healthPayload(false).mode).toBe('live')
    expect(healthPayload(true).mode).toBe('fixtures')
  })
})
