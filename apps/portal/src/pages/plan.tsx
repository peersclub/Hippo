import { useState } from 'preact/hooks'
import { currentAdmin, get, post } from '../api.js'
import { Busy, ErrorBanner, toast, useLoad } from '../ui.js'

type PlanView = {
  plan: {
    planId: string
    name: string
    tier: string
    mauQuota: number | null
    priceMonthlyUsd: number | null
    entitlements: Record<string, unknown>
  } | null
  usage: { mau: number | null; mauQuota: number | null }
}

export function PlanPage() {
  const [data, setData] = useState<PlanView | null>(null)
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState(false)
  const readOnly = currentAdmin.value?.role !== 'admin'

  const state = useLoad(async () => setData(await get<PlanView>('/portal/plan')))

  async function request(e: Event) {
    e.preventDefault()
    try {
      await post('/portal/plan/request', { message })
      setSent(true)
      toast('Request sent — the Hippo team will follow up')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'request failed', 'err')
    }
  }

  if (state.error) return <ErrorBanner message={state.error} retry={state.retry} />
  if (state.loading && !data) return <Busy rows={3} />
  if (!data) return null

  const { plan, usage } = data
  const pct =
    usage.mau !== null && usage.mauQuota ? Math.round((usage.mau / usage.mauQuota) * 100) : null

  return (
    <>
      <div class="page-head">
        <h1>Plan</h1>
        {plan && <span class="badge plan">{plan.tier}</span>}
      </div>

      {plan ? (
        <div class="cards">
          <div class="stat">
            <span class="dim">Plan</span>
            <strong>{plan.name}</strong>
          </div>
          <div class="stat">
            <span class="dim">MAU usage</span>
            <strong>
              {usage.mau ?? '—'}
              {plan.mauQuota ? ` / ${plan.mauQuota}` : ''}
            </strong>
            {pct !== null && <span class="dim">{pct}% used</span>}
          </div>
          <div class="stat">
            <span class="dim">Monthly</span>
            <strong>{plan.priceMonthlyUsd !== null ? `$${plan.priceMonthlyUsd}` : '—'}</strong>
          </div>
        </div>
      ) : (
        <div class="empty">No plan assigned yet — usage is not quota-limited.</div>
      )}

      {plan && Object.keys(plan.entitlements).length > 0 && (
        <div class="stack">
          <h2>Entitlements</h2>
          <div class="chips">
            {Object.entries(plan.entitlements).map(([k, v]) => (
              <span key={k} class="chip">
                {k}: {String(v)}
              </span>
            ))}
          </div>
        </div>
      )}

      {!readOnly && (
        <form class="stack" onSubmit={request}>
          <h2>Request a change</h2>
          <label class="field">
            What do you need?
            <textarea
              rows={3}
              value={message}
              onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)}
              required
              maxLength={1000}
              placeholder="e.g. We expect 3× MAU next quarter — what does the growth tier look like?"
            />
          </label>
          <button class="btn" type="submit" disabled={sent}>
            {sent ? 'Sent' : 'Send to Hippo'}
          </button>
        </form>
      )}
    </>
  )
}
