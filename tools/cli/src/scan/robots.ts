/**
 * robots.txt parsing (pure) — sitemaps + disallowed API-looking paths,
 * which often reveal where a venue's API actually lives.
 */
import type { RobotsInfo } from './types.js'

const API_HINT = /api|graphql|swagger|openapi|\brest\b/i

export function parseRobots(text: string): RobotsInfo {
  const sitemaps: string[] = []
  const disallows: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (!value) continue
    if (field === 'sitemap') sitemaps.push(value)
    if (field === 'disallow') disallows.push(value)
  }
  return {
    fetched: true,
    sitemaps: [...new Set(sitemaps)],
    apiDisallows: [...new Set(disallows.filter((d) => API_HINT.test(d)))],
    disallowCount: disallows.length,
  }
}
