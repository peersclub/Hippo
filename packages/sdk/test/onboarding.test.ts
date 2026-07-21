import { describe, expect, it } from 'vitest'
import { consentRows, createOnboardingStore, ONBOARDING_STEPS } from '../src/onboarding.js'

function fakePersistence() {
  let done = false
  return {
    isDone: () => done,
    markDone: () => {
      done = true
    },
  }
}

describe('onboarding gating store', () => {
  it('offers the flow on open until completion is persisted', () => {
    const store = createOnboardingStore(fakePersistence())
    expect(store.offerIfNeeded()).toBe(true)
    expect(store.active.value).toBe(true)
    expect(store.step.value).toBe(0)
  })

  it('"Not now" dismisses without persisting — the next open offers again', () => {
    const store = createOnboardingStore(fakePersistence())
    store.offerIfNeeded()
    store.next()
    store.dismiss()
    expect(store.active.value).toBe(false)
    // Consent is asked at the door every time until given.
    expect(store.offerIfNeeded()).toBe(true)
    expect(store.step.value).toBe(0) // always restarts from the welcome step
  })

  it('"Agree & start" persists completion — never auto-offered again', () => {
    const store = createOnboardingStore(fakePersistence())
    store.offerIfNeeded()
    store.complete()
    expect(store.active.value).toBe(false)
    expect(store.offerIfNeeded()).toBe(false)
    expect(store.active.value).toBe(false)
  })

  it('replay() re-opens the flow even after completion', () => {
    const store = createOnboardingStore(fakePersistence())
    store.offerIfNeeded()
    store.complete()
    store.replay()
    expect(store.active.value).toBe(true)
    expect(store.step.value).toBe(0)
  })

  it('next() advances but never past the last step', () => {
    const store = createOnboardingStore(fakePersistence())
    store.offerIfNeeded()
    for (let i = 0; i < 10; i++) store.next()
    expect(store.step.value).toBe(ONBOARDING_STEPS - 1)
  })
})

describe('consent rows config', () => {
  it('interpolates the venue name into the venue-data row', () => {
    const rows = consentRows('Assetworks')
    expect(rows[0]?.title).toBe('Your account & orders stay with Assetworks')
    expect(rows[0]?.control).toBe('static')
  })

  it('personal memory is a toggle defaulting ON', () => {
    const memory = consentRows('Assetworks').find((r) => r.id === 'memory')
    expect(memory?.control).toBe('toggle')
    expect(memory?.defaultOn).toBe(true)
  })

  it('the L2 row is the per-jurisdiction lever — a one-word control switch', () => {
    const l2 = consentRows('Assetworks').find((r) => r.id === 'l2')
    // Disclosed-in-terms today; flipping to 'checkbox' is the entire change.
    expect(l2?.control).toBe('static')
    expect(['static', 'toggle', 'checkbox']).toContain(l2?.control)
  })
})
