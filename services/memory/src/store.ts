/**
 * Persona store — Memory v1 (Build Plan 03: "persona, not surveillance").
 *
 * What it holds, and deliberately nothing more: memory opt-in, experience
 * level, assets followed, open conversation threads. It personalizes
 * explanation depth and continuity only — no trade history, no balances,
 * no behavioral profile. Keyed per partner AND per user: partner A's Hippo
 * never sees what the same person asked on partner B (data-boundary L1).
 *
 * Two backings behind one async surface: in-memory Map for dev/tests, and
 * the Postgres `users_memory` table (BE doc §4, regional pod, in-region PII)
 * when DATABASE_URL is set — only the constructor changes. The accrual rules
 * live in pure functions (applyUpdate/clearedPersona) shared by both impls so
 * they cannot drift.
 */
import type pg from 'pg'

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

export type PersonaRow = { partnerId: string; userId: string; persona: Persona }

export type PersonaListOpts = {
  partnerId?: string
  optIn?: boolean
  offset?: number
  limit?: number
}

export type PersonaPage = { rows: PersonaRow[]; total: number }

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

/** The one place accrual rules live: data accrues ONLY while opted in — an
 * update that also flips optIn on counts (consent and first memory can share
 * an uplink). */
export function applyUpdate(current: Persona, patch: PersonaUpdate, now = Date.now()): Persona {
  const next: Persona = { ...current, updatedAt: now }

  if (patch.optIn !== undefined) next.optIn = patch.optIn
  if (patch.experienceLevel !== undefined) next.experienceLevel = patch.experienceLevel

  if (next.optIn) {
    if (patch.followAsset) {
      const asset = patch.followAsset.toUpperCase()
      next.followedAssets = [asset, ...current.followedAssets.filter((a) => a !== asset)].slice(
        0,
        MAX_ASSETS,
      )
    }
    if (patch.openThread) {
      next.openThreads = [{ ...patch.openThread, ts: now }, ...current.openThreads].slice(
        0,
        MAX_THREADS,
      )
    }
  }

  return next
}

/** The settings promise: wipes persona DATA. The opt-in flag itself survives
 * — clearing is not opting out. */
export function clearedPersona(current: Persona, now = Date.now()): Persona {
  return { ...defaultPersona(), optIn: current.optIn, updatedAt: now }
}

export interface PersonaStore {
  get(partnerId: string, userId: string): Promise<Persona>
  update(partnerId: string, userId: string, patch: PersonaUpdate): Promise<Persona>
  clear(partnerId: string, userId: string): Promise<Persona>
  /** Admin enumeration — the surface the panel's "user-wise memory" view needs. */
  list(opts?: PersonaListOpts): Promise<PersonaPage>
  /** Hard delete (admin purge) — unlike clear, nothing survives, not even opt-in. */
  delete(partnerId: string, userId: string): Promise<boolean>
  size(): Promise<number>
}

export class InMemoryPersonaStore implements PersonaStore {
  private readonly personas = new Map<string, Persona>()

  private key(partnerId: string, userId: string): string {
    return `${partnerId}:${userId}`
  }

  async get(partnerId: string, userId: string): Promise<Persona> {
    return this.personas.get(this.key(partnerId, userId)) ?? defaultPersona()
  }

  async update(partnerId: string, userId: string, patch: PersonaUpdate): Promise<Persona> {
    const next = applyUpdate(await this.get(partnerId, userId), patch)
    this.personas.set(this.key(partnerId, userId), next)
    return next
  }

  async clear(partnerId: string, userId: string): Promise<Persona> {
    const wiped = clearedPersona(await this.get(partnerId, userId))
    this.personas.set(this.key(partnerId, userId), wiped)
    return wiped
  }

  async list({
    partnerId,
    optIn,
    offset = 0,
    limit = 50,
  }: PersonaListOpts = {}): Promise<PersonaPage> {
    const rows: PersonaRow[] = []
    for (const [key, persona] of this.personas) {
      const sep = key.indexOf(':')
      const pid = key.slice(0, sep)
      const uid = key.slice(sep + 1)
      if (partnerId && pid !== partnerId) continue
      if (optIn !== undefined && persona.optIn !== optIn) continue
      rows.push({ partnerId: pid, userId: uid, persona })
    }
    rows.sort((a, b) => b.persona.updatedAt - a.persona.updatedAt)
    return { rows: rows.slice(offset, offset + limit), total: rows.length }
  }

  async delete(partnerId: string, userId: string): Promise<boolean> {
    return this.personas.delete(this.key(partnerId, userId))
  }

  async size(): Promise<number> {
    return this.personas.size
  }
}

/** Postgres backing over the `users_memory` table (@hippo/stores migration 004). */
export class PostgresPersonaStore implements PersonaStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(partnerId: string, userId: string): Promise<Persona> {
    const res = await this.pool.query(
      'SELECT persona FROM users_memory WHERE partner_id = $1 AND user_id = $2',
      [partnerId, userId],
    )
    return res.rows[0] ? (res.rows[0].persona as Persona) : defaultPersona()
  }

  private async put(partnerId: string, userId: string, persona: Persona): Promise<void> {
    await this.pool.query(
      `INSERT INTO users_memory (partner_id, user_id, persona, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (partner_id, user_id) DO UPDATE SET persona = $3, updated_at = $4`,
      [partnerId, userId, JSON.stringify(persona), persona.updatedAt],
    )
  }

  async update(partnerId: string, userId: string, patch: PersonaUpdate): Promise<Persona> {
    const next = applyUpdate(await this.get(partnerId, userId), patch)
    await this.put(partnerId, userId, next)
    return next
  }

  async clear(partnerId: string, userId: string): Promise<Persona> {
    const wiped = clearedPersona(await this.get(partnerId, userId))
    await this.put(partnerId, userId, wiped)
    return wiped
  }

  async list({
    partnerId,
    optIn,
    offset = 0,
    limit = 50,
  }: PersonaListOpts = {}): Promise<PersonaPage> {
    const conds: string[] = []
    const params: unknown[] = []
    if (partnerId) {
      params.push(partnerId)
      conds.push(`partner_id = $${params.length}`)
    }
    if (optIn !== undefined) {
      params.push(optIn)
      conds.push(`(persona->>'optIn')::boolean = $${params.length}`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = await this.pool.query(`SELECT count(*) FROM users_memory ${where}`, params)
    params.push(limit, offset)
    const rows = await this.pool.query(
      `SELECT partner_id, user_id, persona FROM users_memory ${where}
       ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return {
      rows: rows.rows.map((r) => ({
        partnerId: r.partner_id as string,
        userId: r.user_id as string,
        persona: r.persona as Persona,
      })),
      total: Number(total.rows[0].count),
    }
  }

  async delete(partnerId: string, userId: string): Promise<boolean> {
    const res = await this.pool.query(
      'DELETE FROM users_memory WHERE partner_id = $1 AND user_id = $2',
      [partnerId, userId],
    )
    return (res.rowCount ?? 0) > 0
  }

  async size(): Promise<number> {
    const res = await this.pool.query('SELECT count(*) FROM users_memory')
    return Number(res.rows[0].count)
  }
}
