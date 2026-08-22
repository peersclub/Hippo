/**
 * Cookie-auth fetch wrapper for same-origin SPA APIs (admin / portal).
 * A 401 anywhere other than the login path clears identity and kicks back
 * to the login hash.
 */
import type { Signal } from '@preact/signals'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type ApiClient = {
  api: <T>(path: string, init?: RequestInit) => Promise<T>
  get: <T>(path: string) => Promise<T>
  post: <T>(path: string, body?: unknown) => Promise<T>
  put: <T>(path: string, body: unknown) => Promise<T>
  patch: <T>(path: string, body: unknown) => Promise<T>
  del: <T>(path: string) => Promise<T>
}

export function createApi<Identity>(opts: {
  identity: Signal<Identity | null>
  loginPath?: string
  loginHash?: string
}): ApiClient {
  const loginPath = opts.loginPath ?? '/auth/login'
  const loginHash = opts.loginHash ?? '#/login'

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`/api${path}`, {
      ...init,
      headers: {
        // Only claim JSON when a body actually rides along — Fastify 400s an
        // empty body with a JSON content-type (suspend/block/clear are bodyless).
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      credentials: 'same-origin',
    })
    if (res.status === 401 && path !== loginPath) {
      opts.identity.value = null
      location.hash = loginHash
      throw new ApiError(401, 'signed out')
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new ApiError(res.status, body.error ?? `request failed (${res.status})`)
    return body as T
  }

  return {
    api,
    get: <T>(path: string) => api<T>(path),
    post: <T>(path: string, body?: unknown) =>
      api<T>(path, {
        method: 'POST',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    put: <T>(path: string, body: unknown) =>
      api<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
    patch: <T>(path: string, body: unknown) =>
      api<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
    del: <T>(path: string) => api<T>(path, { method: 'DELETE' }),
  }
}
