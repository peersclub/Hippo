import { describe, expect, it } from 'vitest'
import { isRtl, LOCALES, resolveLocale, t } from '../src/i18n.js'

// Catalog completeness (every locale defines every chrome key) is enforced by
// TypeScript: `hi` and `hi-Latn` are typed as the full Catalog, so a missing
// key fails the build. These tests cover the runtime resolution logic.

describe('resolveLocale', () => {
  it('accepts supported locales exactly', () => {
    for (const l of LOCALES) expect(resolveLocale(l)).toBe(l)
  })
  it('normalizes region/case variants to a supported locale', () => {
    expect(resolveLocale('hi-IN')).toBe('hi')
    expect(resolveLocale('hi_IN')).toBe('hi')
    expect(resolveLocale('hi-latn')).toBe('hi-Latn')
    expect(resolveLocale('ar-EG')).toBe('ar')
  })
  it('falls back to en for unknown or empty input', () => {
    expect(resolveLocale('fr')).toBe('en')
    expect(resolveLocale('')).toBe('en')
    expect(resolveLocale(null)).toBe('en')
    expect(resolveLocale(undefined)).toBe('en')
  })
})

describe('isRtl', () => {
  it('is true only for RTL locales', () => {
    expect(isRtl('ar')).toBe(true)
    expect(isRtl('en')).toBe(false)
    expect(isRtl('hi')).toBe(false)
    expect(isRtl('hi-Latn')).toBe(false)
  })
})

describe('t', () => {
  it('returns the locale string for a known key', () => {
    expect(t('en', 'brand_ask')).toBe('Ask Hippo')
    expect(t('hi', 'brand_ask')).toBe('Hippo से पूछें')
    expect(t('hi-Latn', 'brand_ask')).toBe('Hippo se poochho')
  })
  it('interpolates named vars', () => {
    expect(t('en', 'manage_on', { venue: 'KoinBX' })).toBe('Manage on KoinBX →')
    expect(t('hi', 'manage_on', { venue: 'KoinBX' })).toContain('KoinBX')
  })
  it('falls back to en when a locale has no copy (ar = RTL groundwork only)', () => {
    expect(t('ar', 'brand_ask')).toBe(t('en', 'brand_ask'))
    expect(t('ar', 'hero_title')).toBe('Ask your market anything.')
  })
  it('hi and hi-Latn actually differ from en for translated chrome', () => {
    for (const key of ['hero_title', 'send', 'minimize'] as const) {
      expect(t('hi', key)).not.toBe(t('en', key))
      expect(t('hi-Latn', key)).not.toBe(t('en', key))
    }
  })
  it('leaves an unresolved placeholder intact when no var is supplied', () => {
    expect(t('en', 'manage_on')).toBe('Manage on {venue} →')
  })
})
