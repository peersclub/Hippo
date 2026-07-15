import { SimVenueAdapter } from '@hippo/seam'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inProcessDriver } from '../src/conform/in-process-driver.js'
import { runConformance } from '../src/conform/suite.js'

/**
 * Dogfood: the conformance suite graded against the REAL SimVenueAdapter (not a
 * mock). This is the point of a verifier — it certifies production adapter code
 * against the CTI contract, and is the same battery a generated adapter will
 * face. Only the adapter's market-data quote is stubbed; everything else is the
 * shipping adapter.
 */
describe('dogfood — SimVenueAdapter is CTI-conformant', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/v1/snapshot'))
          return new Response(JSON.stringify({ last: 61_240 }), { status: 200 })
        return new Response('not found', { status: 404 })
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('passes every conformance check', async () => {
    const adapter = new SimVenueAdapter({ fillDelayMs: 10 })
    const driver = inProcessDriver(adapter, 'sim venue (in-process)')
    const report = await runConformance(driver, { lifecycleTimeoutMs: 300, pollMs: 10 })

    if (report.verdict.level !== 'Conformant') {
      // Surface which checks regressed, so a failure names the offender.
      const bad = report.checks.filter((c) => c.status !== 'pass')
      throw new Error(
        `not conformant: ${bad.map((c) => `${c.id}(${c.status}: ${c.detail})`).join('; ')}`,
      )
    }
    expect(report.verdict.level).toBe('Conformant')
    expect(report.verdict.passed).toBe(report.verdict.total)
  })
})
