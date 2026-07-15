import { describe, expect, it } from 'vitest'
import { draftAdapterConfig, renderAdapterConfigYaml } from '../src/init/config.js'
import { extractAuthSchemes, mapToCti } from '../src/scan/cti.js'
import type { ScanResult } from '../src/scan/types.js'
import { exchangeSpec } from './fixtures/exchange-openapi.js'

/** Build a ScanResult from the fixture through the real scan pipeline. */
function scanFromFixture(): ScanResult {
  return {
    domain: 'acme.exchange',
    scannedAt: '2026-07-15T00:00:00.000Z',
    site: {
      finalUrl: 'https://acme.exchange/',
      status: 200,
      server: null,
      poweredBy: null,
      csp: null,
      framework: { name: 'unknown', evidence: null },
      title: 'Acme Exchange',
      locales: [],
    },
    robots: null,
    spec: {
      url: 'https://api.acme.exchange/openapi.json',
      version: 'OpenAPI 3.0.1',
      title: 'Acme Exchange Spot API',
      pathCount: 6,
    },
    probes: [],
    capabilities: mapToCti(exchangeSpec),
    authSchemes: extractAuthSchemes(exchangeSpec),
  }
}

describe('draftAdapterConfig — from a scanned exchange spec', () => {
  const config = draftAdapterConfig(scanFromFixture())
  const op = (id: string) => config.operations.find((o) => o.capability === id)

  it('carries venue + base URL derived from the spec origin', () => {
    expect(config.venue).toBe('acme.exchange')
    expect(config.baseUrl).toBe('https://api.acme.exchange')
  })

  it('maps order placement to the discovered POST endpoint', () => {
    expect(op('orderPlacement')?.status).toBe('mapped')
    expect(op('orderPlacement')?.endpoint).toBe('POST /api/v3/order')
  })

  it('marks positions and webhooks as gaps (absent from a spot spec)', () => {
    expect(op('positions')?.status).toBe('gap')
    expect(op('webhooks')?.status).toBe('gap')
    expect(config.gaps.sort()).toEqual(['positions', 'webhooks'])
  })

  it('infers an HMAC signing strategy from the declared schemes', () => {
    expect(config.auth.strategy).toMatch(/hmac/i)
  })

  it('flags data-returning ops as needing mapping code, not pure actions', () => {
    expect(config.needsMappingCode).toContain('orderPlacement')
    expect(config.needsMappingCode).toContain('balances')
    expect(config.needsMappingCode).not.toContain('cancel') // pure action
    expect(config.needsMappingCode).not.toContain('positions') // it's a gap
  })
})

describe('renderAdapterConfigYaml', () => {
  const yaml = renderAdapterConfigYaml(draftAdapterConfig(scanFromFixture()))

  it('emits a mapped endpoint, a gap note, and the gaps list', () => {
    expect(yaml).toContain('venue: "acme.exchange"')
    expect(yaml).toContain('endpoint: "POST /api/v3/order"')
    expect(yaml).toContain('needsMappingCode: true')
    expect(yaml).toContain('status: gap')
    expect(yaml).toMatch(/gaps:\n {2}- positions\n {2}- webhooks/)
  })

  it('quotes values with slashes and never emits an unresolved base URL silently', () => {
    // baseUrl was derivable here, so no TODO placeholder
    expect(yaml).not.toContain('TODO: confirm the API base URL')
    expect(yaml).toContain('baseUrl: "https://api.acme.exchange"')
  })
})
