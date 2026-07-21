import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { draftAdapterConfig } from '../src/init/config.js'
import { draftMapping, renderMappingTs, synthesizeMappingBody } from '../src/init/mapping.js'
import { extractAuthSchemes, extractErrorResponses, mapToCti } from '../src/scan/cti.js'
import type { ScanResult } from '../src/scan/types.js'
import { exchangeSpec } from './fixtures/exchange-openapi.js'

/** Build a ScanResult from the fixture through the real scan pipeline. */
function scanFromFixture(): ScanResult {
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
  }
}

/** Typecheck a generated module in isolation via the TypeScript compiler API. */
function typecheck(source: string): ts.Diagnostic[] {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-mapping-'))
  const file = join(dir, 'mapping.ts')
  try {
    writeFileSync(file, source, 'utf8')
    const program = ts.createProgram([file], {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    })
    return [...ts.getPreEmitDiagnostics(program)]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('draftMapping — from a drafted adapter config', () => {
  const config = draftAdapterConfig(scanFromFixture())
  const mapping = draftMapping(config)
  const fnFor = (cap: string) => mapping.ops.find((o) => o.capability === cap)

  it('emits one op per needsMappingCode capability, and only those', () => {
    const caps = mapping.ops.map((o) => o.capability).sort()
    expect(caps).toEqual(['balances', 'instruments', 'orderPlacement', 'orderStatus', 'quote'])
  })

  it('does not emit mapping ops for pure actions or gaps', () => {
    expect(fnFor('cancel')).toBeUndefined() // pure action
    expect(fnFor('positions')).toBeUndefined() // a gap in a spot spec
  })

  it('names functions and target shapes per capability', () => {
    expect(fnFor('orderPlacement')?.fn).toBe('mapOrderTicket')
    expect(fnFor('orderPlacement')?.returnType).toBe('PreparedTicket')
    expect(fnFor('orderStatus')?.fn).toBe('mapLifecycle')
    expect(fnFor('balances')?.returnType).toBe('Portfolio')
    expect(fnFor('instruments')?.returnType).toBe('Instrument[]')
  })

  it('carries the discovered endpoint onto each op', () => {
    expect(fnFor('orderPlacement')?.endpoint).toBe('POST /api/v3/order')
  })

  it('collects only the CTI shapes the emitted ops reference, in canonical order', () => {
    expect(mapping.targets).toEqual([
      'Quote',
      'PreparedTicket',
      'LifecycleEvent',
      'PositionRow',
      'OpenOrder',
      'Portfolio',
      'Instrument',
    ])
  })
})

describe('renderMappingTs — generated module', () => {
  const config = draftAdapterConfig(scanFromFixture())
  const source = renderMappingTs(draftMapping(config))

  it('is well-formed: a header, CTI shapes, and one exported stub per op', () => {
    expect(source).toContain('Venue → CTI response mapping for acme.exchange')
    expect(source).toContain('export interface PreparedTicket {')
    expect(source).toContain('export function mapOrderTicket(raw: VenueResponse): PreparedTicket {')
    expect(source).toContain('export function mapBalances(raw: VenueResponse): Portfolio {')
  })

  it('points every stub at the Assetworks reference pattern with a TODO', () => {
    expect(source).toContain('services/seam/src/koinbx-venue.ts')
    expect(source).toContain('TODO(hippo:stage4)')
  })

  it('emits stubs that throw until implemented', () => {
    expect(source).toContain(
      "throw new Error('mapOrderTicket: venue→CTI mapping not implemented yet (hippo init stage 4)')",
    )
  })

  // A full ts.createProgram run takes >5s on loaded CI runners — the default
  // vitest timeout made this the repo's standing flake. Generous budget: the
  // assertion is about diagnostics, not speed.
  it('TYPECHECKS as a standalone strict TypeScript module', { timeout: 30_000 }, () => {
    const diagnostics = typecheck(source)
    const messages = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    expect(messages, messages.join('\n')).toHaveLength(0)
  })
})

describe('renderMappingTs — no mapping needed', () => {
  it('emits a compilable, empty module when no op needs mapping code', () => {
    const empty = renderMappingTs({ venue: 'nomap.exchange', ops: [], targets: [] })
    expect(empty).toContain('No data-returning ops need response mapping')
    expect(empty).toContain('export {}')
    expect(typecheck(empty)).toHaveLength(0)
  })
})

describe('synthesizeMappingBody — the frontier-codegen seam', () => {
  it('returns a throwing stub referencing the op (no model called)', () => {
    const body = synthesizeMappingBody({
      capability: 'orderPlacement',
      label: 'Order placement',
      endpoint: 'POST /api/v3/order',
      fn: 'mapOrderTicket',
      returnType: 'PreparedTicket',
      referenceHint: 'prepare()',
    })
    expect(body).toContain('POST /api/v3/order')
    expect(body).toContain('throw new Error')
    expect(body).toContain('Open Decision #3')
  })
})
