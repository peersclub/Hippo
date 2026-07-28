import { describe, expect, it } from 'vitest'
import {
  formatPriceDisplay,
  normalizePriceSource,
  parseTicker,
  tickerWsUrl,
  wsSymbol,
} from '../src/price.js'

describe('normalizePriceSource', () => {
  it('accepts the two active modes', () => {
    expect(normalizePriceSource('client')).toBe('client')
    expect(normalizePriceSource('host')).toBe('host')
  })
  it('defaults everything else to server', () => {
    expect(normalizePriceSource('server')).toBe('server')
    expect(normalizePriceSource('')).toBe('server')
    expect(normalizePriceSource(undefined)).toBe('server')
    expect(normalizePriceSource(null)).toBe('server')
    expect(normalizePriceSource('binance')).toBe('server')
  })
})

describe('WS URL builder', () => {
  it('lowercases and drops the slash for the stream symbol', () => {
    expect(wsSymbol('BTC/USDT')).toBe('btcusdt')
    expect(wsSymbol('SOL/USDT')).toBe('solusdt')
  })
  it('builds the single-symbol public ticker stream URL', () => {
    expect(tickerWsUrl('BTC/USDT')).toBe('wss://stream.binance.com:9443/ws/btcusdt@ticker')
  })
})

describe('formatPriceDisplay', () => {
  it('mirrors the host convention: 2dp at ≥1000, 4dp below', () => {
    expect(formatPriceDisplay(63631.631)).toBe('63,631.63')
    expect(formatPriceDisplay(1000)).toBe('1,000.00')
    expect(formatPriceDisplay(0.51234)).toBe('0.5123')
  })
})

describe('parseTicker', () => {
  const raw = JSON.stringify({
    e: '24hrTicker',
    s: 'BTCUSDT',
    c: '63631.63',
    P: '-4.20',
    E: 1_753_600_000_000,
  })

  it('parses last price, change % and event time for the subscribed symbol', () => {
    const tick = parseTicker(raw, 'BTC/USDT')
    expect(tick).not.toBeNull()
    expect(tick?.symbol).toBe('BTC/USDT')
    expect(tick?.last).toBe(63631.63)
    expect(tick?.lastDisplay).toBe('63,631.63')
    expect(tick?.changePct).toBe(-4.2)
    expect(tick?.asOfIso).toBe(new Date(1_753_600_000_000).toISOString())
  })

  it('rejects a tick for a DIFFERENT symbol (stale socket mid-resubscribe)', () => {
    expect(parseTicker(raw, 'ETH/USDT')).toBeNull()
  })

  it('rejects junk bytes, non-objects and missing/invalid last price', () => {
    expect(parseTicker('not json{', 'BTC/USDT')).toBeNull()
    expect(parseTicker('42', 'BTC/USDT')).toBeNull()
    expect(parseTicker('null', 'BTC/USDT')).toBeNull()
    expect(parseTicker(JSON.stringify({ s: 'BTCUSDT' }), 'BTC/USDT')).toBeNull()
    expect(parseTicker(JSON.stringify({ s: 'BTCUSDT', c: 'abc' }), 'BTC/USDT')).toBeNull()
    expect(parseTicker(JSON.stringify({ s: 'BTCUSDT', c: '0' }), 'BTC/USDT')).toBeNull()
    expect(parseTicker(JSON.stringify({ s: 'BTCUSDT', c: '-5' }), 'BTC/USDT')).toBeNull()
    expect(parseTicker(JSON.stringify({ s: 42, c: '100' }), 'BTC/USDT')).toBeNull()
  })

  it('tolerates a missing change % (optional in the LivePrice shape)', () => {
    const tick = parseTicker(JSON.stringify({ s: 'SOLUSDT', c: '151.4200' }), 'SOL/USDT')
    expect(tick?.last).toBe(151.42)
    expect(tick?.changePct).toBeUndefined()
    expect(tick?.lastDisplay).toBe('151.4200')
  })
})
