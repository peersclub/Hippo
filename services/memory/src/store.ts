/**
 * Persona store — Memory v1 (Build Plan 03: "persona, not surveillance").
 *
 * What it holds, and deliberately nothing more: memory opt-in, experience
 * level, assets followed, open conversation threads. It personalizes
 * explanation depth and continuity only — no trade history, no balances,
 * no behavioral profile. Keyed per partner AND per user: partner A's Hippo
 * never sees what the same person asked on partner B (data-boundary L1).
 *
 * In-memory Map for dev; production is the Postgres `users_memory` table
 * (BE doc §4, regional pod, in-region PII) behind this same PersonaStore
 * surface — only the constructor changes.
 */

export type ExperienceLevel = 'new' | 'intermediate' | 'pro'

export type OpenThread = {
  text: string
  symbol?: string
  ts: number
}

export type Persona = {
  optIn: boolean
  experienceLevel: ExperienceLevel | null
  /** Most-recent-first, deduped, capped. */
  followedAssets: string[]
  /** Most-recent-first, capped — enough for "pick up where we left off". */
  openThreads: OpenThread[]
  updatedAt: number
}

export type PersonaUpdate = {
  optIn?: boolean
  experienceLevel?: ExperienceLevel | null
  followAsset?: string
  openThread?: { text: string; symbol?: string }
}

const MAX_ASSETS = 8
const MAX_THREADS = 3

export function defaultPersona(): Persona {
  return {
    optIn: false,
    experienceLevel: null,
    followedAssets: [],
    openThreads: [],
    updatedAt: 0,
  }
}

export interface PersonaStore {
  get(partnerId: string, userId: string): Persona
  update(partnerId: string, userId: string, patch: PersonaUpdate): Persona
  /** The product promise behind the settings toggle: wipes persona DATA.
   * The opt-in flag itself survives — clearing is not opting out. */
  clear(partnerId: string, userId: string): Persona
  size(): number
}

export class InMemoryPersonaStore implements PersonaStore {
  private readonly personas = new Map<string, Persona>()

  private key(partnerId: string, userId: string): string {
    return `${partnerId}:${userId}`
  }

  get(partnerId: string, userId: string): Persona {
    return this.personas.get(this.key(partnerId, userId)) ?? defaultPersona()
  }

  update(partnerId: string, userId: string, patch: PersonaUpdate): Persona {
    const current = this.get(partnerId, userId)
    const next: Persona = { ...current, updatedAt: Date.now() }

    if (patch.optIn !== undefined) next.optIn = patch.optIn
    if (patch.experienceLevel !== undefined) next.experienceLevel = patch.experienceLevel

    // Persona data accrues ONLY while opted in — an update that also flips
    // optIn on counts (consent and first memory can share an uplink).
    if (next.optIn) {
      if (patch.followAsset) {
        const asset = patch.followAsset.toUpperCase()
        next.followedAssets = [asset, ...current.followedAssets.filter((a) => a !== asset)].slice(
          0,
          MAX_ASSETS,
        )
      }
      if (patch.openThread) {
        next.openThreads = [{ ...patch.openThread, ts: Date.now() }, ...current.openThreads].slice(
          0,
          MAX_THREADS,
        )
      }
    }

    this.personas.set(this.key(partnerId, userId), next)
    return next
  }

  clear(partnerId: string, userId: string): Persona {
    const current = this.get(partnerId, userId)
    const wiped: Persona = { ...defaultPersona(), optIn: current.optIn, updatedAt: Date.now() }
    this.personas.set(this.key(partnerId, userId), wiped)
    return wiped
  }

  size(): number {
    return this.personas.size
  }
}
