import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pushFrame, type ThreadItem, thread } from '../src/state.js'
import {
  clearStreamWatchdog,
  interruptedStreamIds,
  isStreaming,
  STREAM_WATCHDOG_MS,
} from '../src/streaming.js'

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

  it('is false once the trailing delta has been marked interrupted', () => {
    interruptedStreamIds.value = new Set(['f2'])
    expect(isStreaming([echo('f1'), delta('f2', 'partial…')])).toBe(false)
    interruptedStreamIds.value = new Set()
  })
})

describe('stalled-stream watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    thread.value = []
    interruptedStreamIds.value = new Set()
    clearStreamWatchdog()
  })
  afterEach(() => {
    clearStreamWatchdog()
    vi.useRealTimers()
  })

  const pushDelta = (id: string, text: string) =>
    pushFrame({ kind: 'frame', frame: { ...base, id, type: 'brief_delta', text } })

  it('finalizes a stalled stream after the deadline — cursor stops, isStreaming flips false', () => {
    pushDelta('d1', 'BTC is moving ')
    expect(isStreaming(thread.value)).toBe(true)
    // Just short of the deadline: still streaming.
    vi.advanceTimersByTime(STREAM_WATCHDOG_MS - 1)
    expect(isStreaming(thread.value)).toBe(true)
    // Deadline lapses with no further delta / authoritative brief.
    vi.advanceTimersByTime(1)
    expect(interruptedStreamIds.value.has('d1')).toBe(true)
    expect(isStreaming(thread.value)).toBe(false)
  })

  it('resets the deadline on every delta (measured from the LAST delta)', () => {
    pushDelta('d1', 'first ')
    vi.advanceTimersByTime(STREAM_WATCHDOG_MS - 100)
    // A fresh delta arrives before the deadline — the watchdog restarts from
    // here. The merged card keeps the FIRST delta's id (stable identity, so it
    // doesn't remount/flicker per chunk), so interruption is marked on d1.
    pushDelta('d2', 'second ')
    vi.advanceTimersByTime(STREAM_WATCHDOG_MS - 100)
    expect(isStreaming(thread.value)).toBe(true)
    expect(interruptedStreamIds.value.size).toBe(0)
    vi.advanceTimersByTime(100)
    expect(interruptedStreamIds.value.has('d1')).toBe(true)
    expect(isStreaming(thread.value)).toBe(false)
  })

  it('never fires once the authoritative research_brief lands', () => {
    pushDelta('d1', 'BTC is down ')
    pushFrame({
      kind: 'frame',
      frame: {
        ...base,
        id: 'b1',
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
    vi.advanceTimersByTime(STREAM_WATCHDOG_MS * 2)
    expect(interruptedStreamIds.value.size).toBe(0)
    expect(isStreaming(thread.value)).toBe(false)
  })
})
