/**
 * Stage 3 (pure) — detect per-venue TRADE-TYPE feature sets (spot /
 * futures_perp / options) from a parsed OpenAPI/Swagger document. The result
 * mirrors the protocol's `VenueCapabilities` (packages/protocol/src/orders.ts):
 * a feature is enabled iff its key is present, and enabled features carry the
 * validation params the capability modules check against (futures
 * maxLeverage / marginModes).
 *
 * Same honesty policy as scan/cti.ts: deterministic keyword heuristics over
 * path + summary + operationId + tags. A match means "candidate feature", not
 * proof — and when a feature looks enabled but its required params can't be
 * extracted from the spec, it is flagged `paramsIncomplete` rather than
 * guessing values.
 */
import type { OpenApiDoc } from './cti.js'
import type { FuturesPerpFeature, TradeFeatureId, VenueCapabilitiesShape } from './types.js'

export const TRADE_FEATURE_IDS: readonly TradeFeatureId[] = ['spot', 'futures_perp', 'options']

export const TRADE_FEATURE_LABELS: Record<TradeFeatureId, string> = {
  spot: 'Spot',
  futures_perp: 'Futures (perp)',
  options: 'Options',
}

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const

interface ParamSchema {
  maximum?: number
  enum?: unknown[]
}

/** v3 keeps constraints under `schema`; v2 inlines them on the parameter. */
interface OperationParameter extends ParamSchema {
  name?: string
  schema?: ParamSchema
}

interface OperationView {
  summary?: string
  description?: string
  operationId?: string
  tags?: string[]
  parameters?: OperationParameter[]
  requestBody?: {
    content?: Record<string, { schema?: { properties?: Record<string, ParamSchema> } }>
  }
}

interface Endpoint {
  method: (typeof HTTP_METHODS)[number]
  path: string
  /** Lowercased haystack: path + summary + description + operationId + tags. */
  text: string
  op: OperationView
}

const MAX_ENDPOINTS_PER_FEATURE = 6

/** "order" that is not "order book" — same guard as scan/cti.ts. */
const ORDER = /order(?![-_ ]?book)/

/** Futures/derivatives-scoped path segments. */
const FUTURES_PATH = /\/(futures?|derivatives?|perp(?:etual)?s?|swaps?|fapi|dapi)\b/

/** Futures signals beyond path scoping: leverage, position/margin mode, funding rate. */
const FUTURES_TEXT = /leverage|position[-_ ]?mode|margin[-_ ]?(mode|type)|funding[-_ ]?(rate|fee)/

function isOptionsSignal(text: string): boolean {
  if (/\boptions?\b|option[-_]?chain|strike/.test(text)) return true
  // call/put alone is too generic ("call this endpoint"); require an expiry co-signal
  return /\b(calls?|puts?)\b/.test(text) && /expir/.test(text)
}

function isFuturesSignal(e: Endpoint): boolean {
  return FUTURES_PATH.test(e.path) || FUTURES_TEXT.test(e.text)
}

/** Order-placement candidate — same heuristic as the CTI orderPlacement map. */
function isOrderPlacement(e: Endpoint): boolean {
  return (
    (e.method === 'post' && ORDER.test(e.text) && !/cancel/.test(e.text)) ||
    /(place|create|new|submit)[-_ ]?order/.test(e.text)
  )
}

