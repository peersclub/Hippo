import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The bounded retry loop drains through transport `send`; mock it so a test can
// decide, per tick, whether the gateway accepts the uplink.
const { send } = vi.hoisted(() => ({ send: vi.fn(async (_p: unknown) => false) }))
vi.mock('../src/transport.js', () => ({ send }))

import {
  armDrainRetry,
  cancelDrainRetry,
  DRAIN_MAX_ATTEMPTS,
  DRAIN_RETRY_MS,
  dispatch,
  type OutboxItem,
  outbox,
} from '../src/outbox.js'
import { connection } from '../src/state.js'

const item = (id: number): OutboxItem => ({
  id,
  partial: { kind: 'chip_tap', text: `q${id}` } as OutboxItem['partial'],
  queuedAt: id,
})

beforeEach(() => {
  cancelDrainRetry()
  outbox.value = []
  connection.value = 'connecting'
  send.mockReset()
  send.mockResolvedValue(false)
})

afterEach(() => {
  cancelDrainRetry()
  connection.value = 'connecting'
  vi.useRealTimers()
})

describe('bounded drain retry while live', () => {
  it('keeps retrying on a timer, then gives up instead of spinning forever', async () => {
    vi.useFakeTimers()
    send.mockResolvedValue(false) // gateway keeps rejecting (e.g. dead session)
    outbox.value = [item(1)]
    connection.value = 'live' // never fires again, so only the timer can drain
    await vi.advanceTimersByTimeAsync(0) // settle the immediate 'live' drain + arm

    expect(vi.getTimerCount()).toBe(1) // loop is armed
    for (let i = 0; i < DRAIN_MAX_ATTEMPTS + 2; i++) {
      await vi.advanceTimersByTimeAsync(DRAIN_RETRY_MS)
    }
    expect(outbox.value).toHaveLength(1) // still stuck — send never landed
    expect(vi.getTimerCount()).toBe(0) // but the loop stopped (bounded)
  })

  it('drains the stuck item and cancels itself once a retry lands', async () => {
    vi.useFakeTimers()
    send.mockResolvedValue(false)
    outbox.value = [item(1)]
    connection.value = 'live'
    await vi.advanceTimersByTimeAsync(0)
    expect(outbox.value).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)

    send.mockResolvedValue(true) // gateway recovers
    await vi.advanceTimersByTimeAsync(DRAIN_RETRY_MS)
    expect(outbox.value).toHaveLength(0) // flushed on the next tick
    expect(vi.getTimerCount()).toBe(0) // cancelled on empty
  })

  it('does not arm the loop while the connection is not live', async () => {
    vi.useFakeTimers()
    outbox.value = [item(1)]
    connection.value = 'offline'
    armDrainRetry()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('dispatch flushes behind a healthy send', () => {
  it('a successful live send drains items that queued while it looked down', async () => {
    connection.value = 'live'
    outbox.value = [item(99)] // lingered from an earlier failure
    send.mockResolvedValue(true)
    const r = await dispatch({ kind: 'chip_tap', text: 'now' })
    expect(r).toBe('sent')
    await vi.waitFor(() => expect(outbox.value).toHaveLength(0))
  })

  it('a failure while live queues the item and arms the retry loop', async () => {
    vi.useFakeTimers()
    connection.value = 'live'
    send.mockResolvedValue(false)
    const r = await dispatch({ kind: 'chip_tap', text: 'later' })
    expect(r).toBe('queued')
    expect(outbox.value).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1) // armed, not left to sit forever
  })
})
