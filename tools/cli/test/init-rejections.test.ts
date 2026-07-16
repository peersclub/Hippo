import { describe, expect, it } from 'vitest'
import { classifyRejection, draftRejections, renderRejectionsYaml } from '../src/init/rejections.js'
import { extractAuthSchemes, extractErrorResponses, mapToCti } from '../src/scan/cti.js'
import type { ScanResult } from '../src/scan/types.js'
import { exchangeSpec } from './fixtures/exchange-openapi.js'

function scanFromFixture(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    domain: 'acme.exchange',
    scannedAt: '2026-07-15T00:00:00.000Z',
    site: {
      finalUrl: 'https://api.acme.exchange/',
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
    errorResponses: extractErrorResponses(exchangeSpec),
    ...overrides,
  }
}

describe('classifyRejection — deterministic status + keyword classification', () => {
  it('classifies by status code', () => {
    expect(classifyRejection('400', null)).toBe('invalid_request')
    expect(classifyRejection('401', null)).toBe('auth_failed')
    expect(classifyRejection('403', null)).toBe('auth_failed')
    expect(classifyRejection('404', null)).toBe('not_found')
    expect(classifyRejection('429', null)).toBe('rate_limited')
    expect(classifyRejection('500', null)).toBe('venue_error')
    expect(classifyRejection('default', null)).toBe('unknown')
  })

  it('lets description keywords win over the status code', () => {
    // A 400 that is really an affordability failure.
    expect(classifyRejection('400', 'Insufficient balance for this order')).toBe(
      'insufficient_funds',
    )
    expect(classifyRejection('400', 'Invalid request signature')).toBe('auth_failed')
  })
})

describe('draftRejections — from the scanned error responses', () => {
  const doc = draftRejections(scanFromFixture())
  const entry = (c: string) => doc.entries.find((e) => e.canonical === c)

  it('reports the venue documents errors', () => {
    expect(doc.documented).toBe(true)
  })

  it('maps documented statuses to canonical reasons with endpoints', () => {
    expect(entry('invalid_request')?.statuses).toContain('400')
    expect(entry('auth_failed')?.statuses).toEqual(['401'])
    expect(entry('auth_failed')?.endpoints).toContain('POST /api/v3/order')
    expect(entry('rate_limited')?.statuses).toEqual(['429'])
    expect(entry('not_found')?.statuses).toEqual(['404'])
  })

  it('attaches plain-words reason + fix, pointing auth at the KoinBX pattern', () => {
    expect(entry('auth_failed')?.fix).toContain('koinbx-venue.ts')
    expect(entry('invalid_request')?.reason.length).toBeGreaterThan(0)
  })

  it('flags a gap for an important reason the venue never documents', () => {
    // The fixture documents no insufficient-funds error.
    expect(doc.entries.some((e) => e.canonical === 'insufficient_funds')).toBe(false)
    expect(doc.gaps.some((g) => g.includes('insufficient_funds'))).toBe(true)
  })
})

describe('draftRejections — venue that documents no errors', () => {
  const doc = draftRejections(scanFromFixture({ errorResponses: [] }))

  it('flags the whole surface as a gap rather than inventing reasons', () => {
    expect(doc.documented).toBe(false)
    expect(doc.entries).toHaveLength(0)
    expect(doc.gaps).toHaveLength(1)
    expect(doc.gaps[0]).toContain('documents no error responses')
  })

  it('handles a scan with no errorResponses field at all (backward compatible)', () => {
    const noField = draftRejections(scanFromFixture({ errorResponses: undefined }))
    expect(noField.documented).toBe(false)
  })
})

describe('renderRejectionsYaml', () => {
  const yaml = renderRejectionsYaml(draftRejections(scanFromFixture()))

  it('emits venue, canonical reasons, statuses, and a gaps section', () => {
    expect(yaml).toContain('venue: "acme.exchange"')
    expect(yaml).toContain('documented: true')
    expect(yaml).toContain('auth_failed:')
    expect(yaml).toContain('venueStatuses:')
    expect(yaml).toContain('- "401"')
    expect(yaml).toContain('gaps:')
    expect(yaml).toMatch(/- "No documented error maps to \\"insufficient_funds\\"/)
  })

  it('renders an empty-map placeholder when no errors are documented', () => {
    const empty = renderRejectionsYaml(draftRejections(scanFromFixture({ errorResponses: [] })))
    expect(empty).toContain('rejections:')
    expect(empty).toContain('[] # no documented error responses to map')
  })

  it('contains no debug noise', () => {
    expect(yaml).not.toMatch(/undefined|\[object Object\]|NaN/)
  })
})
