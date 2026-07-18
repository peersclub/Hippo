import { describe, expect, it } from 'vitest'
import { LOCALES } from '../src/i18n.js'
import {
  type ClearMemoryState,
  clearMemoryTransition,
  LANGUAGE_OPTIONS,
  toSettingsLanguage,
} from '../src/settings.js'

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
