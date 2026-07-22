/**
 * Client for services/memory (opt-in persona). Two rules govern every call
 * site: (1) memory being down must never break a turn — reads degrade to
 * null, writes are fire-and-forget; (2) nothing is written unless the user
 * opted in (enforced again inside the store: data never accrues opted-out).
 */

const MEMORY_URL = process.env.MEMORY_URL ?? 'http://localhost:8792'
const MEMORY_TIMEOUT_MS = 1_500
/** After a network failure, skip memory entirely for this long — a down
 * memory service must not add its timeout to every research turn. The first
 * call after the window probes again. */
const BREAKER_MS = 15_000

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

/** A freeform scope-memory document (global/host/user note). */
export type MemoryDoc = { body: string; updatedAt: number }

export interface MemoryClient {
  /** null when the memory service is unreachable — the turn proceeds. */
  get(partnerId: string, userId: string): Promise<Persona | null>
  update(partnerId: string, userId: string, patch: PersonaUpdate): Promise<void>
  clear(partnerId: string, userId: string): Promise<void>
  /** Freeform scope documents for prompt composition. All degrade to '' when
   * memory is down — a turn never waits on or breaks over them. */
  scopeDocs(
    partnerId: string,
    userId: string,
  ): Promise<{ global: string; host: string; user: string }>
  /** Persist the composed memory snapshot for a session (inspector record).
   * Fire-and-forget; failure never affects the turn. */
  saveComposed(
    sessionId: string,
    partnerId: string,
    userId: string,
    composed: string,
  ): Promise<void>
  /** Read a session's composed snapshot (admin inspector). */
  getComposed(sessionId: string): Promise<{ composed: string; updatedAt: number } | null>
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
  // Network-level failures (timeout, refused) open the breaker; a non-2xx is
  // the service answering and doesn't. Reads degrade to null either way.
  let downUntil = 0
  async function guarded(url: string, init: RequestInit): Promise<Response | null> {
    if (Date.now() < downUntil) return null
    try {
      const res = await request(url, init)
      downUntil = 0
      return res
    } catch (err) {
      downUntil = Date.now() + BREAKER_MS
      throw err
    }
  }
  return {
    async get(partnerId, userId) {
      try {
        const res = await guarded(personaUrl(partnerId, userId), { method: 'GET' })
        if (!res?.ok) return null
        return (await res.json()) as Persona
      } catch {
        return null
      }
    },
    async update(partnerId, userId, patch) {
      await guarded(personaUrl(partnerId, userId), {
        method: 'PUT',
        body: JSON.stringify(patch),
      })
    },
    async clear(partnerId, userId) {
      // Explicit empty JSON body: fastify 400s a bodyless POST that carries
      // a JSON content-type (found live — the fire-and-forget hid the 400).
      await guarded(`${personaUrl(partnerId, userId)}/clear`, { method: 'POST', body: '{}' })
    },
    async scopeDocs(partnerId, userId) {
      // Three independent reads; any that fails degrades to '' — memory being
      // down must never break or stall a turn. Run in parallel.
      const read = async (path: string): Promise<string> => {
        try {
          const res = await guarded(`${baseUrl}${path}`, { method: 'GET' })
          if (!res?.ok) return ''
          return ((await res.json()) as { body?: string }).body ?? ''
        } catch {
          return ''
        }
      }
      const [global, host, user] = await Promise.all([
        read('/v1/scope/global'),
        read(`/v1/scope/host/${encodeURIComponent(partnerId)}`),
        read(`/v1/scope/user/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`),
      ])
      return { global, host, user }
    },
    async saveComposed(sessionId, partnerId, userId, composed) {
      await guarded(`${baseUrl}/v1/scope/session/${encodeURIComponent(sessionId)}/composed`, {
        method: 'PUT',
        body: JSON.stringify({ composed, partnerId, userId }),
      })
    },
    async getComposed(sessionId) {
      try {
        const res = await guarded(`${baseUrl}/v1/scope/session/${encodeURIComponent(sessionId)}`, {
          method: 'GET',
        })
        if (!res?.ok) return null
        const j = (await res.json()) as { composed?: string; updatedAt?: number }
        return { composed: j.composed ?? '', updatedAt: j.updatedAt ?? 0 }
      } catch {
        return null
      }
    },
  }
}
