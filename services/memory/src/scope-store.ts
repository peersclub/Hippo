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

/** A session's stored note + the composed-memory snapshot that was sent. */
export type SessionMemory = {
  note: string
  composed: string
  partnerId: string
  userId: string
  updatedAt: number
}

export function emptySession(): SessionMemory {
  return { note: '', composed: '', partnerId: '', userId: '', updatedAt: 0 }
}

// ── auto-learned facts (Track 2: provenance-tracked auto-learning) ─────────
// Stored SEPARATELY from the freeform prose bodies above so auto-learning never
// clobbers admin-authored text and provenance stays clean. Two scopes carry
// facts: USER (partner+user) and SESSION.

/** The scopes that carry auto-learned facts. */
export type LearnedFactScope = 'user' | 'session'

/** Where a fact came from. Auto-learned by default; 'admin' is curated and is
 * never overwritten by an auto observation (and is protected from eviction). */
export type FactSource = 'auto' | 'admin'

/** A stored fact with provenance + timestamps. */
export type LearnedFact = {
  type: string
  value: string
  confidence: number
  source: FactSource
  createdAt: number
  updatedAt: number
}

/** An observation to upsert. `source` defaults to 'auto'. */
export type LearnedFactInput = {
  type: string
  value: string
  confidence: number
  source?: FactSource
}

/** Scope keys: USER needs partnerId+userId; SESSION needs sessionId. */
export type LearnedFactIds = {
  partnerId?: string
  userId?: string
  sessionId?: string
}

/** Cap on facts per scope — analogous to MAX_BODY. Eviction protects admin
 * facts, then keeps the highest-confidence auto facts. */
export const MAX_LEARNED_FACTS = 50

/** Phase D fact decay: an auto-learned fact that is not re-observed within this
 * window ages out — it stops composing into prompts and is pruned on the next
 * upsert to the same scope. Default 90 days; override with LEARNED_FACT_TTL_MS
 * (milliseconds). Admin-curated facts are exempt (they never decay, matching
 * their eviction exemption). Re-observing a fact refreshes updated_at, so an
 * active preference is kept indefinitely — only genuinely stale ones expire. */
