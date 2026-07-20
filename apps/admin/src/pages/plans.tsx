import type { PlanRecord } from '@hippo/stores'
import { useState } from 'preact/hooks'
import { ApiError, del, get, patch, post } from '../api.js'
import { Busy, confirmAction, Empty, ErrorBanner, toast, useLoad } from '../ui.js'

type PlanDraft = {
  planId: string
  name: string
  tier: string
  mauQuota: string
  priceMonthlyUsd: string
  entitlements: string
}

const EMPTY: PlanDraft = {
  planId: '',
  name: '',
  tier: 'pilot',
  mauQuota: '',
  priceMonthlyUsd: '',
  entitlements: '{}',
}

export function PlansPage() {
  const [plans, setPlans] = useState<PlanRecord[]>([])
  const [draft, setDraft] = useState<PlanDraft | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = () => get<PlanRecord[]>('/v1/plans').then(setPlans)
  const state = useLoad(load)

  const field = (k: keyof PlanDraft) => (e: Event) =>
    setDraft((d) => (d ? { ...d, [k]: (e.target as HTMLInputElement).value } : d))

  async function save(e: Event) {
    e.preventDefault()
    if (!draft) return
    setError('')
    let entitlements: Record<string, unknown>
    try {
      entitlements = JSON.parse(draft.entitlements || '{}')
    } catch {
      setError('entitlements must be valid JSON')
      return
    }
    const body = {
      name: draft.name,
      tier: draft.tier,
      mauQuota: draft.mauQuota === '' ? null : Number(draft.mauQuota),
      priceMonthlyUsd: draft.priceMonthlyUsd === '' ? null : Number(draft.priceMonthlyUsd),
      entitlements,
    }
    try {
      if (editing) await patch(`/v1/plans/${editing}`, body)
      else await post('/v1/plans', { planId: draft.planId, ...body })
      setDraft(null)
      setEditing(null)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'save failed')
    }
  }

  async function remove(planId: string) {
    const ok = await confirmAction({
      title: `Delete plan ${planId}`,
      body: 'Partners must be unassigned first — delete is refused while any partner is on this plan.',
      confirmLabel: 'Delete plan',
      typedPhrase: planId,
    })
    if (!ok) return
    try {
      await del(`/v1/plans/${planId}`)
      toast(`Plan ${planId} deleted`)
      await load()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'delete failed', 'err')
    }
  }

  return (
    <>
      <div class="page-head">
        <h1>Plans</h1>
        <button
          class="btn"
          type="button"
          onClick={() => {
            setEditing(null)
            setDraft({ ...EMPTY })
          }}
        >
          New plan
        </button>
      </div>

      {state.error && <ErrorBanner message={state.error} retry={state.retry} />}
      {state.loading && <Busy rows={3} />}
      {!state.loading && !state.error && (
        <table>
          <thead>
            <tr>
              <th>Plan</th>
              <th>Tier</th>
              <th>MAU quota</th>
              <th>Price / mo</th>
              <th>Entitlements</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plans.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <Empty
                    title="No plans yet"
                    hint="Create the first tier with “New plan” above — partners get assigned to it from the Partners page."
                  />
                </td>
              </tr>
            )}
            {plans.map((p) => (
              <tr key={p.planId}>
                <td>
                  <strong>{p.name}</strong> <span class="mono dim">{p.planId}</span>
                </td>
                <td>
                  <span class="badge plan">{p.tier}</span>
                </td>
                <td class="mono">{p.mauQuota ?? 'unlimited'}</td>
                <td class="mono">{p.priceMonthlyUsd == null ? '—' : `$${p.priceMonthlyUsd}`}</td>
                <td>
                  <div class="chips">
                    {Object.keys(p.entitlements).length === 0 && <span class="dim">none</span>}
                    {Object.entries(p.entitlements).map(([k, v]) => (
                      <span class="chip" key={k}>
                        {k}: {String(v)}
                      </span>
                    ))}
                  </div>
                </td>
                <td style="text-align:right; white-space:nowrap">
                  <button
                    class="btn ghost sm"
                    type="button"
                    onClick={() => {
                      setEditing(p.planId)
                      setDraft({
                        planId: p.planId,
                        name: p.name,
                        tier: p.tier,
                        mauQuota: p.mauQuota == null ? '' : String(p.mauQuota),
                        priceMonthlyUsd: p.priceMonthlyUsd == null ? '' : String(p.priceMonthlyUsd),
                        entitlements: JSON.stringify(p.entitlements),
                      })
                    }}
                  >
                    Edit
                  </button>{' '}
                  <button class="btn danger sm" type="button" onClick={() => remove(p.planId)}>
                    Delete
                  </button>
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
            <h1>{editing ? `Edit ${editing}` : 'New plan'}</h1>
            <form class="stack" onSubmit={save}>
              {!editing && (
                <label class="field">
                  Plan id (slug)
                  <input
                    value={draft.planId}
                    onInput={field('planId')}
                    required
                    pattern="[a-z0-9-]{2,40}"
                  />
                </label>
              )}
              <label class="field">
                Name
                <input value={draft.name} onInput={field('name')} required />
              </label>
              <label class="field">
                Tier
                <input value={draft.tier} onInput={field('tier')} required />
              </label>
              <label class="field">
                MAU quota (blank = unlimited)
                <input value={draft.mauQuota} onInput={field('mauQuota')} type="number" min="1" />
              </label>
              <label class="field">
                Price monthly USD (blank = unset)
                <input
                  value={draft.priceMonthlyUsd}
                  onInput={field('priceMonthlyUsd')}
                  type="number"
                  min="0"
                  step="0.01"
                />
              </label>
              <label class="field">
                Entitlements (JSON)
                <textarea rows={4} value={draft.entitlements} onInput={field('entitlements')} />
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
