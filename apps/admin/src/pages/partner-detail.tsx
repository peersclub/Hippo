import type { PartnerRecord, PlanRecord, UserRecord } from '@hippo/stores'
import { useState } from 'preact/hooks'
import { del, get, post } from '../api.js'
import { navigate } from '../router.js'
import { Busy, confirmAction, ErrorBanner, toast, useLoad } from '../ui.js'

type SessionRow = {
  id: string
  partnerId: string
  venueUserId: string | null
  expiresAt: number
  connected: boolean
}

type Detail = {
  partner: Omit<PartnerRecord, 'jwtSecret'>
  plan: PlanRecord | null
  users: { rows: UserRecord[]; total: number }
  mau: { current: number; quota: number | null }
  sessions: SessionRow[]
}

const fmt = (ts: number) => new Date(ts).toLocaleString()

export function PartnerDetailPage({ partnerId }: { partnerId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null)

  const state = useLoad(async () => {
    setDetail(await get<Detail>(`/v1/partners/${encodeURIComponent(partnerId)}/detail`))
  }, [partnerId])

  async function killSession(id: string) {
    const ok = await confirmAction({
      title: 'Revoke session',
      body: `${id} is cut off immediately — the SSE socket closes and the client must mint a fresh session.`,
      confirmLabel: 'Revoke',
    })
    if (!ok) return
    await del(`/v1/sessions/${encodeURIComponent(id)}`)
    toast('Session revoked')
    state.retry()
  }

  async function setStatus(action: 'suspend' | 'activate') {
    if (action === 'suspend') {
      const ok = await confirmAction({
        title: `Suspend ${partnerId}`,
        body: 'ALL new sessions for this partner are rejected with 401 until reactivated. Existing sessions expire naturally.',
        confirmLabel: 'Suspend partner',
        typedPhrase: partnerId,
      })
      if (!ok) return
    }
    await post(`/v1/partners/${encodeURIComponent(partnerId)}/${action}`)
    toast(action === 'suspend' ? 'Partner suspended' : 'Partner activated')
    state.retry()
  }

  async function purgeAllMemory() {
    const ok = await confirmAction({
      title: 'Purge ALL memory for this partner',
      body: 'Hard-deletes every persona this partner holds — the offboarding/compliance primitive. This cannot be undone.',
      confirmLabel: 'Purge all',
      typedPhrase: partnerId,
    })
    if (!ok) return
    const res = await del<{ deleted: number }>(
      `/v1/memory?partnerId=${encodeURIComponent(partnerId)}`,
    )
    toast(`Purged ${res.deleted} persona record${res.deleted === 1 ? '' : 's'}`)
    state.retry()
  }

  if (state.error) return <ErrorBanner message={state.error} retry={state.retry} />
  if (state.loading || !detail) return <Busy rows={4} />

  const { partner, plan, users, mau, sessions } = detail
  const pct = mau.quota ? Math.min(100, Math.round((mau.current / mau.quota) * 100)) : null

  return (
    <>
      <div class="page-head">
        <h1>
          {partner.venueName} <span class="mono dim">{partner.partnerId}</span>{' '}
          <span class={`badge ${partner.status}`}>{partner.status}</span>
        </h1>
        <span>
          {partner.status === 'active' ? (
            <button class="btn danger sm" type="button" onClick={() => setStatus('suspend')}>
              Suspend
            </button>
          ) : (
            <button class="btn ghost sm" type="button" onClick={() => setStatus('activate')}>
              Activate
            </button>
          )}{' '}
          <button class="btn ghost sm" type="button" onClick={() => navigate('partners')}>
            ← Partners
          </button>
        </span>
      </div>

      <div class="cards">
        <div class="stat">
          <div class="n">{plan ? plan.name : '—'}</div>
          <div class="l">Plan {plan ? `(${plan.tier})` : '· none assigned'}</div>
        </div>
        <div class="stat">
          <div class="n">
            {mau.current}
            {mau.quota != null && (
              <span class="dim" style="font-size:14px">
                {' '}
                / {mau.quota}
              </span>
            )}
          </div>
          <div class="l">MAU this month{pct != null ? ` · ${pct}% of quota` : ' · unlimited'}</div>
          {pct != null && (
            <div style="margin-top:8px;height:5px;border-radius:3px;background:rgba(255,255,255,0.07)">
              <div
                style={`height:5px;border-radius:3px;width:${pct}%;background:${pct >= 100 ? 'var(--down)' : pct >= 80 ? 'var(--accent)' : 'var(--up)'}`}
              />
            </div>
          )}
        </div>
        <div class="stat">
          <div class="n">{users.total}</div>
          <div class="l">Registered users</div>
        </div>
        <div class="stat">
          <div class="n">{sessions.length}</div>
          <div class="l">Live sessions</div>
        </div>
      </div>

      <h2>Live sessions</h2>
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>User</th>
            <th>SSE</th>
            <th>Expires</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sessions.length === 0 && (
            <tr>
              <td colSpan={5} class="empty">
                No live sessions (or the gateway is unreachable).
              </td>
            </tr>
          )}
          {sessions.map((s) => (
            <tr key={s.id}>
              <td class="mono">{s.id}</td>
              <td class="mono">{s.venueUserId ?? <span class="dim">anonymous</span>}</td>
              <td>
                <span class={`badge ${s.connected ? 'active' : 'none'}`}>
                  {s.connected ? 'connected' : 'idle'}
                </span>
              </td>
              <td class="dim">{fmt(s.expiresAt)}</td>
              <td style="text-align:right">
                <button class="btn danger sm" type="button" onClick={() => killSession(s.id)}>
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Users ({users.total})</h2>
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>First seen</th>
            <th>Last seen</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {users.rows.length === 0 && (
            <tr>
              <td colSpan={4} class="empty">
                No registered users yet.
              </td>
            </tr>
          )}
          {users.rows.map((u) => (
            <tr
              key={u.userId}
              class="rowlink"
              onClick={() =>
                navigate(`users/${encodeURIComponent(u.partnerId)}/${encodeURIComponent(u.userId)}`)
              }
            >
              <td class="mono">{u.userId}</td>
              <td class="dim">{fmt(u.firstSeen)}</td>
              <td class="dim">{fmt(u.lastSeen)}</td>
              <td>
                <span class={`badge ${u.status}`}>{u.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {plan && (
        <>
          <h2>Plan entitlements</h2>
          <div class="chips">
            {Object.entries(plan.entitlements).map(([k, v]) => (
              <span class="chip" key={k}>
                {k}: {String(v)}
              </span>
            ))}
            {Object.keys(plan.entitlements).length === 0 && <span class="dim">none</span>}
          </div>
        </>
      )}

      <h2>Danger zone</h2>
      <button class="btn danger sm" type="button" onClick={purgeAllMemory}>
        Purge ALL memory for this partner
      </button>
    </>
  )
}
