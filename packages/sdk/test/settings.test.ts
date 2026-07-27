import { describe, expect, it } from 'vitest'
import { LOCALES } from '../src/i18n.js'
import {
  type ClearMemoryState,
  clearLearnedMemoryUplink,
  clearMemoryTransition,
  groupLearnedFacts,
  LANGUAGE_OPTIONS,
  showLearnedMemory,
  toSettingsLanguage,
} from '../src/settings.js'
import type { LearnedFact } from '../src/state.js'

const fact = (label: string, scope: 'user' | 'session', value = label): LearnedFact => ({
  label,
  type: 'followed_asset',
  value,
  scope,
})

describe('LANGUAGE_OPTIONS', () => {
  it('covers every supported locale exactly once', () => {
    expect(LANGUAGE_OPTIONS.map((o) => o.locale).sort()).toEqual([...LOCALES].sort())
  })
  it('maps hi-Latn onto the hinglish uplink value', () => {
    expect(toSettingsLanguage('hi-Latn')).toBe('hinglish')
  })
  it('maps the direct locales 1:1', () => {
    expect(toSettingsLanguage('en')).toBe('en')
    expect(toSettingsLanguage('hi')).toBe('hi')
    expect(toSettingsLanguage('ar')).toBe('ar')
  })
})

describe('clearMemoryTransition', () => {
  const idle: ClearMemoryState = { phase: 'idle' }

  it('request opens the confirm step, no uplink yet', () => {
    const r = clearMemoryTransition(idle, { type: 'request' })
    expect(r.state.phase).toBe('confirming')
    expect(r.uplink).toBeUndefined()
  })
  it('confirm from idle is a no-op (never skips the confirm step)', () => {
    const r = clearMemoryTransition(idle, { type: 'confirm' })
    expect(r.state.phase).toBe('idle')
    expect(r.uplink).toBeUndefined()
  })
  it('confirm fires the uplink exactly once', () => {
    const confirming = clearMemoryTransition(idle, { type: 'request' }).state
    const r = clearMemoryTransition(confirming, { type: 'confirm' })
    expect(r.state.phase).toBe('done')
    expect(r.uplink).toEqual({ clearMemory: true })
    // replay against the terminal state: silent no-op
    const replay = clearMemoryTransition(r.state, { type: 'confirm' })
    expect(replay.state.phase).toBe('done')
    expect(replay.uplink).toBeUndefined()
  })
  it('cancel returns to idle without an uplink', () => {
    const confirming = clearMemoryTransition(idle, { type: 'request' }).state
    const r = clearMemoryTransition(confirming, { type: 'cancel' })
    expect(r.state.phase).toBe('idle')
    expect(r.uplink).toBeUndefined()
  })
})

describe('showLearnedMemory (learned-memory section gate)', () => {
  const facts = [fact('Follows BTC', 'user')]

  it('shows only when memoryLab is granted AND there are facts', () => {
    expect(showLearnedMemory({ memoryLab: true }, facts)).toBe(true)
  })
  it('is HIDDEN when the entitlement is absent (older plan)', () => {
    expect(showLearnedMemory({}, facts)).toBe(false)
  })
  it('is HIDDEN when the entitlement is present but not true', () => {
    expect(showLearnedMemory({ memoryLab: false }, facts)).toBe(false)
    expect(showLearnedMemory({ memoryLab: 'yes' }, facts)).toBe(false)
  })
  it('is HIDDEN when there are no facts, even with the entitlement', () => {
    // Post-clear (empty frame) empties the section.
    expect(showLearnedMemory({ memoryLab: true }, [])).toBe(false)
  })
})

describe('groupLearnedFacts', () => {
  it('splits facts into the durable (user) and this-chat (session) groups', () => {
    const g = groupLearnedFacts([
      fact('Follows BTC', 'user'),
      fact('Asking about ETH today', 'session'),
      fact('Prefers plain language', 'user'),
    ])
    expect(g.remembered.map((f) => f.label)).toEqual(['Follows BTC', 'Prefers plain language'])
    expect(g.session.map((f) => f.label)).toEqual(['Asking about ETH today'])
  })
  it('yields empty groups for an empty set', () => {
    expect(groupLearnedFacts([])).toEqual({ remembered: [], session: [] })
  })
})

describe('clearLearnedMemoryUplink', () => {
  it('is a settings uplink carrying clearLearnedMemory:true (the one-tap clear)', () => {
    expect(clearLearnedMemoryUplink()).toEqual({ kind: 'settings', clearLearnedMemory: true })
  })
})
