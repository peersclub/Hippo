import { describe, expect, it } from 'vitest'
import { COUNTER_AT, counterLabel, enterAction, MAX_USER_TEXT } from '../src/composer.js'

describe('counterLabel', () => {
  it('stays hidden below the threshold', () => {
    expect(counterLabel(0)).toBeNull()
    expect(counterLabel(COUNTER_AT - 1)).toBeNull()
  })
  it('appears at the threshold', () => {
    expect(counterLabel(COUNTER_AT)).toBe(`${COUNTER_AT} / ${MAX_USER_TEXT}`)
  })
  it('shows the limit at max', () => {
    expect(counterLabel(MAX_USER_TEXT)).toBe(`${MAX_USER_TEXT} / ${MAX_USER_TEXT}`)
  })
})

describe('enterAction', () => {
  it('Enter sends', () => {
    expect(enterAction('Enter', false)).toBe('send')
  })
  it('Shift+Enter makes a newline', () => {
    expect(enterAction('Enter', true)).toBe('newline')
  })
  it('other keys are typing', () => {
    expect(enterAction('a', false)).toBeNull()
    expect(enterAction('Escape', false)).toBeNull()
    expect(enterAction('a', true)).toBeNull()
  })
})
