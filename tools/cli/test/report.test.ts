import { describe, expect, it } from 'vitest'
import { extractAuthSchemes, mapToCti } from '../src/scan/cti.js'
import { renderReport, renderSummary, verdictFor } from '../src/scan/report.js'
import type { ScanResult } from '../src/scan/types.js'
import { exchangeSpec } from './fixtures/exchange-openapi.js'

function makeResult(): ScanResult {
  return {
    domain: 'acme.exchange',
    scannedAt: '2026-07-14T09:00:00.000Z',
    site: {
      finalUrl: 'https://www.acme.exchange/',
      status: 200,
      server: 'cloudflare',
      poweredBy: null,
      csp: {
        reportOnly: false,
        scriptDirective: 'script-src',
        restrictsScripts: true,
        allowsUnsafeInline: false,
        scriptHosts: ['https://cdn.acme.exchange'],
      },
      framework: { name: 'next.js', evidence: '__NEXT_DATA__ bootstrap script' },
      title: 'Acme Exchange — Trade Crypto',
      locales: ['en', 'de-de'],
    },
    robots: {
      fetched: true,
      sitemaps: ['https://acme.exchange/sitemap.xml'],
      apiDisallows: ['/api/internal/'],
      disallowCount: 4,
    },
    spec: {
      url: 'https://api.acme.exchange/openapi.json',
      version: 'OpenAPI 3.0.1',
      title: 'Acme Exchange Spot API',
      pathCount: 6,
    },
    probes: [
      {
        url: 'https://acme.exchange/openapi.json',
        status: 404,
        contentType: 'text/html',
        note: null,
      },
      {
        url: 'https://api.acme.exchange/openapi.json',
        status: 200,
        contentType: 'application/json',
        note: 'spec found',
      },
    ],
    capabilities: mapToCti(exchangeSpec),
    authSchemes: extractAuthSchemes(exchangeSpec),
  }
}

describe('integration report rendering', () => {
  const result = makeResult()
  const report = renderReport(result)

  it('renders every required section in order', () => {
    const sections = [
      '# Hippo Integration Scan — acme.exchange',
      '## Site profile',
      '## API surface',
      '## CTI capability map',
      '## Gaps',
      '## Verdict',
    ]
    let cursor = -1
    for (const section of sections) {
      const at = report.indexOf(section)
      expect(at, `missing or out of order: ${section}`).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('renders the site profile facts', () => {
    expect(report).toContain('| Framework | next.js — `__NEXT_DATA__ bootstrap script` |')
    expect(report).toContain('| Locales | en, de-de |')
    expect(report).toContain('Allowed script hosts: https://cdn.acme.exchange.')
    expect(report).toContain("Hippo's script host must be allow-listed")
  })

  it('renders the API surface with spec location and auth schemes', () => {
    expect(report).toContain('`https://api.acme.exchange/openapi.json` — OpenAPI 3.0.1')
    expect(report).toContain('apiKey (apiKey, header:X-ACME-APIKEY)')
    expect(report).toContain('`/api/internal/`')
  })

  it('renders the capability table with found endpoints and GAP rows', () => {
    expect(report).toContain('| Quote / ticker | Found | `GET /api/v3/ticker/price` |')
    expect(report).toContain('| Order placement | Found | `POST /api/v3/order` |')
    expect(report).toContain('| Positions | GAP | — |')
    expect(report).toContain('| Webhooks (order lifecycle events) | GAP | — |')
  })

  it('lists gaps with plain-words consequences', () => {
    expect(report).toContain(
      '- **Webhooks (order lifecycle events)** — No webhook surface found → lifecycle updates would use polling reconciliation.',
    )
  })

  it('renders the verdict line and the hippo init footer', () => {
    expect(report).toContain(
      '**Integration readiness: High** — 6 of 8 Canonical Trading Interface capabilities matched',
    )
    expect(report.trimEnd().endsWith('delivered as a reviewable PR._')).toBe(true)
    expect(report).toContain('run `hippo init` inside the repo')
  })

  it('renders a compact stdout summary', () => {
    const summary = renderSummary(result)
    expect(summary).toContain('hippo scan — acme.exchange')
    expect(summary).toContain('CSP restricts scripts')
    expect(summary).toContain('6/8 capabilities matched')
    expect(summary).toContain('gaps: Positions, Webhooks (order lifecycle events)')
    expect(summary).toContain('Verdict   Integration readiness: High')
  })

  it('contains no debug noise', () => {
    expect(report).not.toMatch(/undefined|\[object Object\]|NaN/)
  })
})

describe('verdict thresholds', () => {
  const caps = (found: number) =>
    mapToCti({}).map((c, i) => ({
      ...c,
      status: i < found ? ('found' as const) : ('gap' as const),
    }))

  it('maps matched-capability counts to High/Medium/Low', () => {
    expect(verdictFor(caps(8)).level).toBe('High')
    expect(verdictFor(caps(6)).level).toBe('High')
    expect(verdictFor(caps(5)).level).toBe('Medium')
    expect(verdictFor(caps(3)).level).toBe('Medium')
    expect(verdictFor(caps(2)).level).toBe('Low')
    expect(verdictFor(caps(0)).level).toBe('Low')
  })
})

describe('no-spec report', () => {
  it('is explicit that the map reflects discoverability, not the venue API', () => {
    const result: ScanResult = {
      ...makeResult(),
      spec: null,
      capabilities: mapToCti({}),
      authSchemes: [],
    }
    const report = renderReport(result)
    expect(report).toContain('**No machine-readable API spec found.**')
    expect(report).toContain('**Integration readiness: Low** — 0 of 8')
  })
})
