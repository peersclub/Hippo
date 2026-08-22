import { beforeAll, describe, expect, it } from 'vitest'

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

describe('createHashRouter', () => {
  it('parses pages, params, and defaults; reacts to hashchange; navigates', async () => {
    const { createHashRouter } = await import('../src/router/hash.js')
    const { route, navigate } = createHashRouter('dashboard')

    expect(route.value).toEqual({ page: 'dashboard', params: [] })

    fireHashChange('#/partners')
    expect(route.value).toEqual({ page: 'partners', params: [] })

    fireHashChange('#/users/koinbx-dev/venue%3Auser%2F42')
    expect(route.value).toEqual({ page: 'users', params: ['koinbx-dev', 'venue:user/42'] })

    navigate('plans')
    expect(fakeLocation.hash).toBe('#/plans')
    navigate('#/audit')
    expect(fakeLocation.hash).toBe('#/audit')
  })

  it('honours a non-dashboard default page (portal overview)', async () => {
    fakeLocation.hash = ''
    const { createHashRouter } = await import('../src/router/hash.js')
    const { route } = createHashRouter('overview')
    expect(route.value).toEqual({ page: 'overview', params: [] })
  })
})
