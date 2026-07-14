/**
 * Content-Security-Policy summarization (pure) — answers one embed question:
 * can a third-party script (the Hippo SDK) load, and from which hosts?
 */
import type { CspSummary } from './types.js'

const KEYWORD = /^'.*'$/ // 'self', 'none', 'unsafe-inline', 'nonce-…', 'sha256-…'
const SCHEME_ONLY = /^[a-z][a-z0-9+.-]*:$/i // data:, blob:, https:

export function summarizeCsp(header: string, reportOnly = false): CspSummary {
  const directives = new Map<string, string[]>()
  for (const part of header.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    const name = tokens.shift()?.toLowerCase()
    if (name && !directives.has(name)) directives.set(name, tokens)
  }

  const scriptDirective = directives.has('script-src')
    ? ('script-src' as const)
    : directives.has('default-src')
      ? ('default-src' as const)
      : null
  const sources = scriptDirective ? (directives.get(scriptDirective) ?? []) : []

  return {
    reportOnly,
    scriptDirective,
    restrictsScripts: scriptDirective !== null && !sources.includes('*'),
    allowsUnsafeInline: sources.includes("'unsafe-inline'"),
    scriptHosts: sources.filter((s) => !KEYWORD.test(s) && !SCHEME_ONLY.test(s) && s !== '*'),
  }
}
