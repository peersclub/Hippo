import { describe, expect, it } from 'vitest'
import { MAX_DISPLAY_LEN, parseBridgeMessage, SYMBOL_RE } from '../src/bridge.js'

describe('SYMBOL_RE', () => {
  it('accepts plain BASE/QUOTE pairs (case-insensitive)', () => {
    expect(SYMBOL_RE.test('BTC/USDT')).toBe(true)
    expect(SYMBOL_RE.test('eth/usdt')).toBe(true)
    expect(SYMBOL_RE.test('1000PEPE/USDT')).toBe(true)
  })
  it('rejects anything that is not a pair of plain tokens', () => {
    expect(SYMBOL_RE.test('BTCUSDT')).toBe(false)
    expect(SYMBOL_RE.test('BTC/USDT/PERP')).toBe(false)
    expect(SYMBOL_RE.test('BTC-USDT')).toBe(false)
    expect(SYMBOL_RE.test('<script>/USDT')).toBe(false)
    expect(SYMBOL_RE.test('B/USDT')).toBe(false) // base too short
    expect(SYMBOL_RE.test('VERYLONGBASE/USDT')).toBe(false) // base too long
    expect(SYMBOL_RE.test(' BTC/USDT')).toBe(false)
    expect(SYMBOL_RE.test('')).toBe(false)
  })
})

describe('parseBridgeMessage — untrusted window messages', () => {
  it('accepts a valid symbol-only context, normalized to uppercase', () => {
    expect(parseBridgeMessage({ type: 'hippo:context', symbol: 'eth/usdt' })).toEqual({
      symbol: 'ETH/USDT',
    })
  })

  it('accepts a valid price-only context', () => {
    expect(
      parseBridgeMessage({
        type: 'hippo:context',
        price: { last: 63631.63, lastDisplay: '63,631.63' },
      }),
    ).toEqual({ price: { last: 63631.63, lastDisplay: '63,631.63' } })
  })

  it('accepts symbol + price together and tolerates a missing lastDisplay', () => {
    expect(
      parseBridgeMessage({ type: 'hippo:context', symbol: 'BTC/USDT', price: { last: 1 } }),
    ).toEqual({ symbol: 'BTC/USDT', price: { last: 1, lastDisplay: undefined } })
  })

  it('ignores everything that is not a hippo:context object', () => {
    expect(parseBridgeMessage(null)).toBeNull()
    expect(parseBridgeMessage(undefined)).toBeNull()
    expect(parseBridgeMessage('hippo:context')).toBeNull()
    expect(parseBridgeMessage(42)).toBeNull()
    expect(parseBridgeMessage([])).toBeNull()
    expect(parseBridgeMessage({})).toBeNull()
    expect(parseBridgeMessage({ type: 'other:event', symbol: 'BTC/USDT' })).toBeNull()
    // React devtools / analytics noise on the same channel
    expect(parseBridgeMessage({ source: 'react-devtools-bridge', payload: {} })).toBeNull()
  })

  it('rejects a context with NEITHER symbol nor price (nothing to apply)', () => {
    expect(parseBridgeMessage({ type: 'hippo:context' })).toBeNull()
  })

  it('rejects the whole message on a mistyped or malformed symbol', () => {
    expect(parseBridgeMessage({ type: 'hippo:context', symbol: 42 })).toBeNull()
    expect(parseBridgeMessage({ type: 'hippo:context', symbol: 'BTCUSDT' })).toBeNull()
    expect(parseBridgeMessage({ type: 'hippo:context', symbol: '<img onerror=x>/USDT' })).toBeNull()
    // A bad symbol invalidates the message even when the price half is fine.
    expect(
      parseBridgeMessage({ type: 'hippo:context', symbol: 'nope', price: { last: 1 } }),
    ).toBeNull()
  })

  it('rejects the whole message on a mistyped price', () => {
    expect(parseBridgeMessage({ type: 'hippo:context', price: 63631 })).toBeNull()
    expect(parseBridgeMessage({ type: 'hippo:context', price: { last: '63631' } })).toBeNull()
    expect(parseBridgeMessage({ type: 'hippo:context', price: { last: Number.NaN } })).toBeNull()
    expect(parseBridgeMessage({ type: 'hippo:context', price: { last: Infinity } })).toBeNull()
    expect(parseBridgeMessage({ type: 'hippo:context', price: { last: 0 } })).toBeNull()
    expect(parseBridgeMessage({ type: 'hippo:context', price: { last: -5 } })).toBeNull()
    expect(parseBridgeMessage({ type: 'hippo:context', price: {} })).toBeNull()
    expect(parseBridgeMessage({ type: 'hippo:context', price: [] })).toBeNull()
  })

  it('rejects a lastDisplay that is mistyped, empty or oversized', () => {
    expect(
      parseBridgeMessage({ type: 'hippo:context', price: { last: 1, lastDisplay: 42 } }),
    ).toBeNull()
    expect(
      parseBridgeMessage({ type: 'hippo:context', price: { last: 1, lastDisplay: '' } }),
    ).toBeNull()
    expect(
      parseBridgeMessage({
        type: 'hippo:context',
        price: { last: 1, lastDisplay: 'x'.repeat(MAX_DISPLAY_LEN + 1) },
      }),
    ).toBeNull()
  })
})
