import { describe, expect, it } from 'vitest'
import type { CheckResult, ConformanceReport } from '../src/conform/types.js'
import { draftAdapterConfig } from '../src/init/config.js'
import {
  composeVerification,
  renderVerificationReport,
  renderVerificationSummary,
} from '../src/init/verify.js'
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
      csp: {
        reportOnly: false,
        scriptDirective: 'script-src',
        restrictsScripts: true,
        allowsUnsafeInline: false,
        scriptHosts: ['https://static.acme.exchange'],
      },
      framework: { name: 'next.js', evidence: '__NEXT_DATA__' },
      title: 'Acme Exchange',
      locales: ['en'],
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

function conformFixture(level: ConformanceReport['verdict']['level']): ConformanceReport {
  const pass = (id: CheckResult['id'], label: string): CheckResult => ({
    id,
    label,
    status: 'pass',
    detail: 'observed the contracted behaviour',
    consequence: '—',
  })
  const checks: CheckResult[] = [
    pass('prepare-market', 'Prepare a market ticket'),
    pass('prepare-limit', 'Prepare a limit ticket'),
    pass('ticket-display-strings', 'Tickets carry display strings'),
    pass('reject-bad-size', 'Reject a bad size'),
  ]
  if (level !== 'Conformant') {
    checks.push({
      id: 'confirm-lifecycle',
      label: 'Confirm reaches a terminal phase',
      status: 'fail',
      detail: 'no lifecycle event arrived after confirm',
      consequence: 'traders confirm an order and never learn whether it filled.',
    })
    checks.push({
      id: 'cancel-postconfirm',
      label: 'Cancel after confirm',
      status: 'skip',
      detail: 'skipped — confirm never completed',
      consequence: 'a resting order cannot be pulled back.',
    })
  }
  const passed = checks.filter((c) => c.status === 'pass').length
  const failed = checks.filter((c) => c.status === 'fail').length
  const skipped = checks.filter((c) => c.status === 'skip').length
  return {
    target: 'acme venue (in-process)',
    ranAt: '2026-07-15T00:00:00.000Z',
    checks,
    verdict: { level, passed, failed, skipped, total: checks.length },
  }
}

/** Mimic the command's JSON-file transport: what survives a round-trip is what verify sees. */
const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('composeVerification — all three stages supplied', () => {
  const scan = viaJson(scanFromFixture())
  const config = viaJson(draftAdapterConfig(scanFromFixture()))
  const report = composeVerification({
    scan,
    config,
    conform: viaJson(conformFixture('Conformant')),
    now: '2026-07-16T00:00:00.000Z',
  })

  it('names the venue and marks every stage as supplied', () => {
    expect(report.venue).toBe('acme.exchange')
    expect(report.stages.map((s) => s.present)).toEqual([true, true, true])
  })

  it('is Almost ready — conformant, but the config still has gaps and stub mappings', () => {
    expect(report.verdict.level).toBe('Almost ready')
    expect(report.verdict.reasons.join(' ')).toMatch(/no venue endpoint/)
    expect(report.verdict.reasons.join(' ')).toMatch(/stubs/)
  })

  it('carries the discovery CSP restriction and config gaps as stage gaps', () => {
    const [discovery, adapter, conformance] = report.stages
    expect(discovery.gaps.join(' ')).toContain('CSP restricts')
    expect(adapter.gaps.join(' ')).toContain('`positions` has no discovered endpoint')
    expect(conformance.gaps).toEqual([])
  })

  it('derives next actions from the gaps, in stage order', () => {
    const joined = report.nextActions.join('\n')
    expect(joined).toContain("Allow-list Hippo's script host")
    expect(joined).toContain('Close the capability gaps with the venue: `positions`, `webhooks`.')
    expect(joined).toContain('Implement the mapping.ts stubs')
    expect(joined).not.toContain('hippo conform') // conformance is clean
  })
})

