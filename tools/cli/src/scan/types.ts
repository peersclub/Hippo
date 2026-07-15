/**
 * Shared result types for `hippo scan` v0 — deterministic, read-only discovery.
 * Pure data: every module renders from or produces these shapes.
 */

export type FrameworkName =
  | 'next.js'
  | 'nuxt'
  | 'react'
  | 'vue'
  | 'angular'
  | 'wordpress'
  | 'unknown'

export interface FrameworkDetection {
  name: FrameworkName
  evidence: string | null
}

export interface CspSummary {
  reportOnly: boolean
  /** Which directive governs scripts (script-src, else default-src fallback). */
  scriptDirective: 'script-src' | 'default-src' | null
  /** True when a script-governing directive exists and is not a bare wildcard. */
  restrictsScripts: boolean
  allowsUnsafeInline: boolean
  /** Host-like source expressions allowed to serve scripts (keywords/hashes/nonces stripped). */
  scriptHosts: string[]
}

export interface SiteProfile {
  finalUrl: string
  status: number
  server: string | null
  poweredBy: string | null
  csp: CspSummary | null
  framework: FrameworkDetection
  title: string | null
  locales: string[]
}

export interface RobotsInfo {
  fetched: boolean
  sitemaps: string[]
  /** Disallow rules that look like API roots — often reveal where the API lives. */
  apiDisallows: string[]
  disallowCount: number
}

export type CapabilityId =
  | 'quote'
  | 'orderPlacement'
  | 'orderStatus'
  | 'cancel'
  | 'positions'
  | 'balances'
  | 'instruments'
  | 'webhooks'

export interface CapabilityMatch {
  id: CapabilityId
  label: string
  status: 'found' | 'gap'
  /** e.g. "GET /api/v3/ticker/price" — capped for report readability. */
  endpoints: string[]
  /** Plain-words consequence when this capability is a gap. */
  consequence: string
}

export interface SpecFinding {
  url: string
  version: string
  title: string | null
  pathCount: number
}

export interface ProbeResult {
  url: string
  /** null = request failed (timeout / DNS / refused). */
  status: number | null
  contentType: string | null
  note: string | null
}

/** A single documented error response, extracted from the spec's operations. */
export interface ErrorResponseFinding {
  /** e.g. "POST /api/v3/order". */
  endpoint: string
  /** HTTP status key: "400", "429", "default", … */
  status: string
  /** The response's description text, when the spec provides one. */
  description: string | null
}

export interface ScanResult {
  domain: string
  scannedAt: string
  site: SiteProfile
  robots: RobotsInfo | null
  spec: SpecFinding | null
  probes: ProbeResult[]
  capabilities: CapabilityMatch[]
  authSchemes: string[]
  /**
   * Documented error responses from the spec's operations, used by stage-4
   * `rejections.yaml` generation. Optional: absent for scans made before the
   * field existed and empty when no spec (or no documented errors) was found.
   */
  errorResponses?: ErrorResponseFinding[]
}
