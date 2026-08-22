import { describe, expect, it } from 'vitest'
import { hitRateDisplay } from '../src/metrics-format.js'

describe('hitRateDisplay', () => {
  // Regression: a fresh boot used to render "0%" — indistinguishable from a
  // total cache failure. No traffic anywhere must render as no data (null).
  it('renders no-data (null), not 0%, when there has been no cache traffic', () => {
    // Intelligence up, nothing asked yet: hitRate 0, gateway counters 0.
    expect(
      hitRateDisplay({ entries: 0, hitRate: 0 }, { hits: 0, misses: 0, hitRate: null }),
    ).toEqual({ rate: null, fromGateway: false })
    // Gateway-only fallback with no traffic (server sends hitRate null).
    expect(hitRateDisplay(undefined, { hits: 0, misses: 0, hitRate: null })).toEqual({
      rate: null,
      fromGateway: false,
    })
    // Both services down entirely.
    expect(hitRateDisplay(undefined, undefined)).toEqual({ rate: null, fromGateway: false })
  })

  it('a genuine 0% (all misses) still renders as 0, not as no-data', () => {
    expect(
      hitRateDisplay({ entries: 3, hitRate: 0 }, { hits: 0, misses: 7, hitRate: 0 }),
    ).toEqual({ rate: 0, fromGateway: false })
    expect(hitRateDisplay(undefined, { hits: 0, misses: 7, hitRate: 0 })).toEqual({
      rate: 0,
      fromGateway: true,
    })
  })

  it('intelligence-side stats win over the gateway fallback', () => {
    expect(
      hitRateDisplay({ entries: 10, hitRate: 0.8 }, { hits: 1, misses: 9, hitRate: 0.1 }),
    ).toEqual({ rate: 0.8, fromGateway: false })
  })

  it('falls back to the gateway counter and labels it', () => {
    expect(hitRateDisplay(undefined, { hits: 3, misses: 1, hitRate: 0.75 })).toEqual({
      rate: 0.75,
      fromGateway: true,
    })
  })
})
