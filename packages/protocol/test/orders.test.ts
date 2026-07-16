import { describe, expect, it } from 'vitest'
import {
  CanonicalOrder,
  type Capability,
  enabledCapabilities,
  VenueCapabilities,
} from '../src/orders.js'

describe('CanonicalOrder — discriminated by capability', () => {
  it('parses a spot order', () => {
    const r = CanonicalOrder.safeParse({
      capability: 'spot',
      instrument: 'BTC/USDT',
      side: 'buy',
      size: '0.5',
      orderType: 'market',
    })
    expect(r.success).toBe(true)
  })

  it('parses a leveraged futures order', () => {
    const r = CanonicalOrder.safeParse({
      capability: 'futures_perp',
      instrument: 'BTC/USDT',
      direction: 'long',
      leverage: 13,
      marginMode: 'isolated',
      size: '0.5',
      orderType: 'market',
    })
    expect(r.success).toBe(true)
    if (r.success && r.data.capability === 'futures_perp') {
      expect(r.data.direction).toBe('long')
      expect(r.data.action).toBe('open') // defaulted
      expect(r.data.reduceOnly).toBe(false) // defaulted
    }
  })

  it('parses an options order', () => {
    const r = CanonicalOrder.safeParse({
      capability: 'options',
      underlying: 'BTC',
      optionType: 'call',
      side: 'buy',
      strike: '70000',
      expiry: '2026-08-29',
      size: '1',
      orderType: 'limit',
      limitPrice: '2500',
    })
    expect(r.success).toBe(true)
  })

  it('rejects a futures order with non-positive leverage', () => {
    const r = CanonicalOrder.safeParse({
      capability: 'futures_perp',
      instrument: 'BTC/USDT',
      direction: 'long',
      leverage: 0,
      marginMode: 'cross',
      size: '1',
      orderType: 'market',
    })
    expect(r.success).toBe(false)
  })

  it('rejects an unknown capability', () => {
    expect(CanonicalOrder.safeParse({ capability: 'swaps', instrument: 'X' }).success).toBe(false)
  })
})

describe('VenueCapabilities — presence = enabled', () => {
  it('lists only capabilities whose params are present', () => {
    const caps = VenueCapabilities.parse({
      spot: {},
      futures_perp: { maxLeverage: 20, marginModes: ['isolated', 'cross'] },
    })
    expect(enabledCapabilities(caps).sort()).toEqual(['futures_perp', 'spot'])
    expect(enabledCapabilities(caps)).not.toContain('options' as Capability)
  })

  it('a spot-only venue enables only spot', () => {
    expect(enabledCapabilities(VenueCapabilities.parse({ spot: {} }))).toEqual(['spot'])
  })
})
