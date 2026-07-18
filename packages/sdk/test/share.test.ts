import { describe, expect, it } from 'vitest'
import {
  briefClipboardText,
  COPY_DISCLAIMER,
  SHARE_LINK_BASE,
  shareLink,
  shareSlug,
} from '../src/share.js'

describe('share slug', () => {
  it('is deterministic for the same frame id', () => {
    expect(shareSlug('frame-abc-123')).toBe(shareSlug('frame-abc-123'))
  })

  it('is always 4 lowercase base36 chars', () => {
    for (const id of ['a', 'frame-1', 'a-very-long-frame-identifier-0000', '☃']) {
      expect(shareSlug(id)).toMatch(/^[0-9a-z]{4}$/)
    }
  })

  it('differs across different frame ids', () => {
    expect(shareSlug('frame-1')).not.toBe(shareSlug('frame-2'))
  })

  it('builds the placeholder short link', () => {
    const link = shareLink('frame-1')
    expect(link.startsWith(SHARE_LINK_BASE)).toBe(true)
    expect(link).toBe(`hippo.app/s/${shareSlug('frame-1')}`)
  })
})

describe('briefClipboardText', () => {
  const brief = {
    headline: 'BTC is down 4.2% on ETF outflows',
    paragraphs: ['Spot ETFs saw outflows.', 'Liquidations added pressure.'],
    stats: [
      { k: 'PRICE', v: '$61,240' },
      { k: '24H', v: '−4.2%' },
    ],
    liveBar: { asOf: 'AS OF 14:32:08 IST' },
  }

  it('always ends with the advice disclaimer — the line travels with the prose', () => {
    const text = briefClipboardText(brief)
    expect(text.endsWith(COPY_DISCLAIMER)).toBe(true)
    // even a bare brief carries it
    expect(
      briefClipboardText({ headline: 'h', paragraphs: [], stats: [] }).endsWith(COPY_DISCLAIMER),
    ).toBe(true)
  })

  it('renders headline, prose, joined stats and the as-of stamp', () => {
    const text = briefClipboardText(brief)
    expect(text).toContain('BTC is down 4.2% on ETF outflows')
    expect(text).toContain('Spot ETFs saw outflows.')
    expect(text).toContain('PRICE $61,240 · 24H −4.2%')
    expect(text).toContain('AS OF 14:32:08 IST')
  })

  it('never emits triple blank lines, with or without optional parts', () => {
    expect(briefClipboardText(brief)).not.toMatch(/\n{3,}/)
    expect(briefClipboardText({ headline: 'h', paragraphs: [], stats: [] })).not.toMatch(/\n{3,}/)
  })
})
