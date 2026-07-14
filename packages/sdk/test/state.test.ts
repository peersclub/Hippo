import { describe, expect, it } from 'vitest'
import { orders, pushFrame, thread } from '../src/state.js'

const base = { v: 1 as const, ts: 1 }

describe('thread store', () => {
  it('replaces thinking → skeleton → content instead of stacking them', () => {
    thread.value = []
    pushFrame({ kind: 'frame', frame: { ...base, id: 'f1', type: 'user_echo', text: 'why is btc down?' } })
    pushFrame({ kind: 'frame', frame: { ...base, id: 'f2', type: 'thinking', lines: ['Parsing intent…'] } })
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
