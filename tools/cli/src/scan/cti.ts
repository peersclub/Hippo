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
import type { CapabilityId, CapabilityMatch, ErrorResponseFinding } from './types.js'

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const

export interface OpenApiOperation {
  summary?: string
  description?: string
  operationId?: string
  tags?: string[]
  /** Keyed by status code (or "default"); values may be $refs we ignore. */
  responses?: Record<string, { description?: string } | unknown>
}

export interface OpenApiDoc {
  openapi?: string
  swagger?: string
  info?: { title?: string; version?: string }
  paths?: Record<string, Record<string, unknown>>
  webhooks?: Record<string, unknown>
  components?: {
    securitySchemes?: Record<string, { type?: string; scheme?: string; in?: string; name?: string }>
    /** v3 shared schemas — resolved when rendering response shapes. */
    schemas?: Record<string, unknown>
  }
  securityDefinitions?: Record<string, { type?: string; in?: string; name?: string }>
  /** v2 shared schemas — resolved when rendering response shapes. */
  definitions?: Record<string, unknown>
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

/** A status key that denotes an error (4xx/5xx) or the catch-all "default". */
const ERROR_STATUS = /^[45]\d\d$/

/**
 * Documented error responses across all operations — the deterministic input
 * to stage-4 `rejections.yaml`. Pulls each 4xx/5xx (and "default") response's
 * status + description. An empty array means "spec documents no errors", which
 * the rejection generator flags as a gap.
 */
export function extractErrorResponses(doc: OpenApiDoc): ErrorResponseFinding[] {
  const findings: ErrorResponseFinding[] = []
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (typeof item !== 'object' || item === null) continue
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, unknown>)[method]
      if (typeof op !== 'object' || op === null) continue
      const responses = (op as OpenApiOperation).responses
      if (!responses) continue
      for (const [status, res] of Object.entries(responses)) {
        if (!ERROR_STATUS.test(status) && status !== 'default') continue
        const description =
          typeof res === 'object' &&
          res !== null &&
          typeof (res as { description?: unknown }).description === 'string'
            ? (res as { description: string }).description
            : null
        findings.push({ endpoint: `${method.toUpperCase()} ${path}`, status, description })
      }
    }
  }
  return findings
}

// ── Response-shape extraction ──────────────────────────────────────────────
// Compact success-response shapes per endpoint, the venue-side input to the
// stage-4 mapping synthesis: the model needs to see what the venue actually
// returns before it can transform it into a CTI shape. Rendered as a compact
// TypeScript-ish type expression, depth-limited, with local $refs resolved.

const SUCCESS_STATUS = /^2\d\d$/
const MAX_SHAPE_DEPTH = 5
const MAX_SHAPE_FIELDS = 24

interface SchemaNode {
  $ref?: string
  type?: string
  enum?: unknown[]
  properties?: Record<string, unknown>
  required?: string[]
  items?: unknown
}

/** Resolve a LOCAL $ref ("#/components/schemas/X" v3, "#/definitions/X" v2). */
function resolveRef(doc: OpenApiDoc, ref: string): unknown {
  const match = /^#\/(?:components\/schemas|definitions)\/(.+)$/.exec(ref)
  const name = match?.[1]
  if (!name) return undefined
  return doc.components?.schemas?.[name] ?? doc.definitions?.[name]
}

function renderSchema(doc: OpenApiDoc, node: unknown, depth: number, seen: Set<string>): string {
  if (typeof node !== 'object' || node === null) return 'unknown'
  const schema = node as SchemaNode
  if (typeof schema.$ref === 'string') {
    if (depth <= 0 || seen.has(schema.$ref)) return 'unknown /* recursive */'
    const next = new Set(seen)
    next.add(schema.$ref)
    return renderSchema(doc, resolveRef(doc, schema.$ref), depth - 1, next)
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
  }
  if (schema.type === 'array') {
    return `Array<${renderSchema(doc, schema.items, depth - 1, seen)}>`
  }
  if (schema.type === 'object' || schema.properties) {
    const props = Object.entries(schema.properties ?? {})
    if (depth <= 0 || props.length === 0) return 'object'
    const required = new Set(schema.required ?? [])
    const fields = props
      .slice(0, MAX_SHAPE_FIELDS)
      .map(
        ([name, sub]) =>
          `${name}${required.has(name) ? '' : '?'}: ${renderSchema(doc, sub, depth - 1, seen)}`,
      )
    if (props.length > MAX_SHAPE_FIELDS)
      fields.push(`/* +${props.length - MAX_SHAPE_FIELDS} more */`)
    return `{ ${fields.join('; ')} }`
  }
  if (schema.type === 'integer') return 'number'
  if (typeof schema.type === 'string') return schema.type
  return 'unknown'
}

/**
 * The documented SUCCESS response shape of every operation, keyed by
 * "METHOD /path". v3 reads `responses.2xx.content[application/json].schema`
 * (falling back to the first media type, then an inline `example`); v2 reads
 * `responses.2xx.schema`. Endpoints with no documented schema are simply
 * absent — the mapping synthesizer treats absence as "undocumented, map
 * defensively" rather than inventing a shape.
 */
export function extractResponseShapes(doc: OpenApiDoc): Record<string, string> {
  const shapes: Record<string, string> = {}
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (typeof item !== 'object' || item === null) continue
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, unknown>)[method]
      if (typeof op !== 'object' || op === null) continue
      const responses = (op as OpenApiOperation).responses
      if (!responses) continue
      const statusKey =
        Object.keys(responses)
          .filter((s) => SUCCESS_STATUS.test(s))
          .sort()[0] ?? ('default' in responses ? 'default' : undefined)
      if (!statusKey) continue
      const res = responses[statusKey]
      if (typeof res !== 'object' || res === null) continue
      const content = (res as { content?: Record<string, { schema?: unknown; example?: unknown }> })
        .content
      const media = content ? (content['application/json'] ?? Object.values(content)[0]) : undefined
      const schema = media?.schema ?? (res as { schema?: unknown }).schema
      const key = `${method.toUpperCase()} ${path}`
      if (schema !== undefined) {
        const rendered = renderSchema(doc, schema, MAX_SHAPE_DEPTH, new Set())
        if (rendered !== 'unknown') shapes[key] = rendered
      } else if (media?.example !== undefined) {
        shapes[key] = `example: ${JSON.stringify(media.example).slice(0, 600)}`
      }
    }
  }
  return shapes
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
