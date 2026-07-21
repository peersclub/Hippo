import { afterEach, describe, expect, it } from 'vitest'
import { banners, orders, pushFrame, thread } from '../src/state.js'
import { clearStreamWatchdog, interruptedStreamIds } from '../src/streaming.js'

const base = { v: 1 as const, ts: 1 }

// pushFrame arms a real-timer stall watchdog whenever the thread is mid-stream;
// clear it between tests so a brief_delta tail can't leak a 20s timer.
afterEach(() => {
  clearStreamWatchdog()
  interruptedStreamIds.value = new Set()
})

const briefFrame = (id: string, extra: Record<string, unknown> = {}) => ({
  ...base,
  id,
  type: 'research_brief' as const,
  eyebrow: 'MARKET BRIEF',
  live: true,
  headline: `brief ${id}`,
  paragraphs: [],
  stats: [],
  sources: [],
  followups: [],
  ...extra,
})

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

  it('replaces a superseded brief in place (REFRESH re-run carries `replaces`)', () => {
    thread.value = []
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 'echo', type: 'user_echo', text: 'why is btc down?' },
    })
    pushFrame({ kind: 'frame', frame: briefFrame('f1', { headline: 'stale brief' }) })
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 'echo2', type: 'user_echo', text: 'and eth?' },
    })
    expect(thread.value).toHaveLength(3)
    // Refreshed brief supersedes f1; it must land where f1 sat (index 1),
    // NOT stack at the end below the newer echo.
    pushFrame({
      kind: 'frame',
      frame: briefFrame('f2', { headline: 'fresh brief', replaces: 'f1' }),
    })
    expect(thread.value).toHaveLength(3)
    const at1 = thread.value[1]
    expect(at1?.kind === 'frame' && at1.frame.type === 'research_brief' && at1.frame.id).toBe('f2')
    expect(at1?.kind === 'frame' && at1.frame.type === 'research_brief' && at1.frame.headline).toBe(
      'fresh brief',
    )
    // Order preserved: the trailing echo is still last.
    const last = thread.value[2]
    expect(last?.kind === 'frame' && last.frame.id).toBe('echo2')
  })

  it('appends a `replaces` brief when the referenced card is absent (older-SDK-safe)', () => {
    thread.value = []
    pushFrame({ kind: 'frame', frame: briefFrame('f1') })
    // The referenced id was never in this thread (aged out / different client):
    // fall back to append, never drop the frame.
    pushFrame({ kind: 'frame', frame: briefFrame('f2', { replaces: 'missing' }) })
    expect(thread.value).toHaveLength(2)
    expect(thread.value.map((x) => x.frame.id)).toEqual(['f1', 'f2'])
  })

  it('lets an unknown future frame clear the thinking card above it', () => {
    thread.value = []
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 'echo', type: 'user_echo', text: 'show my watchlist' },
    })
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 't1', type: 'thinking', lines: ['Working…'] },
    })
    // A frame type this SDK build doesn't know — rendered as a FallbackCard.
    // It's content, so it must replace the thinking spinner, not sit below it.
    pushFrame({
      kind: 'unknown',
      frame: {
        ...base,
        id: 'u1',
        type: 'watchlist_card',
        fallback: { text: 'Your watchlist is ready in the app.' },
      },
    })
    expect(thread.value).toHaveLength(2) // echo + fallback; thinking replaced
    const last = thread.value[1]
    expect(last?.kind).toBe('unknown')
    expect(last?.frame.id).toBe('u1')
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

describe('lifecycle collapse by ticketId', () => {
  const lifecycle = (id: string, ticketId: string, extra: Record<string, unknown> = {}) => ({
    ...base,
    id,
    type: 'lifecycle' as const,
    ticketId,
    phase: 'awaiting_confirm' as const,
    statusLine: 'SENDING…',
    rows: [],
    cancellable: true,
    ...extra,
  })

  it('a later frame for the same ticket updates the card IN PLACE', () => {
    thread.value = []
    pushFrame({ kind: 'frame', frame: { ...base, id: 'u1', type: 'user_echo', text: 'buy' } })
    pushFrame({ kind: 'frame', frame: lifecycle('l1', 't_1', { stage: 'placing' }) })
    pushFrame({ kind: 'frame', frame: lifecycle('l2', 't_1', { stage: 'working' }) })
    pushFrame({
      kind: 'frame',
      frame: lifecycle('l3', 't_1', { phase: 'filled', statusLine: 'FILLED' }),
    })
    const frames = thread.value.filter((x) => x.kind === 'frame').map((x) => x.frame)
    expect(frames.filter((f) => f.type === 'lifecycle')).toHaveLength(1)
    const lc = frames.find((f) => f.type === 'lifecycle') as { id: string; phase: string }
    expect(lc.id).toBe('l3')
    expect(lc.phase).toBe('filled')
    // Position preserved: still where the first lifecycle card landed.
    expect(frames[1]?.type).toBe('lifecycle')
  })

  it('different tickets never collapse into each other', () => {
    thread.value = []
    pushFrame({ kind: 'frame', frame: lifecycle('l1', 't_1') })
    pushFrame({ kind: 'frame', frame: lifecycle('l2', 't_2') })
    const lcs = thread.value.filter((x) => x.kind === 'frame' && x.frame.type === 'lifecycle')
    expect(lcs).toHaveLength(2)
  })

  it('the first lifecycle frame still clears a trailing thinking/skeleton card', () => {
    thread.value = []
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 'th', type: 'thinking', lines: ['Constructing order…'] },
    })
    pushFrame({ kind: 'frame', frame: lifecycle('l1', 't_9') })
    const types = thread.value.map((x) => (x.kind === 'frame' ? x.frame.type : 'unknown'))
    expect(types).toEqual(['lifecycle'])
  })
})
