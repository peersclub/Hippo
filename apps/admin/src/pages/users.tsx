import type { PartnerRecord, UserRecord } from '@hippo/stores'
import { useEffect, useRef, useState } from 'preact/hooks'
import { ApiError, del, get, post, put } from '../api.js'
import { type PurgeResponse, purgeRows } from '../purge-report.js'
import { navigate } from '../router.js'
import { Busy, confirmAction, Empty, ErrorBanner, toast, useLoad } from '../ui.js'
import {
  identityMatchesUserKey,
  type PersonaStatus,
  personaStatusFromError,
} from '../user-detail-format.js'

type Persona = {
  optIn: boolean
  experienceLevel: 'new' | 'intermediate' | 'pro' | null
  followedAssets: string[]
  openThreads: { text: string; symbol?: string; ts: number }[]
  updatedAt: number
}

type PersonaRow = { partnerId: string; userId: string; persona: Persona }

/** Gateway proactive alert (admin passthrough of @hippo/stores Alert). */
type UserAlert = {
  id: string
  partnerId: string
  userKey: string
  symbol: string
  condition: 'above' | 'below'
  price: number
  state: 'armed' | 'triggered' | 'cancelled'
  createdAt: number
  triggeredAt?: number
  delivered: boolean
}

/** In-panel identity (pinHash stripped upstream — never reaches this SPA). */
type UserIdentity = {
  partnerId: string
  usernameLower: string
  username: string
  createdAt: number
  lastSeenAt: number
}

/** Auto-learned fact (mirrors the memory service's scope-store shape). */
export type LearnedFact = {
  type: string
  value: string
  confidence: number
  source: 'auto' | 'admin'
  createdAt: number
  updatedAt: number
}

/** Human labels for the allowlisted fact types; unknown types pass through. */
const FACT_LABEL: Record<string, string> = {
  followed_asset: 'Followed asset',
  instrument_pref: 'Instrument preference',
  leverage_pref: 'Leverage preference',
  experience_level: 'Experience level',
  answer_style: 'Answer style',
}
export const factLabel = (type: string) => FACT_LABEL[type] ?? type

const fmt = (ts: number) => (ts ? new Date(ts).toLocaleString() : '—')

/**
 * One page, two modes sharing the partner filter + search + pager:
 *  - "users":  the gateway-registered user rows (authenticated venueUserIds)
 *  - "memory": every persona the memory service holds (incl. anonymous keys)
 */
