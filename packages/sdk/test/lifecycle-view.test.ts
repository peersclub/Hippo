import { describe, expect, it } from 'vitest'
import {
  cancelAffordance,
  fillCaption,
  isInFlight,
  journeySteps,
  sideBadge,
  ticketStateClass,
} from '../src/lifecycle-view.js'

describe('journeySteps — the line only advances on real server frames', () => {
  it('legacy awaiting_confirm (no stage) shows no journey — the plain pulse row', () => {
    expect(journeySteps('awaiting_confirm', undefined)).toBeNull()
  })

  it('an UNKNOWN future stage degrades to the bare phase, never fails', () => {
    expect(journeySteps('awaiting_confirm', 'venue_review')).toBeNull()
  })

  it('placing: prepared done, placing active, working/filled pending', () => {
    const s = journeySteps('awaiting_confirm', 'placing')
    expect(s?.map((x) => `${x.key}:${x.state}`)).toEqual([
      'prepared:done',
      'placing:active',
      'working:pending',
      'terminal:pending',
    ])
  })

  it('working: placing done, working active', () => {
    const s = journeySteps('awaiting_confirm', 'working')
    expect(s?.find((x) => x.key === 'placing')?.state).toBe('done')
    expect(s?.find((x) => x.key === 'working')?.state).toBe('active')
  })

  it('a partial IS working, even from a legacy server without a stage', () => {
    const s = journeySteps('partial', undefined)
    expect(s?.find((x) => x.key === 'working')?.state).toBe('active')
  })

  it('cancel_pending swaps the terminal to CANCELLING', () => {
    const s = journeySteps('awaiting_confirm', 'cancel_pending')
    expect(s?.at(-1)).toEqual({ key: 'terminal', labelKey: 'journey_cancelling', state: 'active' })
  })

  it('terminal phases show no journey — receipts are facts, not progress', () => {
    for (const phase of ['filled', 'cancelled', 'expired'] as const) {
      expect(journeySteps(phase, undefined)).toBeNull()
    }
  })
})

describe('ticketStateClass — prototype state modifiers', () => {
  it('filled=ok, partial/expired=part (amber attention), cancelled=cxl (neutral, no judgment)', () => {
    expect(ticketStateClass('filled')).toBe('ok')
    expect(ticketStateClass('partial')).toBe('part')
    expect(ticketStateClass('expired')).toBe('part')
    expect(ticketStateClass('cancelled')).toBe('cxl')
    expect(ticketStateClass('awaiting_confirm')).toBe('')
  })
})

describe('sideBadge', () => {
  it('with a server side, reads like the prototype receipt', () => {
    expect(sideBadge('filled', 'buy')).toEqual({ cls: 'side buy', text: 'BUY · FILLED' })
    expect(sideBadge('partial', 'sell')).toEqual({ cls: 'side sell', text: 'SELL · PARTIAL' })
  })

  it('cancelled/expired are neutral even when the side is known — no verdict colors', () => {
    expect(sideBadge('cancelled', 'buy').cls).toBe('side dim')
    expect(sideBadge('expired', 'sell').cls).toBe('side dim')
  })

  it('without a side (old gateway) the badge is neutral — fixes the green CANCELLED', () => {
    expect(sideBadge('cancelled', undefined)).toEqual({ cls: 'side dim', text: 'CANCELLED' })
    expect(sideBadge('filled', undefined).cls).toBe('side buy') // fills stay green
  })
})

describe('fillCaption — server numbers only', () => {
  it('renders the server Filled row + fillPct', () => {
    expect(fillCaption([{ label: 'Filled', value: '0.02 / 0.05' }], 40)).toEqual({
      left: 'FILLED 0.02 / 0.05',
      right: '40%',
    })
  })

  it('no fillPct → no bar, no invented progress', () => {
    expect(fillCaption([{ label: 'Filled', value: '1 / 2' }], undefined)).toBeNull()
  })

  it('fillPct without a Filled row still captions honestly', () => {
    expect(fillCaption([], 60)).toEqual({ left: 'FILLED', right: '60%' })
  })
})

describe('cancelAffordance', () => {
  it('cancellable in-flight → button; cancel_pending → pulse only; terminal → none', () => {
    expect(cancelAffordance('awaiting_confirm', 'working', true)).toBe('button')
    expect(cancelAffordance('partial', 'working', true)).toBe('button')
    expect(cancelAffordance('awaiting_confirm', 'cancel_pending', false)).toBe('pending')
    expect(cancelAffordance('awaiting_confirm', 'placing', false)).toBe('none')
    expect(cancelAffordance('filled', undefined, false)).toBe('none')
  })
})

describe('isInFlight — the LIVE footer gate', () => {
  it('awaiting_confirm and partial are in flight; terminals are not', () => {
    expect(isInFlight('awaiting_confirm')).toBe(true)
    expect(isInFlight('partial')).toBe(true)
    expect(isInFlight('filled')).toBe(false)
    expect(isInFlight('cancelled')).toBe(false)
    expect(isInFlight('expired')).toBe(false)
  })
})
