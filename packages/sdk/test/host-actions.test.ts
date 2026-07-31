import type { HostAction } from '@hippo/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acceptAck,
  actionMessage,
  applyAck,
  forwardHostAction,
  HOST_ACTION_TIMEOUT_MS,
  hostActionMap,
  parseAck,
} from '../src/host-actions.js'
import { pushFrame, thread } from '../src/state.js'
import { clearStreamWatchdog } from '../src/streaming.js'

const base = { v: 1 as const, ts: 1 }

const hostAction = (extra: Partial<HostAction> = {}): HostAction => ({
  ...base,
  id: 'f_ha',
  type: 'host_action',
  actionId: 'a1',
  action: 'set_timeframe',
  timeframe: '5m',
  note: 'Chart → 5m',
  ...extra,
})

beforeEach(() => {
  hostActionMap.value = {}
  thread.value = []
})
afterEach(() => {
  clearStreamWatchdog()
  vi.useRealTimers()
})

describe('actionMessage — the SDK→host post payload', () => {
  it('carries source/type/actionId/action + only the present control fields', () => {
    expect(actionMessage(hostAction())).toEqual({
      source: 'hippo-sdk',
      type: 'hippo:action',
      actionId: 'a1',
      action: 'set_timeframe',
      timeframe: '5m',
    })
    // note is SDK-side (drives the chip), never posted to the host.
    expect(actionMessage(hostAction()).note).toBeUndefined()
  })

  it('sends the indicator slug for indicator actions', () => {
    const msg = actionMessage(
      hostAction({ action: 'apply_indicator', indicator: 'rsi', timeframe: undefined }),
    )
    expect(msg).toEqual({
      source: 'hippo-sdk',
      type: 'hippo:action',
      actionId: 'a1',
      action: 'apply_indicator',
      indicator: 'rsi',
    })
  })
})

describe('forwardHostAction — chip lifecycle', () => {
  it('marks the action pending', () => {
    forwardHostAction(hostAction())
    expect(hostActionMap.value.a1).toEqual({ phase: 'pending' })
  })

  it('is idempotent per actionId (a replay never re-posts or resets a chip)', () => {
    forwardHostAction(hostAction())
    applyAck({ actionId: 'a1', ok: true })
    // A second forward for the same id must not reset the settled chip.
    forwardHostAction(hostAction())
    expect(hostActionMap.value.a1).toEqual({ phase: 'applied' })
  })

  it('times out to "no response" when no ack arrives within the window', () => {
    vi.useFakeTimers()
    forwardHostAction(hostAction())
    expect(hostActionMap.value.a1.phase).toBe('pending')
    vi.advanceTimersByTime(HOST_ACTION_TIMEOUT_MS)
    expect(hostActionMap.value.a1).toEqual({ phase: 'timeout' })
  })

  it('an ack before the deadline settles the chip and cancels the timeout', () => {
    vi.useFakeTimers()
    forwardHostAction(hostAction())
    applyAck({ actionId: 'a1', ok: true })
    expect(hostActionMap.value.a1).toEqual({ phase: 'applied' })
    // The armed timer must not later overwrite the applied state.
    vi.advanceTimersByTime(HOST_ACTION_TIMEOUT_MS)
    expect(hostActionMap.value.a1).toEqual({ phase: 'applied' })
  })
})

describe('applyAck — outcome reflection', () => {
  it('applied on ok:true', () => {
    forwardHostAction(hostAction())
    applyAck({ actionId: 'a1', ok: true })
    expect(hostActionMap.value.a1).toEqual({ phase: 'applied' })
  })

  it('failed (with reason) on ok:false', () => {
    forwardHostAction(hostAction())
    applyAck({ actionId: 'a1', ok: false, reason: 'unsupported indicator' })
    expect(hostActionMap.value.a1).toEqual({ phase: 'failed', reason: 'unsupported indicator' })
  })

  it('ignores an ack for an action we never sent', () => {
    applyAck({ actionId: 'ghost', ok: true })
    expect(hostActionMap.value.ghost).toBeUndefined()
  })

  it('first terminal outcome wins — a late/duplicate ack is ignored', () => {
    forwardHostAction(hostAction())
    applyAck({ actionId: 'a1', ok: true })
    applyAck({ actionId: 'a1', ok: false, reason: 'too late' })
    expect(hostActionMap.value.a1).toEqual({ phase: 'applied' })
  })
})

describe('parseAck — untrusted host messages', () => {
  it('accepts a well-formed ok / failed ack', () => {
    expect(
      parseAck({ source: 'hippo-host', type: 'hippo:action:result', actionId: 'a1', ok: true }),
    ).toEqual({ actionId: 'a1', ok: true, reason: undefined })
    expect(
      parseAck({
        source: 'hippo-host',
        type: 'hippo:action:result',
        actionId: 'a1',
        ok: false,
        reason: 'nope',
      }),
    ).toEqual({ actionId: 'a1', ok: false, reason: 'nope' })
  })

  it('rejects the wrong source, type, or shape', () => {
    expect(parseAck(null)).toBeNull()
    expect(parseAck('hippo:action:result')).toBeNull()
    expect(parseAck([])).toBeNull()
    // our own outbound message must not be mistaken for an ack
    expect(parseAck({ source: 'hippo-sdk', type: 'hippo:action', actionId: 'a1' })).toBeNull()
    expect(parseAck({ source: 'hippo-host', type: 'other', actionId: 'a1', ok: true })).toBeNull()
    expect(
      parseAck({ source: 'someone-else', type: 'hippo:action:result', actionId: 'a1', ok: true }),
    ).toBeNull()
  })

  it('rejects a missing/mistyped actionId or ok', () => {
    expect(parseAck({ source: 'hippo-host', type: 'hippo:action:result', ok: true })).toBeNull()
    expect(
      parseAck({ source: 'hippo-host', type: 'hippo:action:result', actionId: '', ok: true }),
    ).toBeNull()
    expect(
      parseAck({ source: 'hippo-host', type: 'hippo:action:result', actionId: 'a1' }),
    ).toBeNull()
    expect(
      parseAck({ source: 'hippo-host', type: 'hippo:action:result', actionId: 'a1', ok: 'yes' }),
    ).toBeNull()
    expect(
      parseAck({
        source: 'hippo-host',
        type: 'hippo:action:result',
        actionId: 'a1',
        ok: true,
        reason: 5,
      }),
    ).toBeNull()
  })
})

describe('acceptAck — origin gate', () => {
  const good = { source: 'hippo-host', type: 'hippo:action:result', actionId: 'a1', ok: true }
  it('accepts a valid ack from the expected origin', () => {
    expect(acceptAck('http://host.test', 'http://host.test', good)).toEqual({
      actionId: 'a1',
      ok: true,
      reason: undefined,
    })
  })
  it('drops a valid ack from a different origin', () => {
    expect(acceptAck('http://evil.test', 'http://host.test', good)).toBeNull()
  })
})

describe('pushFrame integration', () => {
  it('renders a host_action chip in-thread AND marks it pending', () => {
    pushFrame({ kind: 'frame', frame: hostAction() })
    expect(thread.value).toHaveLength(1)
    expect(thread.value[0]).toMatchObject({
      kind: 'frame',
      frame: { type: 'host_action', actionId: 'a1' },
    })
    expect(hostActionMap.value.a1).toEqual({ phase: 'pending' })
  })
})
