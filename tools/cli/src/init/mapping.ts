/**
 * Stage 4a of `hippo init` (Build Plan/05) — the `mapping.ts` generator.
 *
 * Every data-returning op the draft config flagged `needsMappingCode` gets a
 * typed function stub that transforms a venue API response into the CTI
 * display shape the SDK renders (PreparedTicket, LifecycleEvent, Portfolio,
 * …). This module emits the DETERMINISTIC scaffolding only: a self-contained,
 * compilable TypeScript module with one stub per op, each carrying a `// TODO`
 * and a pointer at the hand-built Assetworks adapter as the reference pattern.
 *
 * The actual synthesis of a mapping BODY is Open Decision #3 (frontier
 * codegen, needs model access) and is deliberately NOT done here. It sits
 * behind the `synthesizeMappingBody()` seam below, which today returns a
 * throwing stub so the generated module typechecks and fails loudly if it is
 * ever shipped unimplemented. Wiring a model into that one function is the
 * whole of the remaining stage-4 work.
 */
import type { CapabilityId } from '../scan/types.js'
import type { AdapterConfig } from './types.js'

/** One CTI display shape the generated module can target. */
type TargetName =
  | 'Quote'
  | 'PreparedTicket'
  | 'LifecycleEvent'
  | 'PositionRow'
  | 'OpenOrder'
  | 'Portfolio'
  | 'Instrument'

interface CapabilityTarget {
  /** Generated function name, unique per capability. */
  fn: string
  /** TypeScript return type the function maps into. */
  returnType: string
  /** CTI shape declarations the return type depends on. */
  needs: TargetName[]
  /** Where to look in the Assetworks adapter for the equivalent transform. */
  referenceHint: string
}

/**
 * Which capabilities map to which CTI display shape. Only data-returning ops
 * appear here — pure actions (cancel) and event surfaces (webhooks) never get
 * a mapping function, which is exactly what `needsMappingCode` already encodes.
 */
const CAPABILITY_TARGETS: Partial<Record<CapabilityId, CapabilityTarget>> = {
  quote: {
    fn: 'mapQuote',
    returnType: 'Quote',
    needs: ['Quote'],
    referenceHint: 'quote() feeds the est. price row that prepare() renders',
  },
  orderPlacement: {
    fn: 'mapOrderTicket',
    returnType: 'PreparedTicket',
    needs: ['PreparedTicket'],
    referenceHint: 'prepare() assembles the ticket rows the SDK renders verbatim',
  },
  orderStatus: {
    fn: 'mapLifecycle',
    returnType: 'LifecycleEvent',
    needs: ['LifecycleEvent'],
    referenceHint: 'mapStatus() + emitFilled() turn a venue status into a LifecyclePhase',
  },
  positions: {
    fn: 'mapPositions',
    returnType: 'Portfolio',
    needs: ['PositionRow', 'OpenOrder', 'Portfolio'],
    referenceHint: 'portfolio() maps balances/positions into PositionRow[]',
  },
  balances: {
    fn: 'mapBalances',
    returnType: 'Portfolio',
    needs: ['PositionRow', 'OpenOrder', 'Portfolio'],
    referenceHint: 'portfolio() maps non-zero balances into PositionRow[]',
  },
  instruments: {
    fn: 'mapInstruments',
    returnType: 'Instrument[]',
    needs: ['Instrument'],
    referenceHint: 'exchange-info → tradable catalog with precision and size limits',
  },
}

export interface MappingOp {
  capability: CapabilityId
  label: string
  /** Discovered venue endpoint, e.g. "POST /api/v3/order". */
  endpoint: string
  fn: string
  returnType: string
  referenceHint: string
}

export interface MappingModule {
  venue: string
  ops: MappingOp[]
  /** Distinct CTI shape declarations to emit, in canonical order. */
  targets: TargetName[]
}

/** Canonical emission order so the generated file is stable across runs. */
const TARGET_ORDER: TargetName[] = [
  'Quote',
  'PreparedTicket',
  'LifecycleEvent',
  'PositionRow',
  'OpenOrder',
  'Portfolio',
  'Instrument',
]

/**
 * Deterministically turn a draft AdapterConfig into a mapping-module plan: one
 * MappingOp per `needsMappingCode` op, plus the set of CTI shapes those ops
 * reference. Pure — no model involved.
 */
export function draftMapping(config: AdapterConfig): MappingModule {
  const ops: MappingOp[] = []
  const targets = new Set<TargetName>()

  for (const op of config.operations) {
    if (!op.needsMappingCode || op.endpoint === null) continue
    const target = CAPABILITY_TARGETS[op.capability]
    if (!target) continue
    ops.push({
      capability: op.capability,
      label: op.label,
      endpoint: op.endpoint,
      fn: target.fn,
      returnType: target.returnType,
      referenceHint: target.referenceHint,
    })
    for (const t of target.needs) targets.add(t)
  }

  return {
    venue: config.venue,
    ops,
    targets: TARGET_ORDER.filter((t) => targets.has(t)),
  }
}

