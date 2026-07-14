import { describe, expect, it } from 'vitest'
import { getSnapshot } from '../src/service.js'
import {
  buildSnapshot,
  formatFunding,
  formatPrice,
  formatSignedPct,
  loadFixtureInputs,
} from '../src/snapshot.js'

describe('formatters', () => {
  it('formats prices with commas', () => {
    expect(formatPrice(61240)).toBe('61,240')
    expect(formatPrice(168.4)).toBe('168.4')
    expect(formatPrice(0.5213)).toBe('0.5213')
  })

  it('formats signed percentages with a typographic minus', () => {
    expect(formatSignedPct(-4.18)).toBe('−4.2%')
    expect(formatSignedPct(1.25)).toBe('+1.3%')
  })

  it('formats funding rates to 3 decimals', () => {
    expect(formatFunding(-0.00008)).toBe('−0.008%')
    expect(formatFunding(0.0001)).toBe('+0.010%')
  })
})

describe('buildSnapshot (fixture inputs)', () => {
  const inputs = loadFixtureInputs('BTC/USDT')
  if (!inputs) throw new Error('btc-usdt fixture missing')

  it('produces the full snapshot shape', () => {
    const asOf = new Date('2026-07-14T09:02:05.000Z')
    const snap = buildSnapshot(inputs, asOf)

    expect(snap.symbol).toBe('BTC/USDT')
    expect(snap.last).toBe(61240)
    expect(snap.lastDisplay).toBe('61,240')
    expect(snap.change12hPct).toBeCloseTo(-4.18, 2)
    expect(snap.change12hDisplay).toBe('−4.2%')
    expect(snap.fundingRate).toBe(-0.00008)
    expect(snap.fundingDisplay).toBe('−0.008%')
    expect(snap.spark).toHaveLength(13)
    expect(snap.spark.every((p) => typeof p === 'number')).toBe(true)
    expect(snap.asOfIso).toBe('2026-07-14T09:02:05.000Z')
    expect(snap.sources).toEqual(['FIXTURE'])
  })

  it('handles null funding gracefully', () => {
    const snap = buildSnapshot({ ...inputs, fundingRate: null })
    expect(snap.fundingRate).toBeNull()
    expect(snap.fundingDisplay).toBeNull()
  })
})

describe('getSnapshot in FIXTURES mode', () => {
  it('serves the recorded fixture with asOfIso stamped at request time', async () => {
    const before = Date.now()
    const snap = await getSnapshot('BTC/USDT', { fixtures: true })
    const stamped = Date.parse(snap.asOfIso)

    expect(snap.sources).toEqual(['FIXTURE'])
    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(Date.now())
  })

  it('rejects symbols without a recorded fixture', async () => {
    await expect(getSnapshot('DOGE/USDT', { fixtures: true })).rejects.toThrow(/no fixture/)
  })
})
