import { describe, expect, it } from 'vitest'
import type { ThreadItem } from '../src/state.js'
import { isStreaming } from '../src/streaming.js'

const base = { v: 1 as const, ts: 1 }

const delta = (id: string, text: string): ThreadItem => ({
  kind: 'frame',
  frame: { ...base, id, type: 'brief_delta', text },
})

const echo = (id: string): ThreadItem => ({
  kind: 'frame',
  frame: { ...base, id, type: 'user_echo', text: 'why is btc down?' },
})

const brief = (id: string): ThreadItem => ({
  kind: 'frame',
  frame: {
    ...base,
    id,
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

describe('isStreaming', () => {
  it('is false for an empty thread', () => {
    expect(isStreaming([])).toBe(false)
  })

  it('is true while the last item is the accumulating brief_delta card', () => {
    expect(isStreaming([echo('f1'), delta('f2', 'BTC is down 4.2% ')])).toBe(true)
  })

  it('is false once the authoritative research_brief replaces the deltas', () => {
    expect(isStreaming([echo('f1'), brief('f2')])).toBe(false)
  })

  it('is false when a delta exists earlier but is not the last item', () => {
    expect(isStreaming([delta('f1', 'partial '), brief('f2')])).toBe(false)
  })

  it('is false for unknown (fallback) items', () => {
    const unknown: ThreadItem = {
      kind: 'unknown',
      frame: { ...base, id: 'f1', type: 'watchlist_card' },
    }
    expect(isStreaming([unknown])).toBe(false)
  })
})
