import { describe, expect, it } from 'vitest'
import { banners, orders, pushFrame, thread } from '../src/state.js'

const base = { v: 1 as const, ts: 1 }

describe('thread store', () => {
  it('replaces thinking → skeleton → content instead of stacking them', () => {
    thread.value = []
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 'f1', type: 'user_echo', text: 'why is btc down?' },
    })
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 'f2', type: 'thinking', lines: ['Parsing intent…'] },
    })
    pushFrame({ kind: 'frame', frame: { ...base, id: 'f3', type: 'skeleton', shape: 'brief' } })
    pushFrame({
      kind: 'frame',
      frame: {
        ...base,
        id: 'f4',
        type: 'research_brief',
        eyebrow: 'MARKET BRIEF',
        live: true,
        headline: 'BTC is down',
        paragraphs: [],
        stats: [],
        sources: [],
        followups: [],
      },
    })
    expect(thread.value).toHaveLength(2) // echo + brief; transients replaced
    const last = thread.value[1]
    expect(last?.kind === 'frame' && last.frame.type).toBe('research_brief')
  })

  it('accumulates brief_delta frames into one growing card that the final brief replaces', () => {
    thread.value = []
    pushFrame({ kind: 'frame', frame: { ...base, id: 'f1', type: 'skeleton', shape: 'brief' } })
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 'f2', type: 'brief_delta', text: 'BTC is down 4.2% ' },
    })
    // Delta replaced the skeleton; the card is now streaming prose.
    expect(thread.value).toHaveLength(1)
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 'f3', type: 'brief_delta', text: 'after the inflation print.' },
    })
    expect(thread.value).toHaveLength(1)
    const streaming = thread.value[0]
    expect(
      streaming?.kind === 'frame' && streaming.frame.type === 'brief_delta' && streaming.frame.text,
    ).toBe('BTC is down 4.2% after the inflation print.')
    pushFrame({
      kind: 'frame',
      frame: {
        ...base,
        id: 'f4',
        type: 'research_brief',
        eyebrow: 'MARKET BRIEF',
        live: true,
        headline: 'BTC is down 4.2%',
        paragraphs: [],
        stats: [],
        sources: [],
        followups: [],
      },
    })
    // The authoritative brief replaced the accumulated streaming card.
    expect(thread.value).toHaveLength(1)
    const last = thread.value[0]
    expect(last?.kind === 'frame' && last.frame.type).toBe('research_brief')
  })

  it('routes orders_snapshot to the orders store, not the thread', () => {
    thread.value = []
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 'f5', type: 'orders_snapshot', open: [], positionsCount: 3 },
    })
    expect(thread.value).toHaveLength(0)
    expect(orders.value?.positionsCount).toBe(3)
  })
})

describe('banner routing', () => {
  it('routes banner frames to the pinned banners signal, never the thread', () => {
    thread.value = []
    banners.value = []
    pushFrame({
      kind: 'frame',
      frame: {
        ...base,
        id: 'b1',
        type: 'banner',
        kind: 'degraded',
        title: 'HIGH MARKET LOAD',
        text: 'Fresh research may take longer; orders, prices and saved briefs unaffected.',
      },
    })
    expect(thread.value).toHaveLength(0)
    expect(banners.value).toHaveLength(1)
    expect(banners.value[0]?.kind).toBe('degraded')
  })

  it('replaces an existing banner of the same kind instead of stacking', () => {
    banners.value = []
    pushFrame({
      kind: 'frame',
      frame: {
        ...base,
        id: 'b1',
        type: 'banner',
        kind: 'degraded',
        title: 'HIGH MARKET LOAD',
        text: 'a',
      },
    })
    pushFrame({
      kind: 'frame',
      frame: {
        ...base,
        id: 'b2',
        type: 'banner',
        kind: 'degraded',
        title: 'HIGH MARKET LOAD',
        text: 'b',
      },
    })
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 'b3', type: 'banner', kind: 'info', title: 'NOTICE', text: 'c' },
    })
    expect(banners.value).toHaveLength(2)
    expect(banners.value.map((b) => b.id)).toEqual(['b2', 'b3'])
  })
})
