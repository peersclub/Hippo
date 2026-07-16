/**
 * Fetch wrapper for the admin API. Cookie auth rides same-origin through the
 * /api dev proxy; a 401 anywhere kicks back to the login screen.
 */
import { signal } from '@preact/signals'

export type Operator = { email: string; role: 'owner' | 'operator' }

export const currentOperator = signal<Operator | null>(null)

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  if (res.status === 401 && path !== '/auth/login') {
    currentOperator.value = null
    location.hash = '#/login'
    throw new ApiError(401, 'signed out')
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(res.status, body.error ?? `request failed (${res.status})`)
  return body as T
}

export const get = <T>(path: string) => api<T>(path)
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
export const put = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) })
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' })
