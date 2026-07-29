/**
 * Stage 4a of `hippo init` (Build Plan/05) — the `mapping.ts` generator.
 *
 * Every data-returning op the draft config flagged `needsMappingCode` gets a
 * typed function that transforms a venue API response into the CTI display
 * shape the SDK renders (PreparedTicket, LifecycleEvent, Portfolio, …).
 *
 * Two paths produce the file:
 *   - DETERMINISTIC (`draftMapping` + `renderMappingTs`): a self-contained,
 *     compilable module of throwing stubs, each carrying a `// TODO` and a
 *     pointer at the hand-built Assetworks adapter as the reference pattern.
 *   - MODEL-DRIVEN (`synthesizeMappingModule`, resolving Open Decision #3):
 *     per op, a frontier model is shown the venue's documented response shape
 *     next to the exact CTI target declaration and asked for the function
 *     BODY only. Every candidate is validated by rendering the full module
 *     and strict-typechecking it (`typecheckModule`); a failing candidate
 *     gets ONE retry with the diagnostics appended, then falls back to the
 *     throwing stub. Unconfigured or failing model → byte-identical stubs.
 */
import type { CapabilityId } from '../scan/types.js'
import type { LlmClient } from './llm.js'
import { typecheckModule } from './typecheck.js'
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
  /**
   * Compact documented success-response shape of the endpoint (threaded from
   * the scan via AdapterOperation). Absent → the venue documents no schema
   * and the synthesized mapping must be written defensively.
   */
  responseShape?: string
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
      ...(op.responseShape !== undefined ? { responseShape: op.responseShape } : {}),
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
 * The DETERMINISTIC fallback body: a stub that throws, so the generated
 * module compiles yet fails loudly rather than silently returning a wrong
 * shape if shipped unimplemented. This is what every op gets when no model is
 * configured, when the model call fails, and when a synthesized body fails
 * the strict typecheck twice. The model-driven path that resolves Open
 * Decision #3 lives in `synthesizeMappingModule` below.
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

/**
 * A function body to embed instead of the deterministic throwing stub, keyed
 * by function name in `renderMappingTs`. `synthesized: true` marks a
 * model-written, typecheck-validated body (the doc comment says so instead of
 * carrying a TODO); `false` keeps the stub doc comment — used when a failed
 * synthesis falls back to the stub with a note line prepended.
 */
export interface RenderedBody {
  /** Function body statements only, two-space indented, no braces. */
  body: string
  synthesized: boolean
}

export function renderMappingTs(
  module: MappingModule,
  bodies?: ReadonlyMap<string, RenderedBody>,
): string {
  const lines: string[] = []
  const push = (...ls: string[]) => lines.push(...ls)
  const anySynthesized = module.ops.some((op) => bodies?.get(op.fn)?.synthesized)

  push(
    `/**`,
    ` * Venue → CTI response mapping for ${module.venue}.`,
    ` *`,
    ` * Generated by \`hippo init\` (stage 4). One function per data-returning op`,
    ` * whose venue response shape diverges from the Canonical Trading Interface.`,
  )
  if (anySynthesized) {
    push(
      ` * Bodies marked "synthesized" were model-written and strict-typechecked;`,
      ` * review them before shipping. Any remaining stub THROWS until implemented`,
      ` * — reference the hand-built adapter at services/seam/src/assetworks-venue.ts.`,
    )
  } else {
    push(
      ` * Each is a compilable stub that THROWS until implemented — reference the`,
      ` * hand-built adapter at services/seam/src/assetworks-venue.ts for the pattern.`,
    )
  }
  push(` */`, '')

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
    const override = bodies?.get(op.fn)
    push(
      '',
      '/**',
      ` * ${op.label} — venue endpoint: ${op.endpoint}`,
      ` * Transforms the venue response into the CTI \`${op.returnType}\` shape.`,
      ' *',
    )
    if (override?.synthesized) {
      push(
        ' * Body synthesized by `hippo init` stage 4 (model) and validated by a',
        ' * strict standalone typecheck. Review before shipping; reference pattern —',
        ` * services/seam/src/assetworks-venue.ts (${op.referenceHint}).`,
      )
    } else {
      push(
        ' * TODO(hippo:stage4): implement. Reference pattern —',
        ` * services/seam/src/assetworks-venue.ts (${op.referenceHint}).`,
      )
    }
    push(
      ' */',
      `export function ${op.fn}(raw: VenueResponse): ${op.returnType} {`,
      override?.body ?? synthesizeMappingBody(op),
      '}',
    )
  }

  push('')
  return lines.join('\n')
}