function extractEndpoints(doc: OpenApiDoc): Endpoint[] {
  const endpoints: Endpoint[] = []
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (typeof item !== 'object' || item === null) continue
    for (const method of HTTP_METHODS) {
      const op = item[method]
      if (typeof op !== 'object' || op === null) continue
      const view = op as OperationView
      const text = [
        path,
        view.summary,
        view.description?.slice(0, 120),
        view.operationId,
        ...(view.tags ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      endpoints.push({ method, path, text, op: view })
    }
  }
  return endpoints
}

function label(e: Endpoint): string {
  return `${e.method.toUpperCase()} ${e.path}`
}

function capList(hits: string[]): string[] {
  return hits.length > MAX_ENDPOINTS_PER_FEATURE
    ? [
        ...hits.slice(0, MAX_ENDPOINTS_PER_FEATURE),
        `… +${hits.length - MAX_ENDPOINTS_PER_FEATURE} more`,
      ]
    : hits
}

function documentedMaximum(schema: ParamSchema | undefined): number | null {
  return typeof schema?.maximum === 'number' && schema.maximum > 0 ? schema.maximum : null
}

function normalizeMarginModes(values: unknown[]): Array<'isolated' | 'cross'> {
  const modes = new Set<'isolated' | 'cross'>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const mode = value.toLowerCase()
    if (mode === 'isolated') modes.add('isolated')
    if (mode === 'cross' || mode === 'crossed') modes.add('cross')
  }
  return [...modes]
}

const LEVERAGE_NAME = /leverage/
const MARGIN_MODE_NAME = /margin[-_]?(mode|type)/

/**
 * Extract futures validation params from the candidate endpoints' documented
 * inputs: query/body params named like `leverage` (numeric `maximum` → the
 * venue's leverage cap) and `marginMode`/`marginType` (enum → margin modes).
 * Anything the spec doesn't document is omitted, never invented.
 */
function futuresFeature(hits: Endpoint[]): FuturesPerpFeature {
  let maxLeverage: number | undefined
  const marginModes = new Set<'isolated' | 'cross'>()

  const consider = (name: string, schema: ParamSchema | undefined) => {
    if (LEVERAGE_NAME.test(name)) {
      const max = documentedMaximum(schema)
      if (max !== null) maxLeverage = Math.max(maxLeverage ?? 0, max)
    }
    if (MARGIN_MODE_NAME.test(name)) {
      for (const mode of normalizeMarginModes(schema?.enum ?? [])) marginModes.add(mode)
    }
  }

  for (const e of hits) {
    for (const param of e.op.parameters ?? []) {
      const name = param.name?.toLowerCase() ?? ''
      consider(name, param.schema ?? param)
    }
    for (const media of Object.values(e.op.requestBody?.content ?? {})) {
      for (const [prop, schema] of Object.entries(media.schema?.properties ?? {})) {
        consider(prop.toLowerCase(), schema)
      }
    }
  }

  const feature: FuturesPerpFeature = { endpoints: capList(hits.map(label)) }
  if (maxLeverage !== undefined) feature.maxLeverage = maxLeverage
  if (marginModes.size > 0) feature.marginModes = [...marginModes]
  // The protocol requires both params to validate futures orders; be explicit
  // when the spec only proves the feature exists, not its limits.
  if (maxLeverage === undefined || marginModes.size === 0) feature.paramsIncomplete = true
  return feature
}

/**
 * Map a spec to the venue's trade-type feature set. Pass an empty doc ({})
 * when no spec was found → nothing enabled.
 */
export function detectTradeFeatures(doc: OpenApiDoc): VenueCapabilitiesShape {
  const endpoints = extractEndpoints(doc)
  const caps: VenueCapabilitiesShape = {}

  // Spot: order placement exists on a path that isn't futures/derivatives- or
  // options-scoped — an exclusively-derivatives spec must not read as spot.
  const spotPlacements = endpoints.filter(
    (e) => isOrderPlacement(e) && !isFuturesSignal(e) && !isOptionsSignal(e.text),
  )
  if (spotPlacements.length > 0) {
    caps.spot = { endpoints: capList(spotPlacements.map(label)) }
  }

  const futuresHits = endpoints.filter(isFuturesSignal)
  if (futuresHits.length > 0) {
    caps.futures_perp = futuresFeature(futuresHits)
  }

  const optionsHits = endpoints.filter((e) => isOptionsSignal(e.text))
  if (optionsHits.length > 0) {
    caps.options = { endpoints: capList(optionsHits.map(label)) }
  }

  return caps
}
