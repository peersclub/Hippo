import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * pageControl opt-in emission: the SDK advertises data-hippo-page-control to
 * the gateway on its context uplink so the gateway is willing to emit
 * host_action frames. `send` comes from the mocked transport so we can assert
 * exactly what rides the uplink.
 */
const { send } = vi.hoisted(() => ({ send: vi.fn(() => Promise.resolve(true)) }))
vi.mock('../src/transport.js', () => ({ send, gatewayUrl: () => 'http://gw.test' }))

import {
  acceptCapabilities,
  advertisePageControl,
  contextPayload,
  MAX_HOST_ACTIONS,
  parseCapabilities,
  resetHostActions,
  setPageControl,
} from '../src/bridge.js'
import { pageSymbol } from '../src/state.js'

beforeEach(() => {
  send.mockClear()
  setPageControl(false)
  resetHostActions()
  pageSymbol.value = null
})
afterEach(() => {
  setPageControl(false)
  resetHostActions()
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

describe('contextPayload — host-declared verbs (capability discovery)', () => {
  const VERBS = ['set_timeframe', 'apply_indicator', 'remove_indicator', 'set_symbol', 'navigate']

  it('legacy fallback: pageControl with NO capabilities message OMITS hostActions', () => {
    setPageControl(true)
    // Omission IS the wire encoding for "chart trio only" — the SDK never
    // synthesizes a trio the host didn't declare.
    expect(contextPayload()).toEqual({ kind: 'context', pageControl: true })
  })

  it('carries the collected verbs once the host declared them', () => {
    setPageControl(true)
    acceptCapabilities(VERBS)
    expect(contextPayload({ symbol: 'BTC/USDT' })).toEqual({
      kind: 'context',
      symbol: 'BTC/USDT',
      pageControl: true,
      hostActions: VERBS,
    })
  })

  it('never sends hostActions without the pageControl opt-in', () => {
    acceptCapabilities(VERBS)
    expect(contextPayload()).toEqual({ kind: 'context' })
  })
})

describe('parseCapabilities — untrusted host declarations', () => {
  it('accepts a well-formed declaration', () => {
    expect(
      parseCapabilities({
        source: 'hippo-host',
        type: 'hippo:capabilities',
        actions: ['set_timeframe', 'set_symbol'],
      }),
    ).toEqual(['set_timeframe', 'set_symbol'])
  })

  it('rejects the wrong source, type, or shape outright', () => {
    expect(parseCapabilities(null)).toBeNull()
    expect(parseCapabilities([])).toBeNull()
    expect(
      parseCapabilities({ source: 'hippo-sdk', type: 'hippo:capabilities', actions: [] }),
    ).toBeNull()
    expect(
      parseCapabilities({ source: 'hippo-host', type: 'hippo:action', actions: [] }),
    ).toBeNull()
    expect(
      parseCapabilities({ source: 'hippo-host', type: 'hippo:capabilities', actions: 'nav' }),
    ).toBeNull()
  })

  it('drops non-string, empty and oversized entries without rejecting the rest', () => {
    expect(
      parseCapabilities({
        source: 'hippo-host',
        type: 'hippo:capabilities',
        actions: ['navigate', 42, '', 'x'.repeat(41), 'set_symbol'],
      }),
    ).toEqual(['navigate', 'set_symbol'])
  })

  it('dedupes and caps at the uplink bound (24)', () => {
    const many = Array.from({ length: 30 }, (_, i) => `verb_${i}`)
    expect(
      parseCapabilities({
        source: 'hippo-host',
        type: 'hippo:capabilities',
        actions: ['navigate', 'navigate', ...many],
      }),
    ).toHaveLength(MAX_HOST_ACTIONS)
  })
})

describe('acceptCapabilities — re-advertise on declaration', () => {
  it('re-sends the context uplink when a declaration lands after connect', () => {
    setPageControl(true)
    acceptCapabilities(['set_symbol'])
    expect(send).toHaveBeenCalledWith({
      kind: 'context',
      pageControl: true,
      hostActions: ['set_symbol'],
    })
  })

  it('drops an unchanged re-announcement (hosts answer every request)', () => {
    setPageControl(true)
    acceptCapabilities(['set_symbol', 'navigate'])
    send.mockClear()
    acceptCapabilities(['set_symbol', 'navigate'])
    expect(send).not.toHaveBeenCalled()
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
