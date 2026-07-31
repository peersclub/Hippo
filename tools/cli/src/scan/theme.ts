/**
 * Theming extraction — the partner's brand accent, pulled deterministically
 * from the homepage HTML (Open Decisions "theming beyond light/dark").
 *
 * Three heuristics, in strict precedence order (first hit wins, and the
 * report says which one fired so a human can sanity-check it):
 *   1. <meta name="theme-color">           — the site's own declared brand
 *   2. a brand-named CSS custom property   — --accent/--primary/--brand(…)
 *      in inline <style> blocks
 *   3. the most frequent SATURATED hex     — grey/near-white/near-black
 *      ignored, so chrome colors can't win
 *
 * Pure string analysis: no DOM, no network, no color-science dependency —
 * the same zero-dep posture as the rest of the scan modules. The result is
 * a HINT for `hippo embed --accent`, never applied without a human eye.
 */

export interface ThemeHints {
  /** Normalized #rrggbb (lowercase). */
  accent: string
  source: 'theme-color-meta' | 'css-variable' | 'frequency'
  /** The variable name for source 'css-variable' (aids the report). */
  variable?: string
}

/** #rgb | #rrggbb (case-insensitive) → normalized #rrggbb, else null. */
export function normalizeHex(raw: string): string | null {
  const m = raw.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return null
  const hex = m[1] ?? ''
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex
  return `#${full.toLowerCase()}`
}

/** A brand accent must be a COLOR, not chrome: enough channel spread to not
 * read grey, and not sitting at either luminance extreme. */
export function isSaturated(hex: string): boolean {
  const v = normalizeHex(hex)
  if (!v) return false
  const r = Number.parseInt(v.slice(1, 3), 16)
  const g = Number.parseInt(v.slice(3, 5), 16)
  const b = Number.parseInt(v.slice(5, 7), 16)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max - min < 40) return false // grey family
  const lum = (r + g + b) / 3
  return lum > 24 && lum < 232 // not near-black / near-white
}

const BRAND_VAR = /--(?:accent|primary|brand)(?:-color)?\s*:\s*(#[0-9a-f]{3,6})\b/gi

/** Extract the partner accent from homepage HTML; null when nothing passes
 * the saturation gate (an honest "couldn't tell" beats a grey guess). */
export function extractAccent(html: string): ThemeHints | null {
  // 1. The site's own declaration.
  const meta = html.match(
    /<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*name=["']theme-color["']/i,
  )
  const declared = normalizeHex(meta?.[1] ?? meta?.[2] ?? '')
  if (declared && isSaturated(declared)) {
    return { accent: declared, source: 'theme-color-meta' }
  }

  // 2. Brand-named custom properties in inline styles.
  for (const style of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const m of (style[1] ?? '').matchAll(BRAND_VAR)) {
      const v = normalizeHex(m[1] ?? '')
      if (v && isSaturated(v)) {
        const name = m[0]?.slice(0, m[0].indexOf(':')).trim()
        return { accent: v, source: 'css-variable', variable: name }
      }
    }
  }

  // 3. Frequency: the saturated hex the page leans on most. Ties break on
  //    first appearance so the result is stable run-to-run.
  const counts = new Map<string, { n: number; first: number }>()
  for (const m of html.matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const v = normalizeHex(m[0] ?? '')
    if (!v || !isSaturated(v)) continue
    const cur = counts.get(v)
    if (cur) cur.n += 1
    else counts.set(v, { n: 1, first: m.index ?? 0 })
  }
  let best: { hex: string; n: number; first: number } | null = null
  for (const [hex, { n, first }] of counts) {
    if (!best || n > best.n || (n === best.n && first < best.first)) best = { hex, n, first }
  }
  // A single stray hex is noise, not a brand.
  if (best && best.n >= 3) return { accent: best.hex, source: 'frequency' }
  return null
}
