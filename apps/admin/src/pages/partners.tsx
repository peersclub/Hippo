import type { PartnerRecord, PlanRecord } from '@hippo/stores'
import { useEffect, useState } from 'preact/hooks'
import { ApiError, get, patch, post } from '../api.js'

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

  const load = () =>
    Promise.all([get<PartnerRow[]>('/v1/partners'), get<PlanRecord[]>('/v1/plans')])
      .then(([p, pl]) => {
        setPartners(p)
        setPlans(pl)
      })
      .catch(() => {})
  useEffect(() => {
    void load()
  }, [])

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
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'save failed')
    }
  }

  async function setStatus(partnerId: string, action: 'suspend' | 'activate') {
    if (action === 'suspend' && !confirm(`Suspend "${partnerId}"? New sessions will be rejected.`))
      return
    await post(`/v1/partners/${partnerId}/${action}`)
    await load()
  }

  async function assignPlan(partnerId: string, planId: string) {
    await post(`/v1/partners/${partnerId}/plan`, { planId: planId || null })
    await load()
  }

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
          {partners.map((p) => (
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
                    onClick={() => setStatus(p.partnerId, 'suspend')}
                  >
                    Suspend
                  </button>
                ) : (
                  <button
                    class="btn ghost sm"
                    type="button"
                    onClick={() => setStatus(p.partnerId, 'activate')}
                  >
                    Activate
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

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
