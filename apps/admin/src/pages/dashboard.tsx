import { useEffect, useState } from 'preact/hooks'
import { get } from '../api.js'

type Metrics = {
  gateway: {
    mau?: { month: string; research_answered: number; order_executed: number }
    cache?: { hitRate: number | null }
    degraded?: { active: boolean; seconds: number }
  } | null
  counts: { partners: number; plans: number; users: number }
}

export function DashboardPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    get<Metrics>('/v1/metrics')
      .then(setMetrics)
      .catch((e) => setError(String(e.message ?? e)))
  }, [])

  if (error) return <div class="error">{error}</div>
  if (!metrics) return <div class="empty">Loading…</div>

  const gw = metrics.gateway
  const hitRate = gw?.cache?.hitRate

  return (
    <>
      <div class="page-head">
        <h1>Dashboard</h1>
        {gw?.mau?.month && <span class="dim">MAU month: {gw.mau.month}</span>}
      </div>
      <div class="cards">
        <div class="stat">
          <div class="n">{metrics.counts.partners}</div>
          <div class="l">Partners</div>
        </div>
        <div class="stat">
          <div class="n">{metrics.counts.plans}</div>
          <div class="l">Plans</div>
        </div>
        <div class="stat">
          <div class="n">{metrics.counts.users}</div>
          <div class="l">Registered users</div>
        </div>
        <div class="stat">
          <div class="n">{gw ? (gw.mau?.research_answered ?? 0) : '—'}</div>
          <div class="l">MAU · research answered</div>
        </div>
        <div class="stat">
          <div class="n">{gw ? (gw.mau?.order_executed ?? 0) : '—'}</div>
          <div class="l">MAU · orders executed</div>
        </div>
        <div class="stat">
          <div class="n">{hitRate == null ? '—' : `${Math.round(hitRate * 100)}%`}</div>
          <div class="l">Answer-cache hit rate</div>
        </div>
        <div class="stat">
          <div class="n">{gw ? (gw.degraded?.seconds ?? 0) : '—'}</div>
          <div class="l">Degraded seconds</div>
        </div>
      </div>
      {!gw && <div class="dim">Gateway unreachable — live MAU/cache metrics unavailable.</div>}
    </>
  )
}
