import { useEffect, useState } from 'preact/hooks'
import { get } from '../api.js'
import { Busy, ErrorBanner, useLoad } from '../ui.js'

type Metrics = {
  gateway: {
    mau?: { month: string; research_answered: number; order_executed: number }
    cache?: { hitRate: number | null }
    degraded?: { active: boolean; seconds: number }
  } | null
  intelligence: {
    mode: string
    model: string
    cache?: { entries: number; hitRate: number }
  } | null
  alerts: Array<{ partnerId: string; venueName: string; mau: number; quota: number; pct: number }>
  counts: { partners: number; sandboxPartners: number; plans: number; users: number }
}

const REFRESH_MS = 30_000

export function DashboardPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const state = useLoad(async () => {
    setMetrics(await get<Metrics>('/v1/metrics'))
    setUpdatedAt(new Date())
  })

  // Ambient auto-refresh — the panel is a monitoring surface.
  useEffect(() => {
    const t = setInterval(() => state.retry(), REFRESH_MS)
    return () => clearInterval(t)
  }, [state.retry])

  if (state.error) return <ErrorBanner message={state.error} retry={state.retry} />
  if (state.loading && !metrics) return <Busy rows={3} />
  if (!metrics) return null

  const gw = metrics.gateway
  const intel = metrics.intelligence
  // The intelligence-side cache stats are authoritative (Redis-backed, live
  // entry occupancy); the gateway's in-process counter is only the fallback.
  const hitRate = intel?.cache ? intel.cache.hitRate : gw?.cache?.hitRate
  const hitRateFromGateway = !intel?.cache && gw?.cache?.hitRate != null
  const sandbox = metrics.counts.sandboxPartners

  return (
    <>
      <div class="page-head">
        <h1>Dashboard</h1>
        <span class="dim">
          {gw?.mau?.month && `MAU month: ${gw.mau.month} · `}
          {updatedAt && `updated ${updatedAt.toLocaleTimeString()}`}
        </span>
      </div>

      {(metrics.alerts.length > 0 || sandbox > 0) && (
        <div class="alerts">
          {sandbox > 0 && (
            <a class="alert warn" href="#/partners">
              <strong>
                {sandbox} sandbox partner{sandbox === 1 ? '' : 's'}
              </strong>{' '}
              awaiting production approval
            </a>
          )}
          {metrics.alerts.map((a) => (
            <a
              key={a.partnerId}
              class={`alert ${a.pct >= 100 ? 'crit' : 'warn'}`}
              href={`#/partners/${a.partnerId}`}
            >
              <strong>{a.venueName}</strong> is at {a.pct}% of its MAU quota ({a.mau}/{a.quota})
              {a.pct >= 100 ? ' — new users are being rejected (429)' : ''}
            </a>
          ))}
        </div>
      )}

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
          <div class="l">Answer-cache hit rate{hitRateFromGateway ? ' (gateway)' : ''}</div>
        </div>
        <div class="stat">
          <div class="n">{intel?.cache ? intel.cache.entries : '—'}</div>
          <div class="l">Answer-cache entries</div>
        </div>
        <div class="stat">
          <div class="n">{gw ? (gw.degraded?.seconds ?? 0) : '—'}</div>
          <div class="l">Degraded seconds</div>
        </div>
        <div class="stat">
          <div class="n text">
            {intel ? (
              <>
                {intel.model}{' '}
                <span class={`badge ${intel.mode === 'llm' ? 'llm' : 'none'}`}>{intel.mode}</span>
              </>
            ) : (
              '—'
            )}
          </div>
          <div class="l">LLM · active model</div>
        </div>
      </div>
      {!gw && <div class="dim">Gateway unreachable — live MAU/cache metrics unavailable.</div>}
      {!intel && <div class="dim">Intelligence service unreachable — active model unknown.</div>}
    </>
  )
}
