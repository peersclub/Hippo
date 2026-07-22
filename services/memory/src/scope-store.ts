/**
 * Scope-memory store — the freeform memory "documents" that layer into the
 * prompt (super-admin → host → user → session). DISTINCT from the structured
 * persona: this is editable prose a super-admin curates per level.
 *
 * Phase B covers three scopes — global (one platform-wide doc), host (one per
 * partner), and a per-(partner,user) freeform note. Session-scope is added
 * with the composition/inspector work. Same two-backings-one-surface pattern
 * as PersonaStore: in-memory Map for dev/tests, Postgres tables (migration
 * 009) when DATABASE_URL is set.
 */
import type pg from 'pg'

/** A memory document: the editable body + when it last changed. */
export type MemoryDoc = { body: string; updatedAt: number }

export const GLOBAL_ID = 'global'
/** Bodies are curated by a super-admin, not user input — but bound the size
 * so a paste can't blow the prompt budget. */
export const MAX_BODY = 8_000

export function emptyDoc(): MemoryDoc {
  return { body: '', updatedAt: 0 }
}

function clampBody(body: string): string {
  return body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body
}

export interface ScopeMemoryStore {
  getGlobal(): Promise<MemoryDoc>
  setGlobal(body: string, now: number): Promise<MemoryDoc>
  getHost(partnerId: string): Promise<MemoryDoc>
  setHost(partnerId: string, body: string, now: number): Promise<MemoryDoc>
  getUserNote(partnerId: string, userId: string): Promise<MemoryDoc>
  setUserNote(partnerId: string, userId: string, body: string, now: number): Promise<MemoryDoc>
}

export class InMemoryScopeMemoryStore implements ScopeMemoryStore {
  private global: MemoryDoc = emptyDoc()
  private host = new Map<string, MemoryDoc>()
  private userNotes = new Map<string, MemoryDoc>()
  private key(partnerId: string, userId: string) {
    return `${partnerId}:${userId}`
  }

  async getGlobal() {
    return this.global
  }
  async setGlobal(body: string, now: number) {
    this.global = { body: clampBody(body), updatedAt: now }
    return this.global
  }
  async getHost(partnerId: string) {
    return this.host.get(partnerId) ?? emptyDoc()
  }
  async setHost(partnerId: string, body: string, now: number) {
    const doc = { body: clampBody(body), updatedAt: now }
    this.host.set(partnerId, doc)
    return doc
  }
  async getUserNote(partnerId: string, userId: string) {
    return this.userNotes.get(this.key(partnerId, userId)) ?? emptyDoc()
  }
  async setUserNote(partnerId: string, userId: string, body: string, now: number) {
    const doc = { body: clampBody(body), updatedAt: now }
    this.userNotes.set(this.key(partnerId, userId), doc)
    return doc
  }
}

export class PostgresScopeMemoryStore implements ScopeMemoryStore {
  constructor(private readonly pool: pg.Pool) {}

  async getGlobal(): Promise<MemoryDoc> {
    const res = await this.pool.query('SELECT body, updated_at FROM memory_global WHERE id = $1', [
      GLOBAL_ID,
    ])
    return res.rows[0]
      ? { body: res.rows[0].body, updatedAt: Number(res.rows[0].updated_at) }
      : emptyDoc()
  }
  async setGlobal(body: string, now: number): Promise<MemoryDoc> {
    const clamped = clampBody(body)
    await this.pool.query(
      `INSERT INTO memory_global (id, body, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET body = $2, updated_at = $3`,
      [GLOBAL_ID, clamped, now],
    )
    return { body: clamped, updatedAt: now }
  }
  async getHost(partnerId: string): Promise<MemoryDoc> {
    const res = await this.pool.query(
      'SELECT body, updated_at FROM memory_host WHERE partner_id = $1',
      [partnerId],
    )
    return res.rows[0]
      ? { body: res.rows[0].body, updatedAt: Number(res.rows[0].updated_at) }
      : emptyDoc()
  }
  async setHost(partnerId: string, body: string, now: number): Promise<MemoryDoc> {
    const clamped = clampBody(body)
    await this.pool.query(
      `INSERT INTO memory_host (partner_id, body, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (partner_id) DO UPDATE SET body = $2, updated_at = $3`,
      [partnerId, clamped, now],
    )
    return { body: clamped, updatedAt: now }
  }
  async getUserNote(partnerId: string, userId: string): Promise<MemoryDoc> {
    const res = await this.pool.query(
      'SELECT body, updated_at FROM memory_user_notes WHERE partner_id = $1 AND user_id = $2',
      [partnerId, userId],
    )
    return res.rows[0]
      ? { body: res.rows[0].body, updatedAt: Number(res.rows[0].updated_at) }
      : emptyDoc()
  }
  async setUserNote(
    partnerId: string,
    userId: string,
    body: string,
    now: number,
  ): Promise<MemoryDoc> {
    const clamped = clampBody(body)
    await this.pool.query(
      `INSERT INTO memory_user_notes (partner_id, user_id, body, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (partner_id, user_id) DO UPDATE SET body = $3, updated_at = $4`,
      [partnerId, userId, clamped, now],
    )
    return { body: clamped, updatedAt: now }
  }
}
