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

  it('folds auto-learned SESSION facts into the SESSION layer', () => {
    const { text, scopes } = composeMemory({ sessionFacts: '- follows: BTC' })
    expect(scopes).toEqual(['session'])
    expect(text).toContain('THIS SESSION')
    expect(text).toContain('follows: BTC')
  })

  it('session note and session facts combine under one SESSION layer', () => {
    const { scopes, text } = composeMemory({
      session: 'asked about SOL earlier',
      sessionFacts: '- prefers: perps',
    })
    expect(scopes).toEqual(['session'])
    expect(text).toContain('asked about SOL earlier')
    expect(text).toContain('prefers: perps')
  })

  it('learned facts stay BELOW platform rules (guardrail authority preserved)', () => {
    const { text } = composeMemory({
      global: 'never give advice',
      userFacts: '- experience: pro',
      sessionFacts: '- follows: ETH',
    })
    expect(text.indexOf('PLATFORM RULES')).toBeLessThan(text.indexOf('experience: pro'))
    expect(text.indexOf('USER PROFILE')).toBeLessThan(text.indexOf('THIS SESSION'))
  })
})
