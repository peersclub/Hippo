import type { PartnerRecord, PlanRecord } from '@hippo/stores'
import { useState } from 'preact/hooks'
import { ApiError, get, patch, post } from '../api.js'
import { Busy, confirmAction, Empty, ErrorBanner, toast, useLoad } from '../ui.js'

/** List view never receives jwtSecret (the service strips it). */
type PartnerRow = Omit<PartnerRecord, 'jwtSecret'>

type Draft = {
  partnerId: string
  partnerKey: string
  jwtSecret: string
  venueName: string
  locales: string
  suggestedQueries: string
}

const EMPTY: Draft = {
  partnerId: '',
  partnerKey: 'pk_',
  jwtSecret: '',
  venueName: '',
  locales: 'en',
  suggestedQueries: '',
}

export function PartnersPage() {
  const [partners, setPartners] = useState<PartnerRow[]>([])
  const [plans, setPlans] = useState<PlanRecord[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const load = () =>
    Promise.all([get<PartnerRow[]>('/v1/partners'), get<PlanRecord[]>('/v1/plans')]).then(
      ([p, pl]) => {
        setPartners(p)
        setPlans(pl)
      },
    )
  const state = useLoad(load)

  const field = (k: keyof Draft) => (e: Event) =>
    setDraft((d) => (d ? { ...d, [k]: (e.target as HTMLInputElement).value } : d))

  async function save(e: Event) {
    e.preventDefault()
    if (!draft) return
    setError('')
    const shared = {
      venueName: draft.venueName,
      locales: draft.locales
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      suggestedQueries: draft.suggestedQueries
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    }
    try {
      if (editing) {
        await patch(`/v1/partners/${editing}`, {
          ...shared,
          ...(draft.jwtSecret ? { jwtSecret: draft.jwtSecret } : {}),
        })
      } else {
        await post('/v1/partners', {
          partnerId: draft.partnerId,
          partnerKey: draft.partnerKey,
          jwtSecret: draft.jwtSecret,
          ...shared,
        })
      }
      setDraft(null)
      setEditing(null)
      state.retry()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'save failed')
    }
  }

  async function setStatus(p: PartnerRow, action: 'suspend' | 'activate') {
    if (action === 'suspend') {
      const ok = await confirmAction({
        title: `Suspend ${p.partnerId}`,
        body: 'ALL new sessions for this partner are rejected with 401 until reactivated.',
        confirmLabel: 'Suspend partner',
        typedPhrase: p.partnerId,
      })
      if (!ok) return
    } else if (p.status === 'sandbox') {
      // Approving a self-serve sandbox to production is a different decision
      // from un-suspending — it flips a public signup live.
      const ok = await confirmAction({
        title: `Approve ${p.partnerId} to production`,
        body: `${p.venueName} self-provisioned via hippo register. Approving makes it a production partner — real sessions mint against its embed key immediately.`,
        confirmLabel: 'Approve to production',
        danger: false,
      })
      if (!ok) return
    }
    try {
      await post(`/v1/partners/${p.partnerId}/${action}`)
      toast(
        action === 'suspend'
          ? `${p.partnerId} suspended`
          : p.status === 'sandbox'
            ? `${p.partnerId} approved to production`
            : `${p.partnerId} activated`,
      )
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `${action} failed`, 'err')
    }
  }

  async function assignPlan(partnerId: string, planId: string) {
    try {
      await post(`/v1/partners/${partnerId}/plan`, { planId: planId || null })
      toast(planId ? `Plan ${planId} assigned to ${partnerId}` : `Plan removed from ${partnerId}`)
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'plan assignment failed', 'err')
    }
  }

  const sandboxCount = partners.filter((p) => p.status === 'sandbox').length
  const visible = statusFilter ? partners.filter((p) => p.status === statusFilter) : partners

  return (
    <>
      <div class="page-head">
        <h1>Partners</h1>
        <button
          class="btn"
          type="button"
          onClick={() => {
            setEditing(null)
            setDraft({ ...EMPTY })
          }}
        >
          New partner
        </button>
      </div>

      {state.error && <ErrorBanner message={state.error} retry={state.retry} />}
      {state.loading && <Busy rows={3} />}
      {!state.loading && !state.error && sandboxCount > 0 && statusFilter !== 'sandbox' && (
        <div class="alerts">
          <button type="button" class="alert warn" onClick={() => setStatusFilter('sandbox')}>
            <strong>
              {sandboxCount} sandbox partner{sandboxCount === 1 ? '' : 's'}
            </strong>{' '}
            awaiting production approval — click to review.
          </button>
        </div>
      )}
      {!state.loading && !state.error && (
        <div class="toolbar">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter((e.target as HTMLSelectElement).value)}
          >
            <option value="">All statuses</option>
            <option value="active">active</option>
            <option value="sandbox">sandbox</option>
            <option value="suspended">suspended</option>
          </select>
        </div>
      )}
      {!state.loading && !state.error && (
        <table>
          <thead>
            <tr>
              <th>Partner</th>
              <th>Embed key</th>
              <th>Status</th>
              <th>Plan</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={5}>
                  {statusFilter ? (
                    <Empty title={`No ${statusFilter} partners.`} />
                  ) : (
                    <Empty
                      title="No partners yet"
                      hint="Create one with “New partner” above, or wait for self-serve hippo register sandboxes to appear."
                    />
                  )}
                </td>
              </tr>
            )}
            {visible.map((p) => (
              <tr key={p.partnerId}>
                <td>
                  <strong>{p.venueName}</strong> <span class="mono dim">{p.partnerId}</span>
                </td>
                <td class="mono">{p.partnerKey}</td>
                <td>
                  <span class={`badge ${p.status}`}>{p.status}</span>
                </td>
                <td>
                  <select
                    value={p.planId ?? ''}
                    onChange={(e) => assignPlan(p.partnerId, (e.target as HTMLSelectElement).value)}
                  >
                    <option value="">— no plan —</option>
                    {plans.map((pl) => (
                      <option key={pl.planId} value={pl.planId}>
                        {pl.name} ({pl.tier})
                      </option>
                    ))}
                  </select>
                </td>
                <td style="text-align:right; white-space:nowrap">
                  <a
                    class="btn ghost sm"
                    style="text-decoration:none"
                    href={`#/partners/${p.partnerId}`}
                  >
                    Detail
                  </a>{' '}
                  <button
                    class="btn ghost sm"
                    type="button"
                    onClick={() => {
                      setEditing(p.partnerId)
                      setDraft({
                        partnerId: p.partnerId,
                        partnerKey: p.partnerKey,
                        jwtSecret: '',
                        venueName: p.venueName,
                        locales: p.locales.join(', '),
                        suggestedQueries: p.suggestedQueries.join('\n'),
                      })
                    }}
                  >
                    Edit
                  </button>{' '}
                  {p.status === 'active' ? (
                    <button
                      class="btn danger sm"
                      type="button"
                      onClick={() => setStatus(p, 'suspend')}
                    >
                      Suspend
                    </button>
                  ) : p.status === 'sandbox' ? (
                    <button class="btn sm" type="button" onClick={() => setStatus(p, 'activate')}>
                      Approve
                    </button>
                  ) : (
                    <button
                      class="btn ghost sm"
                      type="button"
                      onClick={() => setStatus(p, 'activate')}
                    >
                      Activate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {draft && (
        <>
          <button
            type="button"
            class="drawer-veil"
            aria-label="Close"
            onClick={() => {
              setDraft(null)
              setEditing(null)
            }}
          />
          <div class="drawer">
            <h1>{editing ? `Edit ${editing}` : 'New partner'}</h1>
            <form class="stack" onSubmit={save}>
              {!editing && (
                <>
                  <label class="field">
                    Partner id (slug)
                    <input
                      value={draft.partnerId}
                      onInput={field('partnerId')}
                      required
                      pattern="[a-z0-9-]{2,40}"
                    />
                  </label>
                  <label class="field">
                    Embed key (pk_…)
                    <input
                      value={draft.partnerKey}
                      onInput={field('partnerKey')}
                      required
                      pattern="pk_[A-Za-z0-9_-]{2,60}"
                    />
                  </label>
                </>
              )}
              <label class="field">
                {editing ? 'Rotate JWT secret (blank = keep current)' : 'JWT secret'}
                <input
                  value={draft.jwtSecret}
                  onInput={field('jwtSecret')}
                  type="password"
                  minLength={8}
                  required={!editing}
                />
              </label>
              <label class="field">
                Venue name
                <input value={draft.venueName} onInput={field('venueName')} required />
              </label>
              <label class="field">
                Locales (comma separated)
                <input value={draft.locales} onInput={field('locales')} />
              </label>
              <label class="field">
                Suggested queries (one per line)
                <textarea
                  rows={4}
                  value={draft.suggestedQueries}
                  onInput={field('suggestedQueries')}
                />
              </label>
              <div class="actions">
                <button class="btn" type="submit">
                  Save
                </button>
                <button
                  class="btn ghost"
                  type="button"
                  onClick={() => {
                    setDraft(null)
                    setEditing(null)
                  }}
                >
                  Cancel
                </button>
              </div>
              {error && <div class="error">{error}</div>}
            </form>
          </div>
        </>
      )}
    </>
  )
}
