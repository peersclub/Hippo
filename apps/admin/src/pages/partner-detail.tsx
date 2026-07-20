import type { PartnerRecord, PlanRecord, UserRecord } from '@hippo/stores'
import { useState } from 'preact/hooks'
import { ApiError, del, get, post } from '../api.js'
import { navigate } from '../router.js'
import { Busy, confirmAction, Empty, ErrorBanner, toast, useLoad } from '../ui.js'

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

type AdminSeat = {
  email: string
  role: 'admin' | 'viewer'
  claimed: boolean
  inviteExpiresAt: number | null
  createdAt: number
}

type InviteDraft = { email: string; role: 'admin' | 'viewer' }

/** POST /v1/partners/:id/admins response — inviteToken appears here ONCE. */
type MintedInvite = { email: string; inviteToken: string; inviteExpiresAt: number }

const fmt = (ts: number) => new Date(ts).toLocaleString()

export function PartnerDetailPage({ partnerId }: { partnerId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [admins, setAdmins] = useState<AdminSeat[] | null>([])
  const [invite, setInvite] = useState<InviteDraft | null>(null)
  const [minted, setMinted] = useState<MintedInvite | null>(null)

  const state = useLoad(async () => {
    // Seats degrade to an inline notice (null) — they never take down the
    // whole detail view.
    const [d, seats] = await Promise.all([
      get<Detail>(`/v1/partners/${encodeURIComponent(partnerId)}/detail`),
      get<AdminSeat[]>(`/v1/partners/${encodeURIComponent(partnerId)}/admins`).catch(() => null),
    ])
    setDetail(d)
    setAdmins(seats)
  }, [partnerId])

  async function killSession(id: string) {
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

  async function setStatus(action: 'suspend' | 'activate') {
    const fromSandbox = detail?.partner.status === 'sandbox'
    if (action === 'suspend') {
      const ok = await confirmAction({
        title: `Suspend ${partnerId}`,
        body: 'ALL new sessions for this partner are rejected with 401 until reactivated. Existing sessions expire naturally.',
        confirmLabel: 'Suspend partner',
        typedPhrase: partnerId,
      })
      if (!ok) return
    } else if (fromSandbox) {
      const ok = await confirmAction({
        title: `Approve ${partnerId} to production`,
        body: `${detail?.partner.venueName} self-provisioned via hippo register. Approving makes it a production partner — real sessions mint against its embed key immediately.`,
        confirmLabel: 'Approve to production',
        danger: false,
      })
      if (!ok) return
    }
    try {
      await post(`/v1/partners/${encodeURIComponent(partnerId)}/${action}`)
      toast(
        action === 'suspend'
          ? 'Partner suspended'
          : fromSandbox
            ? 'Partner approved to production'
            : 'Partner activated',
      )
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `${action} failed`, 'err')
    }
  }

  async function purgeAllMemory() {
    const ok = await confirmAction({
      title: 'Purge ALL memory for this partner',
      body: 'Hard-deletes every persona this partner holds — the offboarding/compliance primitive. This cannot be undone.',
      confirmLabel: 'Purge all',
      typedPhrase: partnerId,
    })
    if (!ok) return
    try {
      const res = await del<{ deleted: number }>(
        `/v1/memory?partnerId=${encodeURIComponent(partnerId)}`,
      )
      toast(`Purged ${res.deleted} persona record${res.deleted === 1 ? '' : 's'}`)
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'purge failed', 'err')
    }
  }

  async function sendInvite(e: Event) {
    e.preventDefault()
    if (!invite) return
    try {
      const res = await post<MintedInvite>(
        `/v1/partners/${encodeURIComponent(partnerId)}/admins`,
        invite,
      )
      setInvite(null)
      // The plaintext token exists only in this response — show it once.
      setMinted(res)
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'invite failed', 'err')
    }
  }

  async function revokeSeat(email: string) {
    const ok = await confirmAction({
      title: 'Revoke portal seat',
      body: `${email} loses portal access immediately; an unclaimed invite token is burned.`,
      confirmLabel: 'Revoke seat',
      typedPhrase: email,
    })
    if (!ok) return
    try {
      await del(`/v1/partners/${encodeURIComponent(partnerId)}/admins/${encodeURIComponent(email)}`)
      toast('Portal seat revoked')
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'revoke failed', 'err')
    }
  }

  function copyToken(token: string) {
    navigator.clipboard.writeText(token).then(
      () => toast('Invite token copied'),
      () => toast('copy failed — select the token manually', 'err'),
    )
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
          ) : partner.status === 'sandbox' ? (
            <button class="btn sm" type="button" onClick={() => setStatus('activate')}>
              Approve to production
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

      <div class="page-head" style="margin-top:22px; margin-bottom:0">
        <h2>Portal admins</h2>
        <button
          class="btn ghost sm"
          type="button"
          onClick={() => setInvite({ email: '', role: 'admin' })}
        >
          Invite admin
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Invite expires</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {admins === null && (
            <tr>
              <td colSpan={5}>
                <Empty
                  title="Portal seats unavailable"
                  hint="The admin service could not list them — reload to retry."
                />
              </td>
            </tr>
          )}
          {admins?.length === 0 && (
            <tr>
              <td colSpan={5}>
                <Empty
                  title="No portal seats yet"
                  hint="Invite the partner’s first admin — the one-time claim token is shown right after."
                />
              </td>
            </tr>
          )}
          {(admins ?? []).map((a) => {
            const expired =
              !a.claimed && a.inviteExpiresAt != null && a.inviteExpiresAt < Date.now()
            return (
              <tr key={a.email}>
                <td class="mono">{a.email}</td>
                <td>
                  <span class="badge plan">{a.role}</span>
                </td>
                <td>
                  <span class={`badge ${a.claimed ? 'active' : expired ? 'suspended' : 'none'}`}>
                    {a.claimed ? 'claimed' : expired ? 'invite expired' : 'invited'}
                  </span>
                </td>
                <td class="dim">
                  {a.claimed || a.inviteExpiresAt == null ? '—' : fmt(a.inviteExpiresAt)}
                </td>
                <td style="text-align:right">
                  <button class="btn danger sm" type="button" onClick={() => revokeSeat(a.email)}>
                    Revoke
                  </button>
                </td>
              </tr>
            )
          })}
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

      {invite && (
        <>
          <button
            type="button"
            class="drawer-veil"
            aria-label="Close"
            onClick={() => setInvite(null)}
          />
          <div class="drawer">
            <h1>Invite portal admin</h1>
            <form class="stack" onSubmit={sendInvite}>
              <label class="field">
                Email
                <input
                  type="email"
                  value={invite.email}
                  onInput={(e) =>
                    setInvite((d) =>
                      d ? { ...d, email: (e.target as HTMLInputElement).value } : d,
                    )
                  }
                  required
                />
              </label>
              <label class="field">
                Role
                <select
                  value={invite.role}
                  onChange={(e) =>
                    setInvite((d) =>
                      d
                        ? {
                            ...d,
                            role: (e.target as HTMLSelectElement).value as 'admin' | 'viewer',
                          }
                        : d,
                    )
                  }
                >
                  <option value="admin">admin</option>
                  <option value="viewer">viewer</option>
                </select>
              </label>
              <div class="actions">
                <button class="btn" type="submit">
                  Mint invite
                </button>
                <button class="btn ghost" type="button" onClick={() => setInvite(null)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {minted && (
        <>
          <button
            type="button"
            class="drawer-veil"
            aria-label="Close"
            onClick={() => setMinted(null)}
          />
          <div class="modal" role="dialog" aria-modal="true">
            <h1>Invite minted for {minted.email}</h1>
            <p class="modal-body">
              Hand this token to the partner out-of-band. It is shown ONCE and is not retrievable
              again — only its hash is stored. The invite expires {fmt(minted.inviteExpiresAt)}.
            </p>
            <div class="token-box">{minted.inviteToken}</div>
            <div class="actions">
              <button class="btn" type="button" onClick={() => copyToken(minted.inviteToken)}>
                Copy token
              </button>
              <button class="btn ghost" type="button" onClick={() => setMinted(null)}>
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