// ── Model-driven synthesis (resolves Open Decision #3) ─────────────────────

/** A failed attempt fed back to the model on the single retry. */
export interface PreviousAttempt {
  body: string
  diagnostics: string[]
}

/**
 * The surgical per-op prompt: capability + endpoint + the venue's documented
 * response shape (or an explicit "undocumented — map defensively" note) +
 * the exact CTI declarations the generated module inlines + the fixed
 * function signature, then the hard rules. The model returns body STATEMENTS
 * only; everything structural is already fixed by the renderer.
 */
export function buildMappingPrompt(op: MappingOp, previous?: PreviousAttempt): string {
  const target = CAPABILITY_TARGETS[op.capability]
  const decls = (target?.needs ?? []).map((t) => TARGET_DECLS[t]).join('\n\n')

  const shape = op.responseShape
    ? `Documented venue response shape (from the venue's OpenAPI spec):\n${op.responseShape}`
    : 'The venue documents NO response schema for this endpoint. Write a defensive ' +
      'mapping: narrow `raw` step by step with typeof/optional checks and throw a ' +
      'descriptive Error naming the missing field when an expected field is absent.'

  const lines = [
    'You are completing one TypeScript function inside a generated venue-adapter mapping module for Hippo.',
    '',
    `Capability: ${op.capability} (${op.label})`,
    `Venue endpoint: ${op.endpoint}`,
    '',
    shape,
    '',
    'The module already declares (do NOT redeclare any of these):',
    'export type VenueResponse = unknown',
    '',
    decls,
    '',
    'Complete exactly this function by providing its body:',
    `export function ${op.fn}(raw: VenueResponse): ${op.returnType} {`,
    '  // your statements here',
    '}',
    '',
    'Hard rules:',
    '- Return ONLY the statements of the function body — no function signature, no surrounding braces, no imports, no new dependencies, no markdown fences, no prose.',
    '- `raw` is `unknown`: narrow it defensively (typeof checks, optional access) before reading any field. Do not use `any`.',
    '- Monetary and quantity values are strings in the CTI shapes — carry venue numbers through as strings (e.g. String(x)); never parse money to float.',
    `- When \`raw\` is missing what the mapping needs, throw new Error('${op.fn}: <what was wrong>') — never fabricate placeholder values.`,
    '- The body must compile under strict TypeScript with zero diagnostics.',
  ]

  if (previous) {
    lines.push(
      '',
      'A previous attempt failed the strict typecheck.',
      'Previous body:',
      previous.body,
      '',
      'TypeScript diagnostics:',
      ...previous.diagnostics.map((d) => `- ${d}`),
      '',
      'Fix the errors and return the corrected function body statements only.',
    )
  }

  return lines.join('\n')
}

/**
 * Normalize a model completion into embeddable body statements: strip
 * markdown fences and control bytes, unwrap an (unrequested) full function,
 * re-indent to the renderer's two-space base. Null when nothing usable
 * remains.
 */
