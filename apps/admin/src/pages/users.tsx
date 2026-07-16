import type { PartnerRecord, UserRecord } from '@hippo/stores'
import { useEffect, useState } from 'preact/hooks'
import { ApiError, del, get, post, put } from '../api.js'
import { navigate } from '../router.js'

type Persona = {
  optIn: boolean
  experienceLevel: 'new' | 'intermediate' | 'pro' | null
  followedAssets: string[]
  openThreads: { text: string; symbol?: string; ts: number }[]
  updatedAt: number
}

type PersonaRow = { partnerId: string; userId: string; persona: Persona }

const fmt = (ts: number) => (ts ? new Date(ts).toLocaleString() : '—')

/**
 * One page, two modes sharing the partner filter + pager:
 *  - "users":  the gateway-registered user rows (authenticated venueUserIds)
 *  - "memory": every persona the memory service holds (incl. anonymous keys)
 */
export function UsersPage({ mode }: { mode: 'users' | 'memory' }) {
  const [partners, setPartners] = useState<Omit<PartnerRecord, 'jwtSecret'>[]>([])
  const [partnerId, setPartnerId] = useState('')
  const [offset, setOffset] = useState(0)
  const [users, setUsers] = useState<{ rows: UserRecord[]; total: number }>({ rows: [], total: 0 })
  const [personas, setPersonas] = useState<{ rows: PersonaRow[]; total: number }>({
    rows: [],
    total: 0,
  })
  const limit = 50

  useEffect(() => {
    void get<Omit<PartnerRecord, 'jwtSecret'>[]>('/v1/partners')
      .then(setPartners)
      .catch(() => {})
  }, [])

  useEffect(() => {
    const qs = new URLSearchParams({
      ...(partnerId ? { partnerId } : {}),
      offset: String(offset),
      limit: String(limit),
    }).toString()
    if (mode === 'users')
      void get<typeof users>(`/v1/users?${qs}`)
        .then(setUsers)
        .catch(() => {})
    else
      void get<typeof personas>(`/v1/memory?${qs}`)
        .then(setPersonas)
        .catch(() => {})
  }, [mode, partnerId, offset])

  const total = mode === 'users' ? users.total : personas.total

  return (
    <>
      <div class="page-head">
        <h1>{mode === 'users' ? 'Users' : 'Memory'}</h1>
        <span class="dim">
          {total} {mode === 'users' ? 'registered users' : 'personas held'}
        </span>
      </div>

      <div class="toolbar">
        <select
          value={partnerId}
          onChange={(e) => {
            setOffset(0)
            setPartnerId((e.target as HTMLSelectElement).value)
          }}
        >
          <option value="">All partners</option>
          {partners.map((p) => (
            <option key={p.partnerId} value={p.partnerId}>
              {p.venueName}
            </option>
          ))}
        </select>
      </div>

      {mode === 'users' ? (
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Partner</th>
              <th>First seen</th>
              <th>Last seen</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {users.rows.length === 0 && (
              <tr>
                <td colSpan={5} class="empty">
                  No registered users yet — rows appear when partners mint JWT-bound sessions.
                </td>
              </tr>
            )}
            {users.rows.map((u) => (
              <tr
                key={`${u.partnerId}:${u.userId}`}
                class="rowlink"
                onClick={() =>
                  navigate(
                    `users/${encodeURIComponent(u.partnerId)}/${encodeURIComponent(u.userId)}`,
                  )
                }
              >
                <td class="mono">{u.userId}</td>
                <td class="mono dim">{u.partnerId}</td>
                <td class="dim">{fmt(u.firstSeen)}</td>
                <td class="dim">{fmt(u.lastSeen)}</td>
                <td>
                  <span class={`badge ${u.status}`}>{u.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Partner</th>
              <th>Opt-in</th>
              <th>Level</th>
              <th>Assets</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {personas.rows.length === 0 && (
              <tr>
                <td colSpan={6} class="empty">
                  No personas held.
                </td>
              </tr>
            )}
            {personas.rows.map((r) => (
              <tr
                key={`${r.partnerId}:${r.userId}`}
                class="rowlink"
                onClick={() =>
                  navigate(
                    `users/${encodeURIComponent(r.partnerId)}/${encodeURIComponent(r.userId)}`,
                  )
                }
              >
                <td class="mono">{r.userId}</td>
                <td class="mono dim">{r.partnerId}</td>
                <td>
                  <span class={`badge ${r.persona.optIn ? 'active' : 'none'}`}>
                    {r.persona.optIn ? 'opted in' : 'opted out'}
                  </span>
                </td>
                <td>{r.persona.experienceLevel ?? <span class="dim">unset</span>}</td>
                <td>
                  <div class="chips">
                    {r.persona.followedAssets.map((a) => (
                      <span class="chip" key={a}>
                        {a}
                      </span>
                    ))}
                  </div>
                </td>
                <td class="dim">{fmt(r.persona.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div class="pager">
        <button
          class="btn ghost sm"
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - limit))}
        >
          ← Prev
        </button>
        <span>
          {offset + 1}–{Math.min(offset + limit, total)} of {total}
        </span>
        <button
          class="btn ghost sm"
          type="button"
          disabled={offset + limit >= total}
          onClick={() => setOffset(offset + limit)}
        >
          Next →
        </button>
      </div>
    </>
  )
}

export function UserDetailPage({ partnerId, userId }: { partnerId: string; userId: string }) {
  const [user, setUser] = useState<(UserRecord & { persona: Persona | null }) | null>(null)
  const [persona, setPersona] = useState<Persona | null>(null)
  const [notFoundUser, setNotFoundUser] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    // The user row exists only for authenticated users; memory may exist for
    // anonymous session keys too — fetch both, render what's there.
    try {
      const u = await get<UserRecord & { persona: Persona | null }>(
        `/v1/users/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`,
      )
      setUser(u)
      setPersona(u.persona)
      setNotFoundUser(false)
      return
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err
      setNotFoundUser(true)
    }
    const page = await get<{ rows: PersonaRow[] }>(
      `/v1/memory?partnerId=${encodeURIComponent(partnerId)}`,
    )
    const row = page.rows.find((r) => r.userId === userId)
    setPersona(row?.persona ?? null)
  }

  useEffect(() => {
    void load().catch((e) => setError(String(e.message ?? e)))
  }, [partnerId, userId])

  async function setLevel(level: string) {
    await put(`/v1/memory/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`, {
      experienceLevel: level === '' ? null : level,
    })
    await load()
  }

  async function clearMemory() {
    if (!confirm('Clear this user’s memory? Data is wiped; their opt-in choice survives.')) return
    await post(`/v1/memory/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}/clear`)
    await load()
  }

  async function purgeMemory() {
    if (!confirm('PURGE this user’s memory record entirely? This is a hard delete.')) return
    await del(`/v1/memory/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`)
    await load()
  }

  async function setBlocked(action: 'block' | 'unblock') {
    if (action === 'block' && !confirm(`Block ${userId}? Their sessions will be rejected.`)) return
    await post(`/v1/users/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}/${action}`)
    await load()
  }

  if (error) return <div class="error">{error}</div>

  return (
    <>
      <div class="page-head">
        <h1>
          <span class="mono">{userId}</span> <span class="dim">@ {partnerId}</span>
        </h1>
        <button class="btn ghost sm" type="button" onClick={() => history.back()}>
          ← Back
        </button>
      </div>

      <h2>Profile</h2>
      {user ? (
        <div class="kv">
          <span class="k">Status</span>
          <span>
            <span class={`badge ${user.status}`}>{user.status}</span>{' '}
            {user.status === 'active' ? (
              <button class="btn danger sm" type="button" onClick={() => setBlocked('block')}>
                Block
              </button>
            ) : (
              <button class="btn ghost sm" type="button" onClick={() => setBlocked('unblock')}>
                Unblock
              </button>
            )}
          </span>
          <span class="k">First seen</span>
          <span>{fmt(user.firstSeen)}</span>
          <span class="k">Last seen</span>
          <span>{fmt(user.lastSeen)}</span>
        </div>
      ) : notFoundUser ? (
        <div class="dim">
          No registered user row — this key was seen only through memory (likely an anonymous
          session id).
        </div>
      ) : (
        <div class="dim">Loading…</div>
      )}

      <h2>Memory</h2>
      {persona ? (
        <>
          <div class="kv">
            <span class="k">Opt-in</span>
            <span>
              <span class={`badge ${persona.optIn ? 'active' : 'none'}`}>
                {persona.optIn ? 'opted in' : 'opted out'}
              </span>
            </span>
            <span class="k">Experience level</span>
            <span>
              <select
                value={persona.experienceLevel ?? ''}
                onChange={(e) => setLevel((e.target as HTMLSelectElement).value)}
              >
                <option value="">unset</option>
                <option value="new">new</option>
                <option value="intermediate">intermediate</option>
                <option value="pro">pro</option>
              </select>
            </span>
            <span class="k">Followed assets</span>
            <span>
              <div class="chips">
                {persona.followedAssets.length === 0 && <span class="dim">none</span>}
                {persona.followedAssets.map((a) => (
                  <span class="chip" key={a}>
                    {a}
                  </span>
                ))}
              </div>
            </span>
            <span class="k">Open threads</span>
            <span>
              {persona.openThreads.length === 0 && <span class="dim">none</span>}
              {persona.openThreads.map((t) => (
                <div key={t.ts} class="dim">
                  “{t.text}” {t.symbol && <span class="mono">({t.symbol})</span>}
                </div>
              ))}
            </span>
            <span class="k">Updated</span>
            <span class="dim">{fmt(persona.updatedAt)}</span>
          </div>
          <div class="actions" style="margin-top:14px; display:flex; gap:8px">
            <button class="btn ghost sm" type="button" onClick={clearMemory}>
              Clear memory
            </button>
            <button class="btn danger sm" type="button" onClick={purgeMemory}>
              Purge record
            </button>
          </div>
        </>
      ) : (
        <div class="dim">No memory held for this user.</div>
      )}
    </>
  )
}
