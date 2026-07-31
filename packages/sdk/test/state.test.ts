import { afterEach, describe, expect, it } from 'vitest'
import {
  banners,
  identityStatus,
  identityUsername,
  learnedFacts,
  learnedMemoryOptIn,
  livePrice,
  localUploads,
  orders,
  pushFrame,
  thread,
} from '../src/state.js'
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

describe('order_draft + price_tick routing', () => {
  const draft = (id: string, extra: Record<string, unknown> = {}) => ({
    ...base,
    id,
    type: 'order_draft' as const,
    draftId: `d_${id}`,
    capability: 'futures_perp' as const,
    title: 'Set up your LONG BTC order',
    instrument: 'BTC/USDT',
    symbols: ['BTC/USDT', 'ETH/USDT'],
    side: 'buy' as const,
    direction: 'long' as const,
    size: '0.05',
    sizeAsset: 'BTC',
    orderType: 'market' as const,
    leverage: 13,
    maxLeverage: 50,
    marginMode: 'isolated' as const,
    marginModes: ['isolated' as const, 'cross' as const],
    cta: 'Review order →',
    ...extra,
  })
  const tick = (id: string, extra: Record<string, unknown> = {}) => ({
    ...base,
    id,
    type: 'price_tick' as const,
    symbol: 'BTC/USDT',
    last: 63631.63,
    lastDisplay: '63,631.63',
    changePct: -4.2,
    asOfIso: '2026-07-28T09:00:00.000Z',
    ...extra,
  })

  it('order_draft is a conversation card — it enters the thread', () => {
    thread.value = []
    pushFrame({ kind: 'frame', frame: draft('od1') })
    expect(thread.value).toHaveLength(1)
    const item = thread.value[0]
    expect(item?.kind === 'frame' && item.frame.type).toBe('order_draft')
  })

  it('order_draft is content — it clears the transient thinking card above it', () => {
    thread.value = []
    pushFrame({ kind: 'frame', frame: { ...base, id: 'th', type: 'thinking', lines: ['…'] } })
    pushFrame({ kind: 'frame', frame: draft('od2') })
    const types = thread.value.map((x) => (x.kind === 'frame' ? x.frame.type : 'unknown'))
    expect(types).toEqual(['order_draft'])
  })

  it('price_tick feeds the livePrice signal and NEVER the thread (transient)', () => {
    thread.value = []
    livePrice.value = null
    pushFrame({ kind: 'frame', frame: tick('pt1') })
    expect(thread.value).toHaveLength(0)
    expect(livePrice.value).toEqual({
      symbol: 'BTC/USDT',
      last: 63631.63,
      lastDisplay: '63,631.63',
      changePct: -4.2,
      asOfIso: '2026-07-28T09:00:00.000Z',
    })
  })

  it('the latest tick wins (one price surface, updated in place)', () => {
    livePrice.value = null
    pushFrame({ kind: 'frame', frame: tick('pt1') })
    pushFrame({ kind: 'frame', frame: tick('pt2', { last: 63700, lastDisplay: '63,700.00' }) })
    expect(livePrice.value).toMatchObject({ last: 63700 })
  })

  it('a tick between thinking and the answer cannot disturb the thread', () => {
    thread.value = []
    pushFrame({ kind: 'frame', frame: { ...base, id: 'th', type: 'thinking', lines: ['…'] } })
    pushFrame({ kind: 'frame', frame: tick('pt3') })
    // The tick must NOT count as content — the thinking card stays until real
    // content lands (a tick clearing the spinner would strand the trader).
    const types = thread.value.map((x) => (x.kind === 'frame' ? x.frame.type : 'unknown'))
    expect(types).toEqual(['thinking'])
    pushFrame({ kind: 'frame', frame: draft('od3') })
    const after = thread.value.map((x) => (x.kind === 'frame' ? x.frame.type : 'unknown'))
    expect(after).toEqual(['order_draft'])
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

describe('learned_memory routing', () => {
  const learned = (
    facts: Array<{ label: string; type: string; value: string; scope: string }>,
    optIn = true,
  ) => ({
    ...base,
    id: 'lm',
    type: 'learned_memory' as const,
    facts,
    optIn,
  })

  it('captures the latest facts into the learnedFacts signal, never the thread', () => {
    thread.value = []
    learnedFacts.value = []
    pushFrame({
      kind: 'frame',
      frame: learned([
        { label: 'Follows BTC', type: 'followed_asset', value: 'BTC', scope: 'user' },
        { label: 'Asking about ETH', type: 'topic', value: 'ETH', scope: 'session' },
      ]),
    })
    expect(thread.value).toHaveLength(0)
    expect(learnedFacts.value.map((f) => f.label)).toEqual(['Follows BTC', 'Asking about ETH'])
    expect(learnedFacts.value.map((f) => f.scope)).toEqual(['user', 'session'])
  })

  it('keeps only the LATEST frame (a new set replaces the previous one)', () => {
    learnedFacts.value = []
    pushFrame({
      kind: 'frame',
      frame: learned([
        { label: 'Follows BTC', type: 'followed_asset', value: 'BTC', scope: 'user' },
      ]),
    })
    pushFrame({
      kind: 'frame',
      frame: learned([
        { label: 'Follows SOL', type: 'followed_asset', value: 'SOL', scope: 'user' },
      ]),
    })
    expect(learnedFacts.value.map((f) => f.label)).toEqual(['Follows SOL'])
  })

  it('empties the set on an empty frame (the post-clear re-emit)', () => {
    learnedFacts.value = [
      { label: 'Follows BTC', type: 'followed_asset', value: 'BTC', scope: 'user' },
    ]
    pushFrame({ kind: 'frame', frame: learned([]) })
    expect(learnedFacts.value).toEqual([])
  })

  it('routes the frame optIn into learnedMemoryOptIn (true when on)', () => {
    learnedMemoryOptIn.value = false
    pushFrame({
      kind: 'frame',
      frame: learned([
        { label: 'Follows BTC', type: 'followed_asset', value: 'BTC', scope: 'user' },
      ]),
    })
    expect(learnedMemoryOptIn.value).toBe(true)
  })

  it('reflects optIn:false (learning paused, empty set)', () => {
    learnedMemoryOptIn.value = true
    pushFrame({ kind: 'frame', frame: learned([], false) })
    expect(learnedMemoryOptIn.value).toBe(false)
    expect(learnedFacts.value).toEqual([])
  })

  it('lets the LATEST frame win the opt-in state', () => {
    pushFrame({ kind: 'frame', frame: learned([], false) })
    expect(learnedMemoryOptIn.value).toBe(false)
    pushFrame({
      kind: 'frame',
      frame: learned([
        { label: 'Follows SOL', type: 'followed_asset', value: 'SOL', scope: 'user' },
      ]),
    })
    expect(learnedMemoryOptIn.value).toBe(true)
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

describe('identity frame routing', () => {
  const identity = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    ...base,
    id,
    type: 'identity' as const,
    status: status as 'ok',
    ...extra,
  })

  it('never enters the thread — the identity card renders the signal in place', () => {
    thread.value = []
    identityStatus.value = null
    identityUsername.value = null
    pushFrame({ kind: 'frame', frame: identity('i1', 'ok', { username: 'victor' }) })
    expect(thread.value).toHaveLength(0)
    // peek(): the `= null` reset above narrows .value to null for TS
    expect(identityStatus.peek()?.status).toBe('ok')
  })

  it('ok binds the username; signed_out unbinds it', () => {
    identityUsername.value = null
    pushFrame({ kind: 'frame', frame: identity('i1', 'ok', { username: 'victor' }) })
    expect(identityUsername.value).toBe('victor')
    pushFrame({ kind: 'frame', frame: identity('i2', 'signed_out') })
    expect(identityUsername.value).toBeNull()
    expect(identityStatus.value?.status).toBe('signed_out')
  })

  it('failure statuses report WITHOUT un-signing a live session', () => {
    identityUsername.value = null
    pushFrame({ kind: 'frame', frame: identity('i1', 'ok', { username: 'victor' }) })
    for (const status of ['taken', 'wrong_pin', 'invalid', 'rate_limited'] as const) {
      pushFrame({ kind: 'frame', frame: identity(`i_${status}`, status) })
      expect(identityUsername.value).toBe('victor') // sticky
      expect(identityStatus.value?.status).toBe(status) // latest reported
    }
  })

  it('cannot clear a thinking card — it is routed state, not content', () => {
    thread.value = []
    pushFrame({ kind: 'frame', frame: { ...base, id: 'th', type: 'thinking', lines: ['…'] } })
    pushFrame({ kind: 'frame', frame: identity('i9', 'ok', { username: 'victor' }) })
    const types = thread.value.map((x) => (x.kind === 'frame' ? x.frame.type : 'unknown'))
    expect(types).toEqual(['thinking'])
  })
})

describe('upload_status routing', () => {
  const upload = (
    id: string,
    fileId: string,
    phase: string,
    extra: Record<string, unknown> = {},
  ) => ({
    ...base,
    id,
    type: 'upload_status' as const,
    fileId,
    name: 'trades.csv',
    sizeDisplay: '184 KB',
    phase: phase as 'received',
    ...extra,
  })

  it('is a conversation card — it enters the thread and clears a trailing thinking', () => {
    thread.value = []
    localUploads.value = []
    pushFrame({ kind: 'frame', frame: { ...base, id: 'th', type: 'thinking', lines: ['…'] } })
    pushFrame({ kind: 'frame', frame: upload('u1', 'f_1', 'received') })
    const types = thread.value.map((x) => (x.kind === 'frame' ? x.frame.type : 'unknown'))
    expect(types).toEqual(['upload_status'])
  })

  it('collapses in place by fileId — one chip tells the file journey', () => {
    thread.value = []
    localUploads.value = []
    pushFrame({ kind: 'frame', frame: upload('u1', 'f_1', 'received') })
    pushFrame({ kind: 'frame', frame: { ...base, id: 'e', type: 'user_echo', text: 'analyze' } })
    pushFrame({ kind: 'frame', frame: upload('u2', 'f_1', 'analyzing') })
    expect(thread.value).toHaveLength(2)
    const first = thread.value[0]
    expect(
      first?.kind === 'frame' && first.frame.type === 'upload_status' && first.frame.phase,
    ).toBe('analyzing')
  })

  it('different files never collapse into each other', () => {
    thread.value = []
    localUploads.value = []
    pushFrame({ kind: 'frame', frame: upload('u1', 'f_1', 'received') })
    pushFrame({ kind: 'frame', frame: upload('u2', 'f_2', 'received') })
    expect(thread.value).toHaveLength(2)
  })

  it('failed replaces in place too, carrying the server reason', () => {
    thread.value = []
    localUploads.value = []
    pushFrame({ kind: 'frame', frame: upload('u1', 'f_1', 'analyzing') })
    pushFrame({ kind: 'frame', frame: upload('u2', 'f_1', 'failed', { reason: 'Unreadable CSV' }) })
    expect(thread.value).toHaveLength(1)
    const only = thread.value[0]
    expect(only?.kind === 'frame' && only.frame.type === 'upload_status' && only.frame.reason).toBe(
      'Unreadable CSV',
    )
  })

  it('collapses received → analyzing → analyzed into ONE terminal chip that persists', () => {
    thread.value = []
    localUploads.value = []
    pushFrame({ kind: 'frame', frame: upload('u1', 'f_1', 'received', { kind: 'csv' }) })
    pushFrame({ kind: 'frame', frame: upload('u2', 'f_1', 'analyzing', { kind: 'csv' }) })
    pushFrame({ kind: 'frame', frame: upload('u3', 'f_1', 'analyzed', { kind: 'csv' }) })
    // The analysis brief lands beneath the chip — the chip stays in the thread.
    pushFrame({
      kind: 'frame',
      frame: {
        ...base,
        id: 'b',
        type: 'research_brief',
        eyebrow: 'FILE ANALYSIS',
        live: false,
        headline: 'h',
        paragraphs: [],
        liveBar: { asOf: 'now' },
      },
    })
    const types = thread.value.map((x) => (x.kind === 'frame' ? x.frame.type : 'unknown'))
    expect(types).toEqual(['upload_status', 'research_brief'])
    const chip = thread.value[0]
    expect(chip?.kind === 'frame' && chip.frame.type === 'upload_status' && chip.frame.phase).toBe(
      'analyzed',
    )
  })

  it('retires the client-local progress row for its fileId (server takes over)', () => {
    thread.value = []
    localUploads.value = [
      {
        id: 1,
        name: 'trades.csv',
        sizeDisplay: '184 KB',
        pct: 100,
        phase: 'sending',
        fileId: 'f_1',
      },
      { id: 2, name: 'other.png', sizeDisplay: '1.0 MB', pct: 40, phase: 'sending', fileId: 'f_2' },
    ]
    pushFrame({ kind: 'frame', frame: upload('u1', 'f_1', 'received') })
    expect(localUploads.value.map((u) => u.fileId)).toEqual(['f_2'])
  })
})

describe('interpretation card persistence', () => {
  const interp = (id: string) => ({
    ...base,
    id,
    type: 'interpretation' as const,
    summary: 'Understood: why is BTC down',
    intent: 'research',
    memoryScopes: [],
  })

  it('replaces the transient thinking card but PERSISTS above the answer', () => {
    thread.value = []
    pushFrame({ kind: 'frame', frame: { ...base, id: 'u1', type: 'user_echo', text: 'why btc' } })
    pushFrame({ kind: 'frame', frame: { ...base, id: 'th', type: 'thinking', lines: ['…'] } })
    pushFrame({ kind: 'frame', frame: interp('ip') }) // replaces thinking
    pushFrame({ kind: 'frame', frame: { ...base, id: 'sk', type: 'skeleton', shape: 'brief' } })
    pushFrame({ kind: 'frame', frame: briefFrame('b1') }) // replaces skeleton
    const types = thread.value.map((x) => (x.kind === 'frame' ? x.frame.type : 'unknown'))
    // interpretation survives between the echo and the answer — not ephemeral.
    expect(types).toEqual(['user_echo', 'interpretation', 'research_brief'])
  })
})
