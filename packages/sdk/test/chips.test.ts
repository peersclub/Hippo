import { describe, expect, it } from 'vitest'
import { LONG_PRESS_MS, pressAction, resolveChips, roveIndex } from '../src/chips.js'
import type { ThreadItem } from '../src/state.js'

const base = { v: 1 as const, ts: 1 }

const brief = (id: string, followups: string[]): ThreadItem => ({
  kind: 'frame',
  frame: {
    ...base,
    id,
    type: 'research_brief',
    eyebrow: 'MARKET BRIEF',
    live: false,
    headline: 'h',
    paragraphs: [],
    stats: [],
    sources: [],
    followups,
  },
})

const decline = (id: string, followups: string[]): ThreadItem => ({
  kind: 'frame',
  frame: {
    ...base,
    id,
    type: 'advice_decline',
    badge: 'b',
    message: 'm',
    pivotTitle: 'p',
    facts: [],
    followups,
  },
})

const echo = (id: string): ThreadItem => ({
  kind: 'frame',
  frame: { ...base, id, type: 'user_echo', text: 'hi' },
})

const SESSION = ['s1', 's2']

describe('resolveChips', () => {
  it('falls back to session chips on an empty thread', () => {
    expect(resolveChips([], SESSION)).toEqual(SESSION)
  })

  it('uses the latest brief followups', () => {
    const items = [echo('u1'), brief('b1', ['f1', 'f2'])]
    expect(resolveChips(items, SESSION)).toEqual(['f1', 'f2'])
  })

  it('decline followups win over an older brief', () => {
    const items = [brief('b1', ['old']), decline('d1', ['new'])]
    expect(resolveChips(items, SESSION)).toEqual(['new'])
  })

  it('skips empty followups and keeps looking backwards', () => {
    const items = [brief('b1', ['kept']), echo('u2'), brief('b2', [])]
    expect(resolveChips(items, SESSION)).toEqual(['kept'])
  })

  it('non-followup frames after a brief do not clear its followups', () => {
    const items = [brief('b1', ['f']), echo('u2')]
    expect(resolveChips(items, SESSION)).toEqual(['f'])
  })

  it('ignores unknown frames', () => {
    const items: ThreadItem[] = [
      { kind: 'unknown', frame: { ...base, id: 'x', type: 'future_thing' } },
    ]
    expect(resolveChips(items, SESSION)).toEqual(SESSION)
  })
})

describe('pressAction', () => {
  it('classifies below the threshold as send', () => {
    expect(pressAction(LONG_PRESS_MS - 1)).toBe('send')
  })
  it('classifies at/above the threshold as edit', () => {
    expect(pressAction(LONG_PRESS_MS)).toBe('edit')
    expect(pressAction(LONG_PRESS_MS + 500)).toBe('edit')
  })
})

describe('roveIndex', () => {
  it('advances and wraps with ArrowRight in LTR', () => {
    expect(roveIndex(0, 3, 'ArrowRight', false)).toBe(1)
    expect(roveIndex(2, 3, 'ArrowRight', false)).toBe(0)
  })
  it('retreats and wraps with ArrowLeft in LTR', () => {
    expect(roveIndex(0, 3, 'ArrowLeft', false)).toBe(2)
  })
  it('inverts arrows under RTL (forward follows reading order)', () => {
    expect(roveIndex(0, 3, 'ArrowLeft', true)).toBe(1)
    expect(roveIndex(1, 3, 'ArrowRight', true)).toBe(0)
  })
  it('Home and End jump to the extremes', () => {
    expect(roveIndex(1, 3, 'Home', false)).toBe(0)
    expect(roveIndex(1, 3, 'End', false)).toBe(2)
  })
  it('unhandled keys return the clamped current index', () => {
    expect(roveIndex(9, 3, 'a', false)).toBe(2)
    expect(roveIndex(1, 3, 'Enter', false)).toBe(1)
  })
  it('empty set returns 0', () => {
    expect(roveIndex(0, 0, 'ArrowRight', false)).toBe(0)
  })
})
