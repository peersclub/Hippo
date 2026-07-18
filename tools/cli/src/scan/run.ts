/**
 * Orchestrator for `hippo scan` — deterministic pipeline over the pure modules:
 * homepage → robots.txt → spec probes → CTI map → ScanResult.
 */
import { summarizeCsp } from './csp.js'
import type { OpenApiDoc } from './cti.js'
import {
  extractAuthSchemes,
  extractErrorResponses,
  isOpenApiDoc,
  mapToCti,
  specVersion,
} from './cti.js'
import { detectFramework, extractLocales, extractTitle } from './detect.js'
import { detectTradeFeatures } from './features.js'
import { fetchHtml, fetchJson, fetchUrl } from './fetchers.js'
import { parseRobots } from './robots.js'
import type { ProbeResult, ScanResult, SiteProfile, SpecFinding } from './types.js'

/** Probed in order on the apex domain; first parseable spec wins. */
const SPEC_PATHS = [
  '/openapi.json',
  '/swagger.json',
  '/api-docs',
  '/v3/api-docs',
  '/api/openapi.json',
  '/api/swagger.json',
  '/docs/openapi.json',
]

export type ScanOutcome =
  | { reachable: true; result: ScanResult }
  | { reachable: false; domain: string; error: string }

export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.+$/, '')
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

export async function runScan(rawDomain: string): Promise<ScanOutcome> {
  const domain = normalizeDomain(rawDomain)

  const home = await fetchHtml(`https://${domain}/`)
  if (!home.ok) return { reachable: false, domain, error: home.error }

  const cspHeader = home.headers.get('content-security-policy')
  const cspReportOnly = home.headers.get('content-security-policy-report-only')
  const site: SiteProfile = {
    finalUrl: home.finalUrl,
    status: home.status,
    server: home.headers.get('server'),
    poweredBy: home.headers.get('x-powered-by'),
    csp: cspHeader
      ? summarizeCsp(cspHeader)
      : cspReportOnly
        ? summarizeCsp(cspReportOnly, true)
        : null,
    framework: detectFramework(home.body),
    title: extractTitle(home.body),
    locales: extractLocales(home.body),
  }

  const specUrls = [
    ...SPEC_PATHS.map((p) => `https://${domain}${p}`),
    `https://api.${domain}/openapi.json`,
    `https://api.${domain}/swagger.json`,
  ]
  const plainProbeUrls = [`https://api.${domain}/`, `https://${domain}/api/v1/`]

  const [robotsRes, specResults, plainResults] = await Promise.all([
    fetchUrl(`https://${domain}/robots.txt`, 'text/plain'),
    Promise.all(specUrls.map((u) => fetchJson(u))),
    Promise.all(plainProbeUrls.map((u) => fetchJson(u))),
  ])

  const robots =
    robotsRes.ok && robotsRes.status === 200
      ? parseRobots(robotsRes.body)
      : { fetched: false, sitemaps: [], apiDisallows: [], disallowCount: 0 }

  let spec: SpecFinding | null = null
  let specDoc: OpenApiDoc | null = null
  const probes: ProbeResult[] = []

  for (const res of specResults) {
    if (!res.ok) {
      probes.push({ url: res.url, status: null, contentType: null, note: res.error })
      continue
    }
    let note: string | null = null
    if (res.status === 200 && specDoc === null) {
      const parsed = safeJsonParse(res.body)
      if (parsed !== undefined && isOpenApiDoc(parsed)) {
        specDoc = parsed
        spec = {
          url: res.url,
          version: specVersion(parsed),
          title: parsed.info?.title ?? null,
          pathCount: Object.keys(parsed.paths ?? {}).length,
        }
        note = 'spec found'
      }
    }
    probes.push({ url: res.url, status: res.status, contentType: res.contentType, note })
  }

  for (const res of plainResults) {
    if (!res.ok) {
      probes.push({ url: res.url, status: null, contentType: null, note: res.error })
      continue
    }
    const isJson =
      res.contentType?.includes('json') || safeJsonParse(res.body) !== undefined ? 'json' : null
    probes.push({ url: res.url, status: res.status, contentType: res.contentType, note: isJson })
  }

  const result: ScanResult = {
    domain,
    scannedAt: new Date().toISOString(),
    site,
    robots,
    spec,
    probes,
    capabilities: mapToCti(specDoc ?? {}),
    authSchemes: specDoc ? extractAuthSchemes(specDoc) : [],
    errorResponses: specDoc ? extractErrorResponses(specDoc) : [],
    tradeFeatures: detectTradeFeatures(specDoc ?? {}),
  }
  return { reachable: true, result }
}
