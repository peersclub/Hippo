import type { PartnerRecord } from '@hippo/stores'
import { useEffect, useState } from 'preact/hooks'
import { ApiError, del, get } from '../api.js'
import { Busy, confirmAction, Empty, ErrorBanner, toast, useLoad } from '../ui.js'

type SessionRow = {
  id: string
  partnerId: string
  venueUserId: string | null
  expiresAt: number
  connected: boolean
}

const fmt = (ts: number) => new Date(ts).toLocaleString()
const REFRESH_MS = 30_000

/** Fleet-wide live-session view: who is connected right now, across all
 * partners — with per-row revoke. Data comes from the gateway via the admin
 * service proxy (GET /v1/sessions). */
export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [partners, setPartners] = useState<Omit<PartnerRecord, 'jwtSecret'>[]>([])
  const [partnerId, setPartnerId] = useState('')
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  useEffect(() => {
    void get<Omit<PartnerRecord, 'jwtSecret'>[]>('/v1/partners')
      .then(setPartners)
      .catch(() => {})
  }, [])

  const state = useLoad(async () => {
    const qs = partnerId ? `?partnerId=${encodeURIComponent(partnerId)}` : ''
    setSessions(await get<SessionRow[]>(`/v1/sessions${qs}`))
    setUpdatedAt(new Date())
  }, [partnerId])

  // Live surface — ambient auto-refresh, same cadence as the dashboard.
  useEffect(() => {
    const t = setInterval(() => state.retry(), REFRESH_MS)
    return () => clearInterval(t)
  }, [state.retry])

  async function revoke(id: string) {
    const ok = await confirmAction({
      title: 'Revoke session',
      body: `${id} is cut off immediately — the SSE socket closes and the client must mint a fresh session.`,
      confirmLabel: 'Revoke',
    })
    if (!ok) return
    try {
      await del(`/v1/sessions/${encodeURIComponent(id)}`)
      toast('Session revoked')
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'revoke failed', 'err')
    }
  }

  const connected = sessions.filter((s) => s.connected).length
  const venueName = (id: string) => partners.find((p) => p.partnerId === id)?.venueName

  return (
    <>
      <div class="page-head">
        <h1>Live sessions</h1>
        <span class="dim">
          {!state.loading && !state.error && `${sessions.length} live · ${connected} connected`}
          {updatedAt && ` · updated ${updatedAt.toLocaleTimeString()}`}
        </span>
      </div>

      <div class="toolbar">
        <select
          value={partnerId}
          onChange={(e) => setPartnerId((e.target as HTMLSelectElement).value)}
        >
          <option value="">All partners</option>
          {partners.map((p) => (
            <option key={p.partnerId} value={p.partnerId}>
              {p.venueName}
            </option>
          ))}
        </select>
      </div>

      {state.error && (
        <ErrorBanner
          message={
            state.error === 'gateway unreachable'
              ? 'Gateway unreachable — live sessions cannot be listed or revoked right now.'
              : state.error
          }
          retry={state.retry}
        />
      )}
      {state.loading && <Busy rows={4} />}

      {!state.loading && !state.error && (
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Partner</th>
              <th>User</th>
              <th>SSE</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <Empty
                    title={partnerId ? 'No live sessions for this partner.' : 'No live sessions.'}
                    hint="Rows appear the moment an embedded client mints a session."
                  />
                </td>
              </tr>
            )}
            {sessions.map((s) => (
              <tr key={s.id}>
                <td class="mono">{s.id}</td>
                <td>
                  {venueName(s.partnerId) ?? s.partnerId}{' '}
                  <span class="mono dim">{s.partnerId}</span>
                </td>
                <td class="mono">{s.venueUserId ?? <span class="dim">anonymous</span>}</td>
                <td>
                  <span class={`badge ${s.connected ? 'active' : 'none'}`}>
                    {s.connected ? 'connected' : 'idle'}
                  </span>
                </td>
                <td class="dim">{fmt(s.expiresAt)}</td>
                <td style="text-align:right">
                  <button class="btn danger sm" type="button" onClick={() => revoke(s.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
