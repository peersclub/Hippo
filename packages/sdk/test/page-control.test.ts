import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * pageControl opt-in emission: the SDK advertises data-hippo-page-control to
 * the gateway on its context uplink so the gateway is willing to emit
 * host_action frames. `send` comes from the mocked transport so we can assert
 * exactly what rides the uplink.
 */
const { send } = vi.hoisted(() => ({ send: vi.fn(() => Promise.resolve(true)) }))
vi.mock('../src/transport.js', () => ({ send, gatewayUrl: () => 'http://gw.test' }))

import { advertisePageControl, contextPayload, setPageControl } from '../src/bridge.js'
import { pageSymbol } from '../src/state.js'

beforeEach(() => {
  send.mockClear()
  setPageControl(false)
  pageSymbol.value = null
})
afterEach(() => {
  setPageControl(false)
})

describe('contextPayload — carries the pageControl flag when opted in', () => {
  it('omits pageControl by default', () => {
    expect(contextPayload({ symbol: 'BTC/USDT' })).toEqual({ kind: 'context', symbol: 'BTC/USDT' })
  })
  it('stamps pageControl:true once opted in', () => {
    setPageControl(true)
    expect(contextPayload({ symbol: 'BTC/USDT' })).toEqual({
      kind: 'context',
      symbol: 'BTC/USDT',
      pageControl: true,
    })
  })
  it('is valid with no symbol — pageControl is the payload', () => {
    setPageControl(true)
    expect(contextPayload()).toEqual({ kind: 'context', pageControl: true })
  })
})

describe('advertisePageControl', () => {
  it('does nothing when the host never opted in', () => {
    advertisePageControl()
    expect(send).not.toHaveBeenCalled()
  })
  it('sends a context uplink with pageControl and the current symbol', () => {
    setPageControl(true)
    pageSymbol.value = 'ETH/USDT'
    advertisePageControl()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ kind: 'context', symbol: 'ETH/USDT', pageControl: true })
  })
  it('sends pageControl even with no symbol declared', () => {
    setPageControl(true)
    advertisePageControl()
    expect(send).toHaveBeenCalledWith({ kind: 'context', pageControl: true })
  })
})
