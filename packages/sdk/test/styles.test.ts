import { describe, expect, it } from 'vitest'
import { panelCss } from '../src/styles.js'

/** Decls inside a rule body, keyed by property. */
function parseDecls(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const seg of body.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const s = seg.trim()
    if (!s) continue
    const i = s.indexOf(':')
    if (i === -1) continue
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
  }
  return out
}

// The first `:host{…}` rule is the dark (default) token layer.
const darkBody = panelCss.match(/:host\{([^}]*)\}/)?.[1] ?? ''
const lightBody = panelCss.match(/:host\(\[data-theme="light"\]\)\{([^}]*)\}/)?.[1] ?? ''
const dark = parseDecls(darkBody)
const light = parseDecls(lightBody)

describe('dark token layer', () => {
  it('defines a token block on :host', () => {
    expect(Object.keys(dark).some((k) => k.startsWith('--hippo-'))).toBe(true)
  })

  it('carries the exact literals it replaced (no dark regression)', () => {
    expect(dark['--hippo-amber']).toBe('#F0B94A')
    expect(dark['--hippo-panel-top']).toBe('#15171D')
    expect(dark['--hippo-panel-bottom']).toBe('#101217')
    expect(dark['--hippo-panel']).toBe('#14161C')
    expect(dark['--hippo-card']).toBe('#232733')
    expect(dark['--hippo-card-2']).toBe('#262B36')
    expect(dark['--hippo-user-bubble']).toBe('#2A2E38')
    expect(dark['--hippo-amber-ink']).toBe('#15171D')
    expect(dark['--hippo-amber-tint']).toBe('#E8CE93')
    expect(dark['--hippo-up']).toBe('#2EC48D')
    expect(dark['--hippo-down']).toBe('#FF8585')
    expect(dark['--hippo-text-hi']).toBe('#E9EBF0')
    expect(dark['--hippo-text-mid']).toBe('#B8BDC9')
    expect(dark['--hippo-text-dim']).toBe('#8A8F9C')
    expect(dark['--hippo-text-faint']).toBe('#6A7080')
    expect(dark['--hippo-text-dim-2']).toBe('#9BA1AE')
    expect(dark['--hippo-hairline']).toBe('rgba(255,255,255,.07)')
    expect(dark['--hippo-amber-rgb']).toBe('240,185,74')
    expect(dark['--hippo-up-rgb']).toBe('46,196,141')
    expect(dark['--hippo-down-rgb']).toBe('255,133,133')
  })

  it('leaves no hardcoded hex literal in the rule bodies', () => {
    // Strip both token blocks; the remaining CSS must be var-driven only.
    const body = panelCss
      .replace(/:host\{[^}]*\}/, '')
      .replace(/:host\(\[data-theme="light"\]\)\{[^}]*\}/, '')
    expect(body).not.toMatch(/#[0-9A-Fa-f]{3,6}\b/)
  })

  it('references only tokens that are defined', () => {
    const refs = new Set(
      [...panelCss.matchAll(/var\((--hippo-[a-z0-9-]+)\)/g)].map((m) => m[1] as string),
    )
    const undefinedRefs = [...refs].filter((r) => !(r in dark))
    expect(undefinedRefs).toEqual([])
  })
})

describe('light theme is a pure token swap', () => {
  it('exists', () => {
    expect(Object.keys(light).length).toBeGreaterThan(0)
  })

  it('redeclares ONLY custom properties — no layout or literal properties', () => {
    for (const key of Object.keys(light)) {
      expect(key.startsWith('--hippo-')).toBe(true)
    }
  })

  it('overrides only tokens that already exist in the dark layer', () => {
    const extra = Object.keys(light).filter((k) => !(k in dark))
    expect(extra).toEqual([])
  })

  it('actually changes the palette (theming does something)', () => {
    expect(light['--hippo-amber']).toBe('#B98A1E')
    expect(light['--hippo-amber-ink']).toBe('#FFFFFF')
    expect(light['--hippo-up']).toBe('#149469')
    expect(light['--hippo-down']).toBe('#D94F4F')
    expect(light['--hippo-card']).toBe('#FFFFFF')
    expect(light['--hippo-hairline']).not.toBe(dark['--hippo-hairline'])
  })
})
