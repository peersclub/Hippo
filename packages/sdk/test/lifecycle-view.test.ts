import { describe, expect, it } from 'vitest'
import {
  cancelAffordance,
  confirmPendingSteps,
  fillMeter,
  isInFlight,
  journeySteps,
  sideBadge,
  terminalTitle,
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

describe('confirmPendingSteps — the confirm-in-flight loader', () => {
  it('reads PLACED (done) · WORKING (active) → FILLED (pending)', () => {
    expect(confirmPendingSteps().map((x) => `${x.labelKey}:${x.state}`)).toEqual([
      'journey_placed:done',
      'journey_working:active',
      'journey_filled:pending',
    ])
  })

  it('is static — it never advances client-side (lifecycle frames take over)', () => {
    expect(confirmPendingSteps()).toEqual(confirmPendingSteps())
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

describe('terminalTitle — the server describes its own completed trade', () => {
  it('a filled receipt keeps the SERVER’s statusLine, not the localized string', () => {
    expect(terminalTitle('filled', 'FILLED 0.05 BTC @ $61,240', 'Order filled')).toBe(
      'FILLED 0.05 BTC @ $61,240',
    )
  })

  it('the localized fallback appears only when a filled frame carries no statusLine', () => {
    expect(terminalTitle('filled', '', 'Order filled')).toBe('Order filled')
    expect(terminalTitle('filled', '   ', 'Order filled')).toBe('Order filled')
  })

  it('non-filled terminals draw their statusLine and never inherit "Order filled"', () => {
    expect(terminalTitle('cancelled', 'ORDER #A31 CANCELLED', 'Order filled')).toBe(
      'ORDER #A31 CANCELLED',
    )
    expect(terminalTitle('cancelled', '', 'Order filled')).toBe('')
    expect(terminalTitle('expired', '', 'Order filled')).toBe('')
  })
})

describe('fillMeter — the percentage is the server’s, the money is not rebuilt', () => {
  it('renders the server fillPct', () => {
    expect(fillMeter(40)).toEqual({ pct: '40%' })
    expect(fillMeter(0)).toEqual({ pct: '0%' })
  })

  it('no fillPct → no bar, no invented progress', () => {
    expect(fillMeter(undefined)).toBeNull()
  })

  it('takes no rows at all — a non-English frame can no longer lose its fill value', () => {
    // The old caption located the value with /^filled$/i over row labels and
    // recomposed "FILLED <value>"; a German or Hindi row label matched
    // nothing and the money disappeared. The meter now carries only the
    // percentage — the card draws the server's rows verbatim instead.
    expect(fillMeter.length).toBe(1)
    expect(JSON.stringify(fillMeter(60))).not.toMatch(/[0-9]+\s*\/\s*[0-9]+/)
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