// ── The frontier-codegen seam (Open Decision #3) ──────────────────────────
/**
 * SEAM: where a frontier model eventually synthesizes the transform body.
 *
 * Given the venue response schema and the CTI target shape, a model call would
 * return the body of the mapping function. We do NOT call a model here — this
 * batch is deterministic and testable. Until that lands, we emit a stub that
 * throws, so the generated module compiles yet fails loudly rather than
 * silently returning a wrong shape if shipped unimplemented.
 *
 * Returns the function body only (indented two spaces), without braces.
 */
export function synthesizeMappingBody(op: MappingOp): string {
  return `  // TODO(hippo:stage4): map the ${op.endpoint} response into ${op.returnType}.
  // A frontier model fills this in (Open Decision #3); see synthesizeMappingBody().
  throw new Error('${op.fn}: venue→CTI mapping not implemented yet (hippo init stage 4)')`
}

// ── TypeScript rendering ──────────────────────────────────────────────────
// The emitted module is self-contained: it declares the CTI display shapes it
// targets (mirroring services/seam/src/types.ts) so it typechecks on its own,
// before the partner repo wires it against `@hippo/seam`.

const TARGET_DECLS: Record<TargetName, string> = {
  Quote: `export interface Quote {
  instrument: string
  last: string
  asOf: string
}`,
  PreparedTicket: `export interface PreparedTicket {
  ticketId: string
  side: 'buy' | 'sell'
  instrument: string
  orderType: 'market' | 'limit'
  sideLabel: string
  rows: Array<{ label: string; value: string }>
}`,
  LifecycleEvent: `export interface LifecycleEvent {
  ticketId: string
  phase: 'awaiting_confirm' | 'filled' | 'partial' | 'cancelled' | 'expired'
  statusLine: string
  venueOrderId?: string
  fillPct?: number
  rows?: Array<{ label: string; value: string }>
}`,
  PositionRow: `export interface PositionRow {
  instrument: string
  size: string
  entry: string
  mark: string
  pnl: string
  tone: 'pos' | 'neg' | 'neutral'
}`,
  OpenOrder: `export interface OpenOrder {
  orderId: string
  side: 'buy' | 'sell'
  summary: string
  status: string
}`,
  Portfolio: `export interface Portfolio {
  positions: PositionRow[]
  openOrders: OpenOrder[]
}`,
  Instrument: `export interface Instrument {
  symbol: string
  base: string
  quote: string
  pricePrecision?: number
  sizePrecision?: number
}`,
}

export function renderMappingTs(module: MappingModule): string {
  const lines: string[] = []
  const push = (...ls: string[]) => lines.push(...ls)

  push(
    `/**`,
    ` * Venue → CTI response mapping for ${module.venue}.`,
    ` *`,
    ` * Generated by \`hippo init\` (stage 4). One function per data-returning op`,
    ` * whose venue response shape diverges from the Canonical Trading Interface.`,
    ` * Each is a compilable stub that THROWS until implemented — reference the`,
    ` * hand-built adapter at services/seam/src/koinbx-venue.ts for the pattern.`,
    ` */`,
    '',
  )

  if (module.ops.length === 0) {
    push(
      '// No data-returning ops need response mapping for this venue.',
      '// (Every mapped capability already matches the CTI shape, or is a pure action.)',
      'export {}',
      '',
    )
    return lines.join('\n')
  }

  push('// ── CTI display shapes (mirror services/seam/src/types.ts) ──')
  for (const t of module.targets) {
    push(TARGET_DECLS[t], '')
  }

  push(
    '// The raw venue response. `unknown` until the venue response schema is wired',
    '// in; narrow it inside each function as you implement the transform.',
    'export type VenueResponse = unknown',
    '',
    '// ── Mapping functions (one per data-returning op) ──',
  )

  for (const op of module.ops) {
    push(
      '',
      '/**',
      ` * ${op.label} — venue endpoint: ${op.endpoint}`,
      ` * Transforms the venue response into the CTI \`${op.returnType}\` shape.`,
      ' *',
      ' * TODO(hippo:stage4): implement. Reference pattern —',
      ` * services/seam/src/koinbx-venue.ts (${op.referenceHint}).`,
      ' */',
      `export function ${op.fn}(raw: VenueResponse): ${op.returnType} {`,
      synthesizeMappingBody(op),
      '}',
    )
  }

  push('')
  return lines.join('\n')
}
