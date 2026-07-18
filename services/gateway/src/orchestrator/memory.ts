/**
 * Client for services/memory (opt-in persona). Two rules govern every call
 * site: (1) memory being down must never break a turn — reads degrade to
 * null, writes are fire-and-forget; (2) nothing is written unless the user
 * opted in (enforced again inside the store: data never accrues opted-out).
 */

const MEMORY_URL = process.env.MEMORY_URL ?? 'http://localhost:8792'
const MEMORY_TIMEOUT_MS = 1_500

export type ExperienceLevel = 'new' | 'intermediate' | 'pro'

export type Persona = {
  optIn: boolean
  experienceLevel: ExperienceLevel | null
  followedAssets: string[]
  openThreads: Array<{ text: string; symbol?: string; ts: number }>
  updatedAt: number
}

export type PersonaUpdate = {
  optIn?: boolean
  experienceLevel?: ExperienceLevel | null
  followAsset?: string
  openThread?: { text: string; symbol?: string }
}

export interface MemoryClient {
  /** null when the memory service is unreachable — the turn proceeds. */
  get(partnerId: string, userId: string): Promise<Persona | null>
  update(partnerId: string, userId: string, patch: PersonaUpdate): Promise<void>
  clear(partnerId: string, userId: string): Promise<void>
}

async function request(url: string, init: RequestInit): Promise<Response> {
  // The memory service holds opt-in PII and requires the shared internal token
  // on every /v1/persona call (fail-closed 503 when it is unset there).
  const internalToken = process.env.INTERNAL_API_TOKEN ?? ''
  return fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(internalToken ? { 'x-hippo-internal-token': internalToken } : {}),
    },
    signal: AbortSignal.timeout(MEMORY_TIMEOUT_MS),
  })
}

export function createMemoryClient(baseUrl = MEMORY_URL): MemoryClient {
  const personaUrl = (partnerId: string, userId: string) =>
    `${baseUrl}/v1/persona/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`
  return {
    async get(partnerId, userId) {
      try {
        const res = await request(personaUrl(partnerId, userId), { method: 'GET' })
        if (!res.ok) return null
        return (await res.json()) as Persona
      } catch {
        return null
      }
    },
    async update(partnerId, userId, patch) {
      await request(personaUrl(partnerId, userId), {
        method: 'PUT',
        body: JSON.stringify(patch),
      })
    },
    async clear(partnerId, userId) {
      // Explicit empty JSON body: fastify 400s a bodyless POST that carries
      // a JSON content-type (found live — the fire-and-forget hid the 400).
      await request(`${personaUrl(partnerId, userId)}/clear`, { method: 'POST', body: '{}' })
    },
  }
}
