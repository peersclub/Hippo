import { signal } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createApi } from '../src/api/client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createApi', () => {
  it('GET JSON, POST with a body, and bodyless POST (no content-type)', async () => {
    const identity = signal<{ email: string } | null>({ email: 'op@hippo' })
    const calls: RequestInit[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      calls.push(init)
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true }),
      }
    })

    const api = createApi({ identity })
    await api.get('/v1/partners')
    await api.post('/v1/partners', { name: 'x' })
    await api.post('/auth/logout')

    const headersOf = (i: number) => calls[i]?.headers as Record<string, string> | undefined
    expect(headersOf(0)).toEqual({})
    expect(headersOf(1)?.['content-type']).toBe('application/json')
    expect(calls[1]?.body).toBe(JSON.stringify({ name: 'x' }))
    expect(headersOf(2)).toEqual({})
    expect(calls[2]?.body).toBeUndefined()
  })

  it('401 off the login path clears identity and throws', async () => {
    const identity = signal<{ email: string } | null>({ email: 'op@hippo' })
    const fakeLocation = { hash: '#/partners' }
    vi.stubGlobal('location', fakeLocation)
    vi.stubGlobal('fetch', async () => ({
      status: 401,
      ok: false,
      json: async () => ({ error: 'signed out' }),
    }))

    const api = createApi({ identity })
    await expect(api.get('/v1/partners')).rejects.toBeInstanceOf(ApiError)
    expect(identity.value).toBeNull()
    expect(fakeLocation.hash).toBe('#/login')
  })
})
