/**
 * Stage 1 (pure) — site understanding from an HTML string.
 * No network here; fetchers.ts hands us the body.
 */
import type { FrameworkDetection, FrameworkName } from './types.js'

const MARKERS: ReadonlyArray<{ name: FrameworkName; pattern: RegExp; evidence: string }> = [
  { name: 'next.js', pattern: /__NEXT_DATA__/, evidence: '__NEXT_DATA__ bootstrap script' },
  { name: 'next.js', pattern: /\/_next\//, evidence: '/_next/ asset paths' },
  { name: 'nuxt', pattern: /__NUXT__/, evidence: '__NUXT__ state object' },
  { name: 'nuxt', pattern: /\/_nuxt\//, evidence: '/_nuxt/ asset paths' },
  { name: 'angular', pattern: /\bng-version=/, evidence: 'ng-version attribute' },
  {
    name: 'wordpress',
    pattern: /wp-(?:content|includes)\//,
    evidence: 'wp-content / wp-includes asset paths',
  },
  {
    name: 'vue',
    pattern: /\bdata-v-[0-9a-f]{6,8}\b|__VUE__|data-server-rendered="true"/,
    evidence: 'Vue scoped-style / SSR markers',
  },
  {
    name: 'react',
    pattern:
      /\bdata-reactroot\b|__REACT_DEVTOOLS_GLOBAL_HOOK__|_reactRootContainer|react(?:-dom)?(?:\.production\.min|\.development)?\.js/,
    evidence: 'React root / runtime markers',
  },
]

export function detectFramework(html: string): FrameworkDetection {
  for (const marker of MARKERS) {
    if (marker.pattern.test(html)) return { name: marker.name, evidence: marker.evidence }
  }
  return { name: 'unknown', evidence: null }
}

export function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  if (!match?.[1]) return null
  const title = match[1].replace(/\s+/g, ' ').trim()
  return title.length > 0 ? title : null
}

/** html lang attribute + hreflang alternates, deduped, x-default dropped. */
export function extractLocales(html: string): string[] {
  const locales = new Set<string>()
  const lang = html.match(/<html[^>]*\blang=["']?([a-zA-Z][a-zA-Z0-9-]*)/)
  if (lang?.[1]) locales.add(lang[1].toLowerCase())
  for (const m of html.matchAll(/\bhreflang=["']?([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    if (m[1] && m[1].toLowerCase() !== 'x-default') locales.add(m[1].toLowerCase())
  }
  return [...locales]
}
