import { describe, expect, it, vi } from 'vitest'
import { runActionSend } from '../src/panel.js'

// Trading actions (stop, etc.) go straight through transport `send` — never the
// outbox — so a send that fails while the connection still reads 'live' must be
// surfaced by the caller. runActionSend is that seam; the composer wires onFail
// to its SEND FAILED row.
describe('runActionSend', () => {
  it('reports failure when the gateway rejects the send (500 / dead session)', async () => {
    const onFail = vi.fn()
    await runActionSend({ kind: 'stream_stop' }, onFail, async () => false)
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('reports failure when the send throws (timeout / network)', async () => {
    const onFail = vi.fn()
    await runActionSend({ kind: 'stream_stop' }, onFail, async () => {
      throw new Error('timeout')
    })
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('stays silent when the send lands', async () => {
    const onFail = vi.fn()
    const sender = vi.fn(async () => true)
    await runActionSend({ kind: 'stream_stop' }, onFail, sender)
    expect(sender).toHaveBeenCalledWith({ kind: 'stream_stop' })
    expect(onFail).not.toHaveBeenCalled()
  })
})
