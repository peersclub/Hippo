import { describe, expect, it } from 'vitest'
import { composeMemory } from '../src/orchestrator/memory-compose.js'

describe('composeMemory — authority-ordered layering', () => {
  it('orders layers platform → venue → user → session', () => {
    const { text, scopes } = composeMemory({
      session: 'asked about SOL earlier',
      user: 'prefers terse answers',
      host: 'KoinBX-style venue',
      global: 'never give advice',
    })
    expect(scopes).toEqual(['platform', 'venue', 'user', 'session'])
    // platform label appears before venue in the text
    expect(text.indexOf('PLATFORM RULES')).toBeLessThan(text.indexOf('VENUE CONTEXT'))
    expect(text.indexOf('VENUE CONTEXT')).toBeLessThan(text.indexOf('USER PROFILE'))
    expect(text.indexOf('USER PROFILE')).toBeLessThan(text.indexOf('THIS SESSION'))
  })

  it('omits empty/blank layers from both text and scopes', () => {
    const { text, scopes } = composeMemory({ global: 'rules', user: '   ', session: '' })
    expect(scopes).toEqual(['platform'])
    expect(text).not.toContain('USER PROFILE')
    expect(text).not.toContain('THIS SESSION')
  })

  it('folds the persona summary into the USER layer', () => {
    const { text, scopes } = composeMemory({ personaLine: 'pro trader · follows BTC, ETH' })
    expect(scopes).toEqual(['user'])
    expect(text).toContain('USER PROFILE')
    expect(text).toContain('pro trader')
  })

  it('user note and persona line combine under one USER layer', () => {
    const { scopes, text } = composeMemory({ user: 'terse', personaLine: 'pro' })
    expect(scopes).toEqual(['user'])
    expect(text).toContain('terse')
    expect(text).toContain('pro')
  })

  it('no layers → empty block, empty scopes (memory off costs nothing)', () => {
    expect(composeMemory({})).toEqual({ text: '', scopes: [] })
  })
})
