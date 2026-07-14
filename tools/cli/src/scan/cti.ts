/**
 * Stage 3 (pure) — map a parsed OpenAPI/Swagger document (v2 or v3, JSON)
 * against the Canonical Trading Interface checklist from
 * "04 Execution Seam & Partner Adapter": quote, order placement, order
 * status/open orders, cancel, positions, balances, instruments, webhooks.
 *
 * Deterministic keyword heuristics over path + summary + operationId + tags.
 * v0 is honest about being a heuristic: a match means "candidate endpoint",
 * a gap means "not publicly discoverable" — not proof of absence.
 */
import type { CapabilityId, CapabilityMatch } from './types.js'

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const

export interface OpenApiOperation {
  summary?: string
  description?: string
  operationId?: string
  tags?: string[]
}

export interface OpenApiDoc {
  openapi?: string
  swagger?: string
  info?: { title?: string; version?: string }
  paths?: Record<string, Record<string, unknown>>
  webhooks?: Record<string, unknown>
  components?: {
    securitySchemes?: Record<string, { type?: string; scheme?: string; in?: string; name?: string }>
  }
  securityDefinitions?: Record<string, { type?: string; in?: string; name?: string }>
}

interface Endpoint {
  method: (typeof HTTP_METHODS)[number]
  path: string
  /** Lowercased haystack: path + summary + operationId + tags. */
  text: string
}

const MAX_ENDPOINTS_PER_CAPABILITY = 6

/** "order" that is not "order book" — market-depth endpoints are not order management. */
const ORDER = /order(?![-_ ]?book)/

const CAPABILITY_DEFS: ReadonlyArray<{
  id: CapabilityId
  label: string
  consequence: string
  match: (e: Endpoint) => boolean
}> = [
  {
    id: 'quote',
    label: 'Quote / ticker',
    consequence:
      'No quote/ticker endpoint → prepared tickets cannot show a live est. price; ticket prep would need a separate market-data source.',
    match: (e) => /ticker|quote|\bprice/.test(e.text),
  },
  {
    id: 'orderPlacement',
    label: 'Order placement',
    consequence:
      'No order placement endpoint → Hippo can only deep-link to the venue order form; no prepared-ticket flow.',
    match: (e) =>
      (e.method === 'post' && ORDER.test(e.text) && !/cancel/.test(e.text)) ||
      /(place|create|new|submit)[-_ ]?order/.test(e.text),
  },
  {
    id: 'orderStatus',
    label: 'Order status / open orders',
    consequence:
      'No order status endpoint → the thread goes silent after handoff; fills and rejections cannot be reported back in conversation.',
    match: (e) =>
      (e.method === 'get' && ORDER.test(e.text) && !/cancel/.test(e.text)) ||
      /open[-_ ]?orders|order[-_ ]?(status|history)|query[-_ ]?order/.test(e.text),
  },
  {
    id: 'cancel',
    label: 'Cancel order',
    consequence:
      'No cancel endpoint → in-thread cancel is unavailable; users must cancel on the venue UI.',
    match: (e) => /cancel/.test(e.text) || (e.method === 'delete' && ORDER.test(e.text)),
  },
  {
    id: 'positions',
    label: 'Positions',
    consequence:
      'No positions endpoint → portfolio context is unavailable in conversation (spot-only venues may not need it).',
    match: (e) => /position/.test(e.text),
  },
  {
    id: 'balances',
    label: 'Balances',
    consequence:
      'No balances endpoint → no pre-trade affordability hints; all sizing checks stay venue-side.',
    match: (e) =>
      /balanc|wallet|\bfunds\b/.test(e.text) ||
      (e.method === 'get' && /\baccounts?\b/.test(e.text)),
  },
  {
    id: 'instruments',
    label: 'Instruments / markets list',
    consequence:
      'No instruments/markets list → tradable catalog, precision, and size limits must be hand-configured per market.',
    match: (e) =>
      e.method === 'get' &&
      /instrument|markets?\b|symbols?\b|products?\b|\bpairs?\b|exchange-?info|assets?\b|currenc/.test(
        e.text,
      ),
  },
  {
    id: 'webhooks',
    label: 'Webhooks (order lifecycle events)',
    consequence: 'No webhook surface found → lifecycle updates would use polling reconciliation.',
    match: (e) => /web-?hook/.test(e.text),
  },
]

export function isOpenApiDoc(value: unknown): value is OpenApiDoc {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as OpenApiDoc
  return (
    typeof doc.openapi === 'string' ||
    typeof doc.swagger === 'string' ||
    (typeof doc.paths === 'object' && doc.paths !== null)
  )
}

export function specVersion(doc: OpenApiDoc): string {
  if (doc.openapi) return `OpenAPI ${doc.openapi}`
  if (doc.swagger) return `Swagger ${doc.swagger}`
  return 'OpenAPI (version undeclared)'
}

function extractEndpoints(doc: OpenApiDoc): Endpoint[] {
  const endpoints: Endpoint[] = []
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (typeof item !== 'object' || item === null) continue
    for (const method of HTTP_METHODS) {
      const op = item[method]
      if (typeof op !== 'object' || op === null) continue
      const { summary, description, operationId, tags } = op as OpenApiOperation
      const text = [path, summary, description?.slice(0, 120), operationId, ...(tags ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      endpoints.push({ method, path, text })
    }
  }
  return endpoints
}

/** Build the per-capability map. Pass an empty doc ({}) when no spec was found → all gaps. */
export function mapToCti(doc: OpenApiDoc): CapabilityMatch[] {
  const endpoints = extractEndpoints(doc)
  return CAPABILITY_DEFS.map((def) => {
    const hits = endpoints.filter(def.match).map((e) => `${e.method.toUpperCase()} ${e.path}`)
    if (def.id === 'webhooks' && doc.webhooks) {
      for (const name of Object.keys(doc.webhooks)) hits.push(`spec webhook: ${name}`)
    }
    const endpointList =
      hits.length > MAX_ENDPOINTS_PER_CAPABILITY
        ? [
            ...hits.slice(0, MAX_ENDPOINTS_PER_CAPABILITY),
            `… +${hits.length - MAX_ENDPOINTS_PER_CAPABILITY} more`,
          ]
        : hits
    return {
      id: def.id,
      label: def.label,
      status: hits.length > 0 ? ('found' as const) : ('gap' as const),
      endpoints: endpointList,
      consequence: def.consequence,
    }
  })
}

/** Declared auth schemes: v3 components.securitySchemes or v2 securityDefinitions. */
export function extractAuthSchemes(doc: OpenApiDoc): string[] {
  const schemes: string[] = []
  for (const [name, def] of Object.entries(doc.components?.securitySchemes ?? {})) {
    const detail = [def.type, def.scheme, def.in && def.name ? `${def.in}:${def.name}` : null]
      .filter(Boolean)
      .join(', ')
    schemes.push(detail ? `${name} (${detail})` : name)
  }
  for (const [name, def] of Object.entries(doc.securityDefinitions ?? {})) {
    const detail = [def.type, def.in && def.name ? `${def.in}:${def.name}` : null]
      .filter(Boolean)
      .join(', ')
    schemes.push(detail ? `${name} (${detail})` : name)
  }
  return schemes
}
