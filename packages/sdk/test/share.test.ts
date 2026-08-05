import { describe, expect, it } from 'vitest'
import * as shareModule from '../src/share.js'
import { briefClipboardText, COPY_DISCLAIMER, shareCardView } from '../src/share.js'

describe('shareCardView — the shared artifact is the server’s, whole', () => {
  const brief = {
    live: false,
    headline: 'BTC is down 4.2% on ETF outflows',
    paragraphs: [
      'Spot ETFs saw $412M of outflows over three sessions.',
      'That said, funding is still positive and the move may be flow-driven, not a trend.',
    ],
  }

  it('a NON-LIVE brief exports without the LIVE badge', () => {
    expect(shareCardView(brief).live).toBe(false)
    expect(shareCardView({ ...brief, live: undefined }).live).toBe(false)
  })

  it('only the server’s live flag turns the badge on', () => {
    expect(shareCardView({ ...brief, live: true }).live).toBe(true)
  })

  it('a two-paragraph brief shares BOTH — the caveat travels', () => {
    const view = shareCardView(brief)
    expect(view.paragraphs).toHaveLength(2)
    expect(view.paragraphs[1]).toContain('may be flow-driven')
  })

  it('never truncates, however many paragraphs the server wrote', () => {
    const many = Array.from({ length: 7 }, (_, i) => `para ${i}`)
    expect(shareCardView({ ...brief, paragraphs: many }).paragraphs).toEqual(many)
  })

  it('draws the server’s headline verbatim', () => {
    expect(shareCardView(brief).headline).toBe(brief.headline)
  })
})

describe('the share card fabricates no address', () => {
  it('the module exports no link or slug builder at all', () => {
    // The dead `hippo.app/s/<slug>` placeholder is gone, not merely unused:
    // nothing can render or copy an address that resolves nowhere.
    expect(Object.keys(shareModule).sort()).toEqual([
      'COPIED_FLASH_MS',
      'COPY_DISCLAIMER',
      'briefClipboardText',
      'shareCardView',
    ])
  })

  it('the clipboard carries the brief’s own prose, never a URL', () => {
    const text = briefClipboardText({
      headline: 'BTC is down 4.2%',
      paragraphs: ['Outflows led the move.'],
      stats: [],
    })
    expect(text).not.toContain('hippo.app')
    expect(text).toContain('Outflows led the move.')
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
