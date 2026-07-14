import { describe, expect, it } from 'vitest'
import {
  EXAMPLE_INTENTS,
  NEW_ORDER,
  parseOrderSummary,
  toggleExpand,
} from '../src/orders-expand.js'
import { composerPrefill, prefillComposer, takeComposerPrefill } from '../src/state.js'

describe('order pill expand toggle', () => {
  it('expands a pill, collapses on second tap', () => {
    expect(toggleExpand(null, 'o1')).toBe('o1')
    expect(toggleExpand('o1', 'o1')).toBeNull()
  })

  it('switches directly between pills', () => {
    expect(toggleExpand('o1', 'o2')).toBe('o2')
    expect(toggleExpand('o2', NEW_ORDER)).toBe(NEW_ORDER)
    expect(toggleExpand(NEW_ORDER, NEW_ORDER)).toBeNull()
  })
})

describe('order summary display parsing', () => {
  it('splits a server-formatted summary into main line + detail badges', () => {
    expect(parseOrderSummary('BUY 0.05 BTC · MKT')).toEqual({
      main: 'BUY 0.05 BTC',
      details: ['MKT'],
    })
  })

  it('keeps extra segments as further details', () => {
    expect(parseOrderSummary('SELL 2 SOL · LMT · GTC')).toEqual({
      main: 'SELL 2 SOL',
      details: ['LMT', 'GTC'],
    })
  })

  it('handles summaries with no separator', () => {
    expect(parseOrderSummary('BUY 1 ETH')).toEqual({ main: 'BUY 1 ETH', details: [] })
  })
})

describe('composer prefill signal', () => {
  it('is consumed exactly once — fill, never auto-send', () => {
    composerPrefill.value = null
    prefillComposer('buy 0.05 btc at market')
    expect(takeComposerPrefill()).toBe('buy 0.05 btc at market')
    expect(takeComposerPrefill()).toBeNull()
  })

  it('ships two example intents for the new-order hint', () => {
    expect(EXAMPLE_INTENTS).toHaveLength(2)
    for (const t of EXAMPLE_INTENTS) expect(t.length).toBeGreaterThan(0)
  })
})
