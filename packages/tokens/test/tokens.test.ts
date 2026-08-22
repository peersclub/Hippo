import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dark, darkVars, fonts, light, lightVars, radius } from '../src/index.js'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/tokens.css'), 'utf8')

function folded(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '')
}

describe('@hippo/tokens', () => {
  it('CSS file and JS dark values agree on every core colour', () => {
    const hay = folded(css)
    expect(hay).toContain(folded(`--hippo-bg: ${dark.bg}`))
    expect(hay).toContain(folded(`--hippo-panel: ${dark.panel}`))
    expect(hay).toContain(folded(`--hippo-card: ${dark.card}`))
    expect(hay).toContain(folded(`--hippo-amber: ${dark.amber}`))
    expect(hay).toContain(folded(`--hippo-up: ${dark.up}`))
    expect(hay).toContain(folded(`--hippo-down: ${dark.down}`))
  })

  it('light swap is present for both :root and :host', () => {
    expect(css).toContain(':root[data-theme="light"]')
    expect(css).toContain(':host([data-theme="light"])')
    expect(folded(css)).toContain(folded(`--hippo-amber: ${light.amber}`))
  })

  it('declaration strings are selector-free (SDK splices them into :host)', () => {
    expect(darkVars.startsWith('--hippo-')).toBe(true)
    expect(darkVars).not.toContain('{')
    expect(lightVars).not.toContain('{')
    expect(darkVars).toContain(fonts.display)
    expect(darkVars).toContain(radius.card)
  })
})
