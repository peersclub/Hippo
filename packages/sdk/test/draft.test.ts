import { describe, expect, it } from 'vitest'
import {
  assembleDraftParams,
  clampLeverage,
  DEFAULT_LEVERAGE,
  DEFAULT_MAX_LEVERAGE,
  type DraftEdit,
  initialLeverage,
  maxLeverageOf,
  sizeValid,
} from '../src/draft.js'

describe('sizeValid — the submit gate', () => {
  it('accepts positive decimal sizes', () => {
    expect(sizeValid('0.05')).toBe(true)
    expect(sizeValid('1')).toBe(true)
    expect(sizeValid(' 2.5 ')).toBe(true)
  })
  it('rejects empty, zero, negative and non-numeric input', () => {
    expect(sizeValid('')).toBe(false)
    expect(sizeValid('   ')).toBe(false)
    expect(sizeValid('0')).toBe(false)
    expect(sizeValid('-1')).toBe(false)
    expect(sizeValid('abc')).toBe(false)
    expect(sizeValid('0.05 BTC')).toBe(false)
    expect(sizeValid('Infinity')).toBe(false)
  })
})

describe('leverage bounds', () => {
  it('clamps into [1, max] as an integer', () => {
    expect(clampLeverage(13, 50)).toBe(13)
    expect(clampLeverage(999, 50)).toBe(50)
    expect(clampLeverage(0, 50)).toBe(1)
    expect(clampLeverage(-5, 50)).toBe(1)
    expect(clampLeverage(7.9, 50)).toBe(7)
  })
  it('falls back to the defaults on junk numbers', () => {
    expect(clampLeverage(Number.NaN, 50)).toBe(DEFAULT_LEVERAGE)
    expect(clampLeverage(10, Number.NaN)).toBe(10)
  })
  it('maxLeverageOf uses the venue cap, else the default 50', () => {
    expect(maxLeverageOf({ maxLeverage: 25 })).toBe(25)
    expect(maxLeverageOf({})).toBe(DEFAULT_MAX_LEVERAGE)
  })
  it('initialLeverage seeds from the frame (default 10) inside bounds', () => {
    expect(initialLeverage({ leverage: 13, maxLeverage: 50 })).toBe(13)
    expect(initialLeverage({})).toBe(DEFAULT_LEVERAGE)
    // A frame leverage above the venue cap can't seed the slider off-scale.
    expect(initialLeverage({ leverage: 100, maxLeverage: 25 })).toBe(25)
  })
})

const baseEdit: DraftEdit = {
  capability: 'spot',
  instrument: 'BTC/USDT',
  orderType: 'market',
  size: '0.05',
  limitPrice: '',
  leverage: 10,
  maxLeverage: 50,
  marginMode: undefined,
}

describe('assembleDraftParams — the echoed edit', () => {
  it('spot market: instrument + orderType + size only', () => {
    expect(assembleDraftParams(baseEdit)).toEqual({
      instrument: 'BTC/USDT',
      orderType: 'market',
      size: '0.05',
    })
  })

  it('trims the size string', () => {
    expect(assembleDraftParams({ ...baseEdit, size: ' 0.05 ' }).size).toBe('0.05')
  })

  it('carries limitPrice ONLY on limit orders', () => {
    const limit = assembleDraftParams({ ...baseEdit, orderType: 'limit', limitPrice: '63000' })
    expect(limit.limitPrice).toBe('63000')
    // A market order never echoes a stale limit price the trader typed earlier.
    const market = assembleDraftParams({ ...baseEdit, orderType: 'market', limitPrice: '63000' })
    expect(market.limitPrice).toBeUndefined()
  })

  it('omits an empty limitPrice even on limit orders (server decides)', () => {
    const p = assembleDraftParams({ ...baseEdit, orderType: 'limit', limitPrice: '  ' })
    expect(p.limitPrice).toBeUndefined()
  })

  it('perp: carries leverage (clamped to the venue bound) and marginMode', () => {
    const p = assembleDraftParams({
      ...baseEdit,
      capability: 'futures_perp',
      leverage: 999,
      maxLeverage: 25,
      marginMode: 'isolated',
    })
    expect(p.leverage).toBe(25)
    expect(p.marginMode).toBe('isolated')
  })

  it('spot: never carries leverage or marginMode, even if set', () => {
    const p = assembleDraftParams({ ...baseEdit, leverage: 13, marginMode: 'cross' })
    expect(p.leverage).toBeUndefined()
    expect(p.marginMode).toBeUndefined()
  })

  it('perp without a margin mode omits the field (single-mode venue)', () => {
    const p = assembleDraftParams({ ...baseEdit, capability: 'futures_perp' })
    expect(p.leverage).toBe(10)
    expect(p.marginMode).toBeUndefined()
  })
})
