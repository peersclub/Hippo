import { beforeAll, describe, expect, it } from 'vitest'

// The router reads location/window at import time — stub the browser globals
// first, then import dynamically. Node test env, no jsdom dependency.
const listeners: Record<string, (() => void)[]> = {}
const fakeLocation = { hash: '' }

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).location = fakeLocation
  ;(globalThis as Record<string, unknown>).window = {
    addEventListener: (event: string, fn: () => void) => {
      listeners[event] ??= []
      listeners[event].push(fn)
    },
  }
})

function fireHashChange(hash: string) {
  fakeLocation.hash = hash
  for (const fn of listeners.hashchange ?? []) fn()
}

describe('hash router', () => {
  it('parses pages, params, and defaults; reacts to hashchange; navigates', async () => {
    const { route, navigate } = await import('../src/router.js')

    // Default with empty hash.
    expect(route.value).toEqual({ page: 'dashboard', params: [] })

    fireHashChange('#/partners')
    expect(route.value).toEqual({ page: 'partners', params: [] })

    // Params are split and URI-decoded (user ids can contain anything).
    fireHashChange('#/users/koinbx-dev/venue%3Auser%2F42')
    expect(route.value).toEqual({ page: 'users', params: ['koinbx-dev', 'venue:user/42'] })

    navigate('plans')
    expect(fakeLocation.hash).toBe('#/plans')
    navigate('#/audit')
    expect(fakeLocation.hash).toBe('#/audit')
  })
})
