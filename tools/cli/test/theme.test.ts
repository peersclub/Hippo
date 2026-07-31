import { describe, expect, it } from 'vitest'
import { extractAccent, isSaturated, normalizeHex } from '../src/scan/theme.js'

describe('normalizeHex', () => {
  it('expands #rgb and lowercases #RRGGBB', () => {
    expect(normalizeHex('#3bF')).toBe('#33bbff')
    expect(normalizeHex('#F0B94A')).toBe('#f0b94a')
  })
  it('rejects everything else', () => {
    for (const bad of ['F0B94A', '#f0b9', '#f0b94az', 'rgb(1,2,3)', '']) {
      expect(normalizeHex(bad)).toBeNull()
    }
  })
})

describe('isSaturated', () => {
  it('rejects greys and near-extremes, accepts brand colors', () => {
    expect(isSaturated('#8a8f9c')).toBe(false) // grey
    expect(isSaturated('#0a0a0a')).toBe(false) // near-black
    expect(isSaturated('#fdfdfd')).toBe(false) // near-white
    expect(isSaturated('#3b82f6')).toBe(true) // AssetWorks blue
    expect(isSaturated('#f0b94a')).toBe(true) // Hippo amber
  })
})

describe('extractAccent', () => {
  it('prefers the declared theme-color meta', () => {
    const html = `<meta name="theme-color" content="#3b82f6"><style>:root{--accent:#ff0000}</style>`
    expect(extractAccent(html)).toEqual({ accent: '#3b82f6', source: 'theme-color-meta' })
  })

  it('handles content-before-name attribute order', () => {
    const html = `<meta content="#3b82f6" name="theme-color">`
    expect(extractAccent(html)?.accent).toBe('#3b82f6')
  })

  it('skips a grey theme-color and falls through to a brand variable', () => {
    const html = `<meta name="theme-color" content="#111111"><style>:root{--brand-color: #e11d48;}</style>`
    expect(extractAccent(html)).toEqual({
      accent: '#e11d48',
      source: 'css-variable',
      variable: '--brand-color',
    })
  })

  it('falls back to the most frequent saturated hex (ties break on first seen)', () => {
    const html = `
      <style>.a{color:#e11d48}.b{background:#e11d48}.c{border-color:#e11d48}
      .d{color:#3b82f6}.e{color:#3b82f6}.f{color:#3b82f6}</style>`
    // Both appear 3×; #e11d48 appears first.
    expect(extractAccent(html)).toEqual({ accent: '#e11d48', source: 'frequency' })
  })

  it('returns null when nothing saturated repeats enough', () => {
    const html = `<style>body{color:#222;background:#fff}.x{color:#e11d48}</style>`
    expect(extractAccent(html)).toBeNull()
  })
})
