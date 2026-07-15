import { describe, expect, it } from 'vitest'
import { Frame, Uplink, parseFrame } from '../src/index.js'

const base = { v: 1 as const, id: 'f_1', ts: 1_752_480_000_000 }

describe('card protocol v1 — frames', () => {
  it('parses a research_brief', () => {
    const result = parseFrame({
      ...base,
      type: 'research_brief',
      eyebrow: 'MARKET BRIEF',
      live: true,
      headline: 'BTC is down 4.2% over 12 hours',
      paragraphs: ['US inflation came in hotter than expected…'],
      stats: [
        { k: 'LAST', v: '61,240' },
        { k: '12H', v: '−4.2%', tone: 'neg' },
      ],
      spark: { points: [11, 8, 15, 13, 26, 35, 41] },
      sources: ['PRICE FEED', 'FUNDING', 'NEWS ×2'],
      liveBar: { asOf: 'AS OF 14:32:05 IST', asOfIso: '2026-07-14T09:02:05Z' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.frame.type).toBe('research_brief')
  })

  it('parses an order_ticket with display-string rows', () => {
    const result = parseFrame({
      ...base,
      type: 'order_ticket',
      ticketId: 't_1',
      side: 'buy',
      sideLabel: 'BUY · MKT',
      rows: [
        { label: 'Instrument', value: 'BTC / USDT' },
        { label: 'Est. cost incl. fees', value: '3,068.30 USDT' },
      ],
      cta: 'Review & confirm in KoinBX →',
      footnote: 'Hippo prepared this order. KoinBX will ask you to confirm.',
    })
    expect(result.ok).toBe(true)
  })

  it('parses a brief_delta (streaming research prose)', () => {
    const result = parseFrame({
      ...base,
      type: 'brief_delta',
      text: 'BTC is down 4.2% after the ',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.frame.type).toBe('brief_delta')
  })

  it('routes unknown future card types to the fallback path, never a throw', () => {
    const result = parseFrame({
      ...base,
      type: 'watchlist_card',
      fallback: { text: 'Your watchlist is ready.' },
      anything: { nested: true },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.unknown).not.toBeNull()
      expect(result.unknown?.fallback?.text).toBe('Your watchlist is ready.')
    }
  })

  it('drops garbage silently (no throw on any wire bytes)', () => {
    expect(parseFrame('not json{{{').ok).toBe(false)
    expect(parseFrame(42).ok).toBe(false)
    expect(parseFrame(null).ok).toBe(false)
    expect(parseFrame({ type: 'research_brief' }).ok).toBe(false) // missing envelope
  })

  it('rejects a lifecycle frame with an invalid phase', () => {
    const bad = Frame.safeParse({
      ...base,
      type: 'lifecycle',
      ticketId: 't_1',
      phase: 'teleported',
      statusLine: 'x',
    })
    expect(bad.success).toBe(false)
  })
})

describe('card protocol v1 — uplinks', () => {
  it('parses feedback with pre-categorized eval reason', () => {
    const up = Uplink.safeParse({
      v: 1,
      sessionId: 's_1',
      ts: Date.now(),
      kind: 'feedback',
      frameId: 'f_9',
      vote: 'down',
      reason: 'too_shallow',
    })
    expect(up.success).toBe(true)
  })

  it('caps user text at 2000 chars', () => {
    const up = Uplink.safeParse({
      v: 1,
      sessionId: 's_1',
      ts: Date.now(),
      kind: 'user_text',
      text: 'x'.repeat(2001),
    })
    expect(up.success).toBe(false)
  })
})
