import { describe, expect, it } from 'vitest'
import { LOCALES, t } from '../src/i18n.js'
import { positionsEmptyText } from '../src/positions-view.js'

describe('positionsEmptyText — an empty frame makes no claim about the account', () => {
  const neutral = t('en', 'positions_empty')

  it('draws the server’s empty-state text when it authored one', () => {
    expect(positionsEmptyText('No positions on Assetworks right now.', neutral)).toBe(
      'No positions on Assetworks right now.',
    )
  })

  it('falls back to a neutral line when the server said nothing', () => {
    expect(positionsEmptyText(undefined, neutral)).toBe(neutral)
    expect(positionsEmptyText('', neutral)).toBe(neutral)
    expect(positionsEmptyText('   ', neutral)).toBe(neutral)
  })

  it('the fallback asserts nothing about positions — a failed fetch is not a flat book', () => {
    expect(neutral).toBe('Nothing to show')
    expect(neutral.toLowerCase()).not.toContain('position')
    expect(neutral.toLowerCase()).not.toContain('no open')
  })

  it('the fallback is localized in every locale', () => {
    for (const l of LOCALES) expect(t(l, 'positions_empty').length).toBeGreaterThan(0)
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      expect(t(l, 'positions_empty')).not.toBe(neutral)
    }
  })
})