export const LEARNED_FACT_TTL_MS: number = (() => {
  const parsed = Number(process.env.LEARNED_FACT_TTL_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90 * 24 * 60 * 60 * 1000
})()

/** A fact still composes iff it is admin-curated OR was observed within the TTL.
 * `now - LEARNED_FACT_TTL_MS` is the cutoff; a fact exactly at the edge expires. */
function isFresh(fact: LearnedFact, now: number): boolean {
  return fact.source === 'admin' || fact.updatedAt > now - LEARNED_FACT_TTL_MS
}

function factKey(type: string, value: string): string {
  return `${type}\u0000${value}`
}

/** The one place the dedup / provenance / cap rules live, shared by both
 * backings so they cannot drift (same pattern as store.ts::applyUpdate):
 *  - dedup by (type,value): re-observing updates confidence + updatedAt in place;
 *  - provenance: an admin fact is NEVER overwritten by an auto observation
 *    (an admin observation may promote/refresh; auto→auto and admin→admin update);
 *  - cap: when over MAX_LEARNED_FACTS, admin facts survive first, then the
 *    highest-confidence (tie-break newest) auto facts.
 * Returns the retained facts most-recent-first. */
export function mergeLearnedFacts(
  existing: readonly LearnedFact[],
  incoming: readonly LearnedFactInput[],
  now: number,
): LearnedFact[] {
  const byKey = new Map<string, LearnedFact>()
  for (const f of existing) byKey.set(factKey(f.type, f.value), f)

  for (const inc of incoming) {
    const source: FactSource = inc.source === 'admin' ? 'admin' : 'auto'
    const key = factKey(inc.type, inc.value)
    const prev = byKey.get(key)
    if (prev) {
      // Admin-authored facts are never overwritten by an auto observation.
      if (prev.source === 'admin' && source !== 'admin') continue
      byKey.set(key, {
        ...prev,
        value: inc.value,
        confidence: inc.confidence,
        source,
        updatedAt: now,
      })
    } else {
      byKey.set(key, {
        type: inc.type,
        value: inc.value,
        confidence: inc.confidence,
        source,
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  let facts = [...byKey.values()]
  if (facts.length > MAX_LEARNED_FACTS) {
    facts = [...facts]
      .sort(
        (a, b) =>
          Number(b.source === 'admin') - Number(a.source === 'admin') ||
          b.confidence - a.confidence ||
          b.updatedAt - a.updatedAt,
      )
      .slice(0, MAX_LEARNED_FACTS)
  }
  // Return most-recent-first for a stable, meaningful read order.
  return facts.sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.type.localeCompare(b.type),
  )
}

export interface ScopeMemoryStore {
  getGlobal(): Promise<MemoryDoc>
  setGlobal(body: string, now: number): Promise<MemoryDoc>
  getHost(partnerId: string): Promise<MemoryDoc>
  setHost(partnerId: string, body: string, now: number): Promise<MemoryDoc>
  getUserNote(partnerId: string, userId: string): Promise<MemoryDoc>
  setUserNote(partnerId: string, userId: string, body: string, now: number): Promise<MemoryDoc>
  getSession(sessionId: string): Promise<SessionMemory>
  /** Store the composed snapshot (+ ids) for the inspector. */
  putComposed(
    sessionId: string,
    partnerId: string,
    userId: string,
    composed: string,
    now: number,
  ): Promise<void>
  /** Upsert auto-learned facts for a scope: dedups by (type,value), caps per
   * scope, and never lets an auto observation overwrite an admin fact. Returns
   * the retained facts (most-recent-first). */
  upsertLearnedFacts(
    scope: LearnedFactScope,
    ids: LearnedFactIds,
    facts: LearnedFactInput[],
    now?: number,
  ): Promise<LearnedFact[]>
  /** The facts stored for a scope (most-recent-first; empty if none). Facts
   * that aged past LEARNED_FACT_TTL_MS (measured against `now`) are omitted —
   * `now` is injectable for deterministic tests, defaulting to the wall clock. */
  getLearnedFacts(
    scope: LearnedFactScope,
    ids: LearnedFactIds,
    now?: number,
  ): Promise<LearnedFact[]>
  /** Clear all learned facts for a scope (the user-visible clear / opt-out).
   * Returns the number removed. */
  clearLearnedFacts(scope: LearnedFactScope, ids: LearnedFactIds): Promise<number>
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
  private sessions = new Map<string, SessionMemory>()
  async getSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? emptySession()
  }
  async putComposed(
    sessionId: string,
    partnerId: string,
    userId: string,
    composed: string,
    now: number,
  ) {
    const prev = this.sessions.get(sessionId) ?? emptySession()
    this.sessions.set(sessionId, { ...prev, partnerId, userId, composed, updatedAt: now })
  }

  private learned = new Map<string, LearnedFact[]>()
  private learnedKey(scope: LearnedFactScope, ids: LearnedFactIds): string {
    return scope === 'session'
      ? `session:${ids.sessionId ?? ''}`
      : `user:${ids.partnerId ?? ''}:${ids.userId ?? ''}`
  }
  async upsertLearnedFacts(
    scope: LearnedFactScope,
    ids: LearnedFactIds,
    facts: LearnedFactInput[],
    now = Date.now(),
  ): Promise<LearnedFact[]> {
    const key = this.learnedKey(scope, ids)
    const merged = mergeLearnedFacts(this.learned.get(key) ?? [], facts, now)
    // Phase D: opportunistically prune facts that aged past the TTL, so a
    // scope that stops being observed doesn't accumulate stale entries.
    const kept = merged.filter((f) => isFresh(f, now))
    this.learned.set(key, kept)
    return kept
  }
  async getLearnedFacts(
    scope: LearnedFactScope,
    ids: LearnedFactIds,
    now = Date.now(),
  ): Promise<LearnedFact[]> {
    // Phase D: stale (past-TTL) auto facts stop composing. Admin facts never decay.
    return (this.learned.get(this.learnedKey(scope, ids)) ?? []).filter((f) => isFresh(f, now))
  }
  async clearLearnedFacts(scope: LearnedFactScope, ids: LearnedFactIds): Promise<number> {
    const key = this.learnedKey(scope, ids)
    const n = this.learned.get(key)?.length ?? 0
    this.learned.delete(key)
    return n
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
  async getSession(sessionId: string): Promise<SessionMemory> {
    const res = await this.pool.query(
      'SELECT note, composed, partner_id, user_id, updated_at FROM memory_session WHERE session_id = $1',
      [sessionId],
    )
    const r = res.rows[0]
    return r
      ? {
          note: r.note,
          composed: r.composed,
          partnerId: r.partner_id,
          userId: r.user_id,
          updatedAt: Number(r.updated_at),
        }
      : emptySession()
  }
  async putComposed(
    sessionId: string,
    partnerId: string,
    userId: string,
    composed: string,
    now: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_session (session_id, partner_id, user_id, composed, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id) DO UPDATE SET partner_id = $2, user_id = $3, composed = $4, updated_at = $5`,
      [sessionId, partnerId, userId, clampBody(composed), now],
    )
  }

  async upsertLearnedFacts(
    scope: LearnedFactScope,
    ids: LearnedFactIds,
    facts: LearnedFactInput[],
    now = Date.now(),
  ): Promise<LearnedFact[]> {
    const partnerId = ids.partnerId ?? ''
    const userId = scope === 'user' ? (ids.userId ?? '') : null
    const sessionId = scope === 'session' ? (ids.sessionId ?? '') : null
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const f of facts) {
        const source: FactSource = f.source === 'admin' ? 'admin' : 'auto'
        // Dedup + provenance: re-observing the same (scope-keys,type,value)
        // updates in place; the WHERE keeps an admin fact from being clobbered
        // by an auto observation (auto→auto, admin→*, and admin-promotion pass).
        await client.query(
          `INSERT INTO memory_learned_facts
             (scope, partner_id, user_id, session_id, fact_type, fact_value, confidence, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           ON CONFLICT (scope, partner_id, COALESCE(user_id, ''), COALESCE(session_id, ''), fact_type, fact_value)
           DO UPDATE SET confidence = EXCLUDED.confidence, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at
           WHERE memory_learned_facts.source <> 'admin' OR EXCLUDED.source = 'admin'`,
          [scope, partnerId, userId, sessionId, f.type, f.value, f.confidence, source, now],
        )
      }
      // Phase D fact decay: prune auto facts that aged past the TTL (admin
      // facts are exempt). Opportunistic — runs on every upsert to this scope.
      await client.query(
        `DELETE FROM memory_learned_facts
           WHERE scope = $1 AND partner_id = $2
             AND COALESCE(user_id, '') = $3 AND COALESCE(session_id, '') = $4
             AND source <> 'admin' AND updated_at <= $5`,
        [scope, partnerId, userId ?? '', sessionId ?? '', now - LEARNED_FACT_TTL_MS],
      )
      // Enforce the per-scope cap: keep admin facts first, then highest
      // confidence (tie-break newest); evict the rest.
      await client.query(
        `DELETE FROM memory_learned_facts t USING (
           SELECT id, row_number() OVER (
             ORDER BY (source = 'admin') DESC, confidence DESC, updated_at DESC
           ) AS rn
           FROM memory_learned_facts
           WHERE scope = $1 AND partner_id = $2
             AND COALESCE(user_id, '') = $3 AND COALESCE(session_id, '') = $4
         ) ranked
         WHERE t.id = ranked.id AND ranked.rn > $5`,
        [scope, partnerId, userId ?? '', sessionId ?? '', MAX_LEARNED_FACTS],
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return this.getLearnedFacts(scope, ids)
  }

  async getLearnedFacts(
    scope: LearnedFactScope,
    ids: LearnedFactIds,
    now = Date.now(),
  ): Promise<LearnedFact[]> {
    const cols =
      'fact_type, fact_value, confidence, source, created_at, updated_at FROM memory_learned_facts'
    // Phase D: stale (past-TTL) auto facts stop composing; admin facts never
    // decay. `cutoff = now - TTL`; only facts observed after it are returned.
    const cutoff = now - LEARNED_FACT_TTL_MS
    const res =
      scope === 'session'
        ? await this.pool.query(
            `SELECT ${cols} WHERE scope = 'session' AND session_id = $1
               AND (source = 'admin' OR updated_at > $2) ORDER BY updated_at DESC`,
            [ids.sessionId ?? '', cutoff],
          )
        : await this.pool.query(
            `SELECT ${cols} WHERE scope = 'user' AND partner_id = $1 AND user_id = $2
               AND (source = 'admin' OR updated_at > $3) ORDER BY updated_at DESC`,
            [ids.partnerId ?? '', ids.userId ?? '', cutoff],
          )
    return res.rows.map((r) => ({
      type: r.fact_type as string,
      value: r.fact_value as string,
      confidence: Number(r.confidence),
      source: r.source as FactSource,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }))
  }

  async clearLearnedFacts(scope: LearnedFactScope, ids: LearnedFactIds): Promise<number> {
    const res =
      scope === 'session'
        ? await this.pool.query(
            "DELETE FROM memory_learned_facts WHERE scope = 'session' AND session_id = $1",
            [ids.sessionId ?? ''],
          )
        : await this.pool.query(
            "DELETE FROM memory_learned_facts WHERE scope = 'user' AND partner_id = $1 AND user_id = $2",
            [ids.partnerId ?? '', ids.userId ?? ''],
          )
    return res.rowCount ?? 0
  }
}