describe('composeVerification — verdict boundaries', () => {
  it('is Ready only when all stages are supplied, gap-free and Conformant', () => {
    const scan = viaJson(scanFromFixture())
    const config = viaJson(draftAdapterConfig(scanFromFixture()))
    config.gaps = []
    config.needsMappingCode = []
    const cleanScan: ScanResult = {
      ...scan,
      site: { ...scan.site, csp: null },
      capabilities: scan.capabilities.map((c) => ({ ...c, status: 'found' as const })),
    }
    const report = composeVerification({
      scan: cleanScan,
      config,
      conform: viaJson(conformFixture('Conformant')),
    })
    expect(report.verdict.level).toBe('Ready')
    expect(report.nextActions).toEqual([
      'Open the integration PR for partner + Hippo sign-off — the required human gate before anything ships.',
    ])
  })

  it('is Not ready when the conformance report is missing — an unverified adapter never ships', () => {
    const report = composeVerification({ scan: viaJson(scanFromFixture()) })
    expect(report.verdict.level).toBe('Not ready')
    expect(report.verdict.reasons.join(' ')).toContain('conformance suite')
    expect(report.nextActions.join(' ')).toContain('hippo conform --json')
  })

  it('is Not ready on a Non-conformant report, and lists the failing checks', () => {
    const report = composeVerification({ conform: viaJson(conformFixture('Non-conformant')) })
    expect(report.venue).toBe('acme venue (in-process)')
    expect(report.verdict.level).toBe('Not ready')
    const conformance = report.stages[2]
    expect(conformance.gaps.join(' ')).toContain('Confirm reaches a terminal phase (FAIL)')
    expect(report.nextActions.join(' ')).toContain('Confirm reaches a terminal phase')
  })

  it('is Almost ready on Partial conformance with an otherwise clean config', () => {
    const config = viaJson(draftAdapterConfig(scanFromFixture()))
    config.gaps = []
    config.needsMappingCode = []
    const report = composeVerification({
      scan: viaJson(scanFromFixture()),
      config,
      conform: viaJson(conformFixture('Partial')),
    })
    expect(report.verdict.level).toBe('Almost ready')
    expect(report.verdict.reasons.join(' ')).toContain('Partial')
  })

  it('flags missing stages as not supplied without inventing gaps for them', () => {
    const report = composeVerification({ conform: viaJson(conformFixture('Conformant')) })
    const [discovery, adapter] = report.stages
    expect(discovery.present).toBe(false)
    expect(adapter.present).toBe(false)
    expect(discovery.gaps).toEqual([])
    expect(report.verdict.level).toBe('Almost ready')
    expect(report.nextActions.join(' ')).toContain('hippo scan <domain> --json')
  })
})

describe('renderVerificationReport / renderVerificationSummary', () => {
  const report = composeVerification({
    scan: viaJson(scanFromFixture()),
    config: viaJson(draftAdapterConfig(scanFromFixture())),
    conform: viaJson(conformFixture('Non-conformant')),
    now: '2026-07-16T12:00:00.000Z',
  })
  const md = renderVerificationReport(report)

  it('renders the header, verdict, stage table, gaps and numbered next actions', () => {
    expect(md).toContain('# Hippo Integration Verification — acme.exchange')
    expect(md).toContain('· 2026-07-16 ·')
    expect(md).toContain('**Not ready**')
    expect(md).toContain('| Stage | Supplied | Summary |')
    expect(md).toContain('| Discovery | Yes |')
    expect(md).toContain('## Gaps')
    expect(md).toContain('**Conformance**')
    expect(md).toMatch(/## Next actions\n\n1\. /)
    expect(md).toContain('Human sign-off (partner + Hippo) is a required gate')
  })

  it('renders "None" gaps for a fully clean report', () => {
    const clean = composeVerification({ conform: viaJson(conformFixture('Conformant')) })
    expect(renderVerificationReport(clean)).toContain('None — every supplied stage is clean.')
  })

  it('summary lines up stage rows and the verdict', () => {
    const s = renderVerificationSummary(report)
    expect(s).toContain('hippo verify — acme.exchange')
    expect(s).toContain('Discovery')
    expect(s).toContain('Conformance')
    expect(s).toMatch(/Verdict {5}Not ready/)
  })
})
