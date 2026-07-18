import { useState } from 'preact/hooks'
import { get } from '../api.js'
import { Busy, ErrorBanner, useLoad } from '../ui.js'

type Overview = {
  partnerId: string
  venueName: string
  status: 'active' | 'suspended' | 'sandbox'
  mau: number | null
  mauQuota: number | null
  userCount: number
  plan: { planId: string; name: string; tier: string } | null
}

export function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null)
  const state = useLoad(async () => setData(await get<Overview>('/portal/overview')))

  if (state.error) return <ErrorBanner message={state.error} retry={state.retry} />
  if (state.loading && !data) return <Busy rows={3} />
  if (!data) return null

  const pct =
    data.mau !== null && data.mauQuota ? Math.round((data.mau / data.mauQuota) * 100) : null

  return (
    <>
      <div class="page-head">
        <h1>{data.venueName}</h1>
        <span class={`badge ${data.status}`}>{data.status}</span>
      </div>
      <div class="cards">
        <div class="stat">
          <span class="dim">MAU this month</span>
          <strong>{data.mau ?? '—'}</strong>
          {pct !== null && (
            <span class="dim">
              {pct}% of {data.mauQuota} quota
            </span>
          )}
        </div>
        <div class="stat">
          <span class="dim">Known users</span>
          <strong>{data.userCount}</strong>
        </div>
        <div class="stat">
          <span class="dim">Plan</span>
          <strong>{data.plan ? data.plan.name : 'Unassigned'}</strong>
          {data.plan && <span class="dim">{data.plan.tier}</span>}
        </div>
      </div>
      {data.status === 'sandbox' && (
        <div class="alerts">
          <div class="alert">
            Sandbox mode — production activation is handled by the Hippo team.
          </div>
        </div>
      )}
    </>
  )
}