export function extractBody(completion: string): string | null {
  let text = completion.replace(/\r/g, '')
  // Never let raw control bytes into generated source.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')

  // Prefer the first fenced block when the model wrapped the answer anyway.
  const fence = /```(?:[a-zA-Z]*)?\n([\s\S]*?)```/.exec(text)
  if (fence?.[1]) text = fence[1]
  text = text.trim()

  // Unwrap a full function definition down to its body statements.
  if (/^(export\s+)?function\b/.test(text)) {
    const open = text.indexOf('{')
    const close = text.lastIndexOf('}')
    if (open === -1 || close <= open) return null
    text = text.slice(open + 1, close).replace(/^\n+|\n+$/g, '')
  }
  if (text.length === 0) return null

  // Re-indent: strip the common leading indent, then apply the two-space base.
  const rawLines = text.split('\n')
  const indents = rawLines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0)
  const common = indents.length > 0 ? Math.min(...indents) : 0
  const body = rawLines.map((l) => (l.trim().length === 0 ? '' : `  ${l.slice(common)}`)).join('\n')
  return body.trim().length > 0 ? body : null
}

/** Per-op result of the synthesize→validate→retry→fallback loop. */
export interface SynthesisOutcome {
  fn: string
  capability: CapabilityId
  outcome: 'synthesized' | 'stubbed'
  /** Plain-words reason, e.g. "typechecked on first attempt". */
  detail: string
}

export interface SynthesizedMapping {
  module: MappingModule
  /** The rendered mapping.ts source (synthesized bodies where accepted). */
  source: string
  outcomes: SynthesisOutcome[]
}

const STUB_FALLBACK_NOTE = '  // stage4: model synthesis failed typecheck — stub kept'

/**
 * The async stage-4 path: per `needsMappingCode` op, ask the model for a
 * mapping body, validate by rendering the FULL module and running the same
 * strict standalone typecheck the test suite uses, retry once with the
 * diagnostics on failure, and fall back to the deterministic throwing stub
 * otherwise. With `client: null` (model unconfigured) the output is
 * byte-identical to the deterministic `renderMappingTs(draftMapping(config))`.
 *
 * `typecheck` is injectable for hermetic tests; production uses the real
 * `typecheckModule`.
 */
export async function synthesizeMappingModule(
  config: AdapterConfig,
  client: LlmClient | null,
  typecheck: (source: string) => string[] = typecheckModule,
): Promise<SynthesizedMapping> {
  const module = draftMapping(config)
  const bodies = new Map<string, RenderedBody>()
  const outcomes: SynthesisOutcome[] = []
  const stubbed = (op: MappingOp, detail: string) =>
    outcomes.push({ fn: op.fn, capability: op.capability, outcome: 'stubbed', detail })

  for (const op of module.ops) {
    if (!client) {
      stubbed(op, 'model not configured (set LLM_BASE_URL and LLM_MODEL)')
      continue
    }

    /** Validate a candidate inside the full module; empty array = accepted. */
    const validate = (body: string): string[] => {
      bodies.set(op.fn, { body, synthesized: true })
      const diagnostics = typecheck(renderMappingTs(module, bodies))
      if (diagnostics.length > 0) bodies.delete(op.fn)
      return diagnostics
    }

    const first = extractBody((await client.complete(buildMappingPrompt(op))) ?? '')
    if (first === null) {
      stubbed(op, 'model returned no usable body')
      continue
    }
    const firstDiagnostics = validate(first)
    if (firstDiagnostics.length === 0) {
      outcomes.push({
        fn: op.fn,
        capability: op.capability,
        outcome: 'synthesized',
        detail: 'typechecked on first attempt',
      })
      continue
    }

    const retryPrompt = buildMappingPrompt(op, { body: first, diagnostics: firstDiagnostics })
    const second = extractBody((await client.complete(retryPrompt)) ?? '')
    if (second !== null && validate(second).length === 0) {
      outcomes.push({
        fn: op.fn,
        capability: op.capability,
        outcome: 'synthesized',
        detail: 'typechecked after one retry',
      })
      continue
    }

    bodies.set(op.fn, {
      body: `${STUB_FALLBACK_NOTE}\n${synthesizeMappingBody(op)}`,
      synthesized: false,
    })
    stubbed(op, 'model synthesis failed typecheck twice — throwing stub kept')
  }

  return { module, source: renderMappingTs(module, bodies), outcomes }
}