export function UsersPage({ mode }: { mode: 'users' | 'memory' }) {
  const [partners, setPartners] = useState<Omit<PartnerRecord, 'jwtSecret'>[]>([])
  const [partnerId, setPartnerId] = useState('')
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [users, setUsers] = useState<{ rows: UserRecord[]; total: number }>({ rows: [], total: 0 })
  const [personas, setPersonas] = useState<{ rows: PersonaRow[]; total: number }>({
    rows: [],
    total: 0,
  })
  const limit = 50
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    void get<Omit<PartnerRecord, 'jwtSecret'>[]>('/v1/partners')
      .then(setPartners)
      .catch(() => {})
  }, [])

  // Debounced search: 300ms after the last keystroke.
  useEffect(() => {
    clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => {
      setOffset(0)
      setDebouncedQ(q)
    }, 300)
    return () => clearTimeout(debounceTimer.current)
  }, [q])

  const state = useLoad(async () => {
    const qs = new URLSearchParams({
      ...(partnerId ? { partnerId } : {}),
      ...(mode === 'users' && debouncedQ ? { q: debouncedQ } : {}),
      offset: String(offset),
      limit: String(limit),
    }).toString()
    if (mode === 'users') setUsers(await get<typeof users>(`/v1/users?${qs}`))
    else setPersonas(await get<typeof personas>(`/v1/memory?${qs}`))
  }, [mode, partnerId, debouncedQ, offset])

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
        {mode === 'users' && (
          <input
            class="search-box"
            type="search"
            placeholder="Search user id…"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
        )}
      </div>

      {state.error && <ErrorBanner message={state.error} retry={state.retry} />}
      {state.loading && <Busy rows={4} />}

      {!state.loading && !state.error && mode === 'users' && (
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
                <td colSpan={5}>
                  {debouncedQ ? (
                    <Empty title={`No users match “${debouncedQ}”.`} />
                  ) : (
                    <Empty
                      title="No registered users yet"
                      hint="Rows appear when partners mint JWT-bound sessions."
                    />
                  )}
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
      )}

      {!state.loading && !state.error && mode === 'memory' && (
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
                <td colSpan={6}>
                  <Empty
                    title="No personas held."
                    hint="Personas appear when embedded users opt in to memory."
                  />
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
          {total === 0 ? 0 : offset + 1}–{Math.min(offset + limit, total)} of {total}
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
  const [personaStatus, setPersonaStatus] = useState<PersonaStatus>('unavailable')
  const [facts, setFacts] = useState<LearnedFact[]>([])
  const [factsError, setFactsError] = useState(false)
  const [notFoundUser, setNotFoundUser] = useState(false)
  // Gateway-side reads degrade section-locally: null = unavailable (rendered
  // as an outage, never as "none").
  const [alerts, setAlerts] = useState<UserAlert[] | null>(null)
  const [identities, setIdentities] = useState<UserIdentity[] | null>(null)
  const [purgeResult, setPurgeResult] = useState<PurgeResponse | null>(null)

  const state = useLoad(async () => {
    // Durable auto-learned facts ride alongside the persona; a facts fetch
    // failure renders as a failure — "nothing learned" is a claim, and it
    // can't be made while the fetch is erroring.
    void get<LearnedFact[]>(
      `/v1/learned-facts/user/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`,
    )
      .then((rows) => {
        setFacts(Array.isArray(rows) ? rows : [])
        setFactsError(false)
      })
      .catch(() => {
        setFacts([])
        setFactsError(true)
      })
    // Alerts and identities are partner-scoped upstream — filtered here to
    // this user's key. A failed fetch leaves the section in its outage state.
    void get<{ alerts: UserAlert[] }>(`/v1/alerts?partnerId=${encodeURIComponent(partnerId)}`)
      .then((res) => setAlerts((res.alerts ?? []).filter((a) => a.userKey === userId)))
      .catch(() => setAlerts(null))
    void get<{ identities: UserIdentity[] }>(
      `/v1/identities?partnerId=${encodeURIComponent(partnerId)}`,
    )
      .then((res) =>
        setIdentities(
          (res.identities ?? []).filter((i) => identityMatchesUserKey(i.usernameLower, userId)),
        ),
      )
      .catch(() => setIdentities(null))
    // The user row exists only for authenticated users; memory may exist for
    // anonymous session keys too — fetch both, render what's there.
    try {
      const u = await get<
        UserRecord & { persona: Persona | null; personaStatus?: PersonaStatus }
      >(`/v1/users/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`)
      setUser(u)
      setPersona(u.persona)
      // personaStatus is the service's word on outage-vs-absence; an older
      // deploy without it degrades to the persona-null = unknown reading.
      setPersonaStatus(u.personaStatus ?? (u.persona ? 'ok' : 'unavailable'))
      setNotFoundUser(false)
      return
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err
      setNotFoundUser(true)
    }
    // Ask for this one persona by id. Scanning the first page of /v1/memory
    // used to answer "No memory held" for any user past row 50 — and hid the
    // Clear/Purge buttons a deletion request needs.
    try {
      const row = await get<PersonaRow>(
        `/v1/memory/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`,
      )
      setPersona(row.persona)
      setPersonaStatus('ok')
    } catch (err) {
      // 404 = the memory service positively holds nothing; anything else
      // (502, network) = memory state UNKNOWN — rendered as an outage.
      setPersona(null)
      setPersonaStatus(personaStatusFromError(err))
    }
  }, [partnerId, userId])

  async function setLevel(level: string) {
    try {
      await put(`/v1/memory/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`, {
        experienceLevel: level === '' ? null : level,
      })
      toast('Experience level updated')
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'update failed', 'err')
    }
  }

  async function clearMemory() {
    const ok = await confirmAction({
      title: 'Clear memory',
      body: 'Persona data is wiped; the user’s opt-in choice survives (clearing is not opting out).',
      confirmLabel: 'Clear memory',
    })
    if (!ok) return
    try {
      await post(`/v1/memory/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}/clear`)
      toast('Memory cleared')
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'clear failed', 'err')
    }
  }

  async function purgeMemory() {
    const ok = await confirmAction({
      title: 'Purge memory record',
      body: 'Hard delete — nothing survives, not even the opt-in flag.',
      confirmLabel: 'Purge',
      typedPhrase: userId,
    })
    if (!ok) return
    try {
      await del(`/v1/memory/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`)
      toast('Memory record purged')
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'purge failed', 'err')
    }
  }

  async function purgeLearnedFacts() {
    const ok = await confirmAction({
      title: 'Purge learned facts',
      body: 'Every auto-learned fact for this user is deleted — Hippo starts learning from scratch. Persona data and the opt-in choice are untouched.',
      confirmLabel: 'Purge learned facts',
      typedPhrase: userId,
    })
    if (!ok) return
    try {
      const res = await del<{ cleared: number }>(
        `/v1/learned-facts/user/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`,
      )
      toast(`Learned facts purged (${res.cleared ?? 0} cleared)`)
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'purge failed', 'err')
    }
  }

  async function cancelAlert(alert: UserAlert) {
    const ok = await confirmAction({
      title: 'Cancel alert',
      body: `${alert.symbol} ${alert.condition} ${alert.price} is disarmed — the user is not notified.`,
      confirmLabel: 'Cancel alert',
    })
    if (!ok) return
    try {
      const res = await post<{ cancelled: boolean }>(
        `/v1/alerts/${encodeURIComponent(alert.id)}/cancel`,
        { partnerId, userKey: userId },
      )
      toast(res.cancelled ? 'Alert cancelled' : 'Alert was not armed — nothing cancelled', res.cancelled ? 'ok' : 'err')
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'cancel failed', 'err')
    }
  }

  async function purgeEverywhere() {
    const ok = await confirmAction({
      title: 'Purge user EVERYWHERE',
      body: 'Right-to-erasure across every store: persona, learned facts, user note, and the gateway-side data (intent signals, uploads, alerts, identity). This cannot be undone. The per-store result is shown after — verify every leg succeeded.',
      confirmLabel: 'Purge everywhere',
      typedPhrase: userId,
    })
    if (!ok) return
    try {
      const res = await del<PurgeResponse>(
        `/v1/users/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}/everywhere`,
      )
      // The aggregate is rendered leg by leg — a failed store must never be
      // summarized away as success.
      setPurgeResult(res)
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'purge failed', 'err')
    }
  }

  async function setBlocked(action: 'block' | 'unblock') {
    if (action === 'block') {
      const ok = await confirmAction({
        title: `Block ${userId}`,
        body: 'Their next session mint is rejected with 401 until unblocked.',
        confirmLabel: 'Block user',
        typedPhrase: userId,
      })
      if (!ok) return
    }
    try {
      await post(
        `/v1/users/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}/${action}`,
      )
      toast(action === 'block' ? 'User blocked' : 'User unblocked')
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `${action} failed`, 'err')
    }
  }

  if (state.error) return <ErrorBanner message={state.error} retry={state.retry} />
  if (state.loading) return <Busy rows={4} />

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
      {personaStatus === 'unavailable' ? (
        <>
          <div class="alert warn" role="alert">
            Memory service unreachable — memory state UNKNOWN, do not treat as empty.
          </div>
          {/* The deletion controls stay visible so an erasure request is never
              hidden by an outage — disabled, with the reason, until memory
              answers. */}
          <div class="actions" style="margin-top:14px; display:flex; gap:8px; align-items:center">
            <button
              class="btn ghost sm"
              type="button"
              disabled
              title="Memory service unreachable — retry when it is back"
            >
              Clear memory
            </button>
            <button
              class="btn danger sm"
              type="button"
              disabled
              title="Memory service unreachable — retry when it is back"
            >
              Purge record
            </button>
            <span class="dim">disabled: memory service unreachable</span>
            <button class="btn ghost sm" type="button" onClick={() => state.retry()}>
              Retry
            </button>
          </div>
        </>
      ) : persona ? (
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

      <h2>Learned facts</h2>
      {factsError ? (
        <ErrorBanner
          message="Learned-facts fetch failed — what has been learned is UNKNOWN, not necessarily nothing."
          retry={state.retry}
        />
      ) : facts.length === 0 ? (
        <div class="dim">
          Nothing learned yet — durable facts appear here as Hippo picks up this trader's
          preferences from conversations.
        </div>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Fact</th>
                <th>Value</th>
                <th>Source</th>
                <th>Last observed</th>
              </tr>
            </thead>
            <tbody>
              {facts.map((f) => (
                <tr key={`${f.type}:${f.value}`}>
                  <td>{factLabel(f.type)}</td>
                  <td class="mono">{f.value}</td>
                  <td>
                    <span class={`badge ${f.source === 'admin' ? 'plan' : 'none'}`}>
                      {f.source}
                    </span>
                  </td>
                  <td class="dim">{fmt(f.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div class="actions" style="margin-top:14px">
            <button class="btn danger sm" type="button" onClick={purgeLearnedFacts}>
              Purge learned facts
            </button>
          </div>
        </>
      )}

      <h2>Alerts</h2>
      {alerts === null ? (
        <div class="dim">Alerts unavailable — the gateway could not be reached. Retry the page.</div>
      ) : alerts.length === 0 ? (
        <div class="dim">No alerts for this user.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Condition</th>
              <th>State</th>
              <th>Created</th>
              <th>Delivered</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id}>
                <td class="mono">{a.symbol}</td>
                <td class="mono">
                  {a.condition} {a.price}
                </td>
                <td>
                  <span class={`badge ${a.state === 'armed' ? 'active' : 'none'}`}>{a.state}</span>
                </td>
                <td class="dim">{fmt(a.createdAt)}</td>
                <td class="dim">{a.state === 'triggered' ? (a.delivered ? 'yes' : 'not yet') : '—'}</td>
                <td style="text-align:right">
                  {a.state === 'armed' && (
                    <button class="btn danger sm" type="button" onClick={() => cancelAlert(a)}>
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Identities</h2>
      {identities === null ? (
        <div class="dim">
          Identities unavailable — the gateway could not be reached. Retry the page.
        </div>
      ) : identities.length === 0 ? (
        <div class="dim">No in-panel identity claimed by this user key.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Claimed</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {identities.map((i) => (
              <tr key={i.usernameLower}>
                <td class="mono">{i.username}</td>
                <td class="dim">{fmt(i.createdAt)}</td>
                <td class="dim">{fmt(i.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Danger zone</h2>
      <p class="dim">
        Right-to-erasure: purges the persona, learned facts, user note, and all gateway-side data
        (intent signals, uploads, alerts, identity) in one action. Per-store results are shown
        honestly — verify every leg.
      </p>
      <button class="btn danger sm" type="button" onClick={purgeEverywhere}>
        Purge user everywhere
      </button>

      {purgeResult && (
        <>
          <button
            type="button"
            class="drawer-veil"
            aria-label="Close"
            onClick={() => setPurgeResult(null)}
          />
          <div class="modal" role="dialog" aria-modal="true">
            {/* Header truth comes from the per-row report, not the transport-
                level ok — the gateway leg can be HTTP-ok while a sub-store
                inside its body failed. */}
            {(() => {
              const rows = purgeRows(purgeResult.results)
              const allOk = purgeResult.ok && rows.every((r) => r.ok)
              return (
                <>
                  <h1>{allOk ? 'Purged everywhere' : 'Purge INCOMPLETE'}</h1>
                  <p class="modal-body">
                    {allOk
                      ? 'All four stores confirmed the erasure.'
                      : 'One or more stores failed — data may remain there. Retry once the failing service is back, and do not report this erasure as complete.'}
                  </p>
                </>
              )
            })()}
            <table>
              <tbody>
                {purgeRows(purgeResult.results).map((row) => (
                  <tr key={row.store}>
                    <td>{row.store}</td>
                    <td>
                      <span class={`badge ${row.ok ? 'active' : 'suspended'}`}>
                        {row.ok ? 'purged' : 'failed'}
                      </span>
                    </td>
                    <td class={row.ok ? 'dim' : 'error'}>{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div class="actions">
              <button class="btn" type="button" onClick={() => setPurgeResult(null)}>
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
