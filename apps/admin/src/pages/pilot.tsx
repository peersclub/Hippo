import { useEffect, useState } from 'preact/hooks'
import { get } from '../api.js'
import { Busy, ErrorBanner, useLoad } from '../ui.js'

/**
 * Pilot instrumentation — the rate-card numbers on one page: MAU vs quota per
 * partner, queries/MAU, answer-cache hit rate, advice-decline rate, a 24h load
 * curve, and a cost-per-MAU ESTIMATOR (assumptions editable, clearly labeled —
 * real token accounting is a follow-up). Counter provenance is mixed and the
 * page says so: MAU is durable (calendar month), everything else is the
 * gateway's in-process memory since its last boot.
 */

type LoadBucket = { hourStartMs: number; uplinks: number; queries: number }

type UsageBucket = { calls: number; promptTokens: number; completionTokens: number }

/** GET /admin/usage on the intelligence service — measured tokens since ITS
 * boot (a different boot clock than the gateway's; both are labeled). */
type MeasuredUsage = {
  bootAt: number
  calls: number
  unmetered: number
  promptTokens: number
  completionTokens: number
  byPurpose: Record<string, UsageBucket>
  byModel: Record<string, UsageBucket>
}

type Metrics = {
  gateway: {
    turns?: Record<string, number>
    intents?: Record<string, number>
    mau?: { month: string; research_answered: number; order_executed: number }
    cache?: { hits: number; misses: number; hitRate: number | null }
    advice?: { answered: number; declined: number; declineRate: number | null }
    loadCurve?: LoadBucket[]
    degraded?: { active: boolean; seconds: number }
  } | null
  intelligence: {
    mode: string
    model: string
    cache?: { entries: number; hitRate: number }
    usage?: MeasuredUsage
  } | null
  partnerMau?: Array<{
    partnerId: string
    venueName: string
    status: string
    mau: number
    quota: number | null
  }>
}

const REFRESH_MS = 30_000
const HOUR_MS = 3_600_000

// Series colors, validated (dataviz six checks) against the panel surface:
// blue = all uplinks, amber = user queries (the billable-activity subset).
const C_UPLINKS = '#4a86d6'
const C_QUERIES = '#b98a2e'

const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`)

/** The last 24 whole hours as a dense series — an hour with no traffic renders
 * as an honest zero, not a hole in the axis. */
export function denseCurve(sparse: LoadBucket[], now = Date.now()): LoadBucket[] {
  const byHour = new Map(sparse.map((b) => [b.hourStartMs, b]))
  const end = now - (now % HOUR_MS)
  const out: LoadBucket[] = []
  for (let h = end - 23 * HOUR_MS; h <= end; h += HOUR_MS) {
    out.push(byHour.get(h) ?? { hourStartMs: h, uplinks: 0, queries: 0 })
  }
  return out
}

/** 24h load curve: grouped hour bars (uplinks beside queries), recessive
 * grid, hover tooltip per hour. Pure SVG — no chart dependency. */
function LoadCurve({ curve }: { curve: LoadBucket[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 720
  const H = 120
  const PAD = 4
  const max = Math.max(1, ...curve.map((b) => b.uplinks))
  const slot = W / curve.length
  const bw = Math.max(2, slot / 2 - 3)
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2)
  const hovered = hover != null ? curve[hover] : null
  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label="Uplinks and user queries per hour, last 24 hours"
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const i = Math.floor(((e.clientX - box.left) / box.width) * curve.length)
          setHover(i >= 0 && i < curve.length ? i : null)
        }}
        onMouseLeave={() => setHover(null)}
      >
        {/* recessive quarter-height gridlines */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={y(max * f)}
            y2={y(max * f)}
            stroke="rgba(255,255,255,0.06)"
          />
        ))}
        {curve.map((b, i) => (
          <g key={b.hourStartMs}>
            <rect
              x={i * slot + 1}
              y={y(b.uplinks)}
              width={bw}
              height={H - PAD - y(b.uplinks)}
              rx="2"
              fill={C_UPLINKS}
              opacity={hover == null || hover === i ? 1 : 0.45}
            />
            <rect
              x={i * slot + 1 + bw + 2}
              y={y(b.queries)}
              width={bw}
              height={H - PAD - y(b.queries)}
              rx="2"
              fill={C_QUERIES}
              opacity={hover == null || hover === i ? 1 : 0.45}
            />
          </g>
        ))}
        <line x1="0" x2={W} y1={H - PAD} y2={H - PAD} stroke="rgba(255,255,255,0.12)" />
      </svg>
      {hovered && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: `${(((hover ?? 0) + 0.5) / curve.length) * 100}%`,
            transform: 'translateX(-50%)',
            background: 'var(--panel-2)',
            border: '1px solid var(--hairline)',
            borderRadius: '6px',
            padding: '4px 8px',
            fontSize: '12px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {new Date(hovered.hourStartMs).toLocaleTimeString([], { hour: '2-digit' })} ·{' '}
          {hovered.uplinks} uplinks · {hovered.queries} queries
        </div>
      )}
      <div class="dim" style={{ display: 'flex', gap: '16px', fontSize: '12px' }}>
        <span>
          <span style={{ color: C_UPLINKS }}>■</span> uplinks
        </span>
        <span>
          <span style={{ color: C_QUERIES }}>■</span> user queries
        </span>
        <span style={{ marginInlineStart: 'auto' }}>
          {new Date(curve[0]?.hourStartMs ?? 0).toLocaleTimeString([], { hour: '2-digit' })} →{' '}
          {new Date(curve[curve.length - 1]?.hourStartMs ?? 0).toLocaleTimeString([], {
            hour: '2-digit',
          })}
        </span>
      </div>
    </div>
  )
}

/** Cost-model assumptions — editable, persisted locally. Real token metering
 * is a follow-up; until then every derived figure carries the ESTIMATE label. */
type Assumptions = {
  priceInPerM: number
  priceOutPerM: number
  researchTokIn: number
  researchTokOut: number
  interpretTokIn: number
  interpretTokOut: number
}

const DEFAULT_ASSUMPTIONS: Assumptions = {
  priceInPerM: 1, // $/1M input tokens (haiku-class default)
  priceOutPerM: 5, // $/1M output tokens
  researchTokIn: 900,
  researchTokOut: 500,
  interpretTokIn: 400,
  interpretTokOut: 120,
}

const STORE_KEY = 'hippo_admin_pilot_assumptions'

function loadAssumptions(): Assumptions {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return DEFAULT_ASSUMPTIONS
    return { ...DEFAULT_ASSUMPTIONS, ...(JSON.parse(raw) as Partial<Assumptions>) }
  } catch {
    return DEFAULT_ASSUMPTIONS
  }
}

/** Estimated LLM spend since gateway boot. Two model calls exist per the
 * two-stage flow: interpret runs on every user query; research runs only on a
 * cache miss (a hit serves the fleet from cache — that's the rate-card story). */
export function estimateCost(
  a: Assumptions,
  queries: number,
  cacheMisses: number,
): { total: number; interpret: number; research: number } {
  const interpret =
    (queries * (a.interpretTokIn * a.priceInPerM + a.interpretTokOut * a.priceOutPerM)) / 1_000_000
  const research =
    (cacheMisses * (a.researchTokIn * a.priceInPerM + a.researchTokOut * a.priceOutPerM)) /
    1_000_000
  return { total: interpret + research, interpret, research }
}

/** Measured tokens x configured prices — cost with only the price assumed. */
export function measuredCost(a: Assumptions, u: MeasuredUsage): number {
  return (u.promptTokens * a.priceInPerM + u.completionTokens * a.priceOutPerM) / 1_000_000
}

const usd = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`)

export function PilotPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [assume, setAssume] = useState<Assumptions>(loadAssumptions)

  const state = useLoad(async () => {
    setMetrics(await get<Metrics>('/v1/metrics'))
    setUpdatedAt(new Date())
  })

  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) state.retry()
    }, REFRESH_MS)
    return () => clearInterval(t)
  }, [state.retry])

  const setField = (k: keyof Assumptions) => (e: Event) => {
    const v = Number((e.target as HTMLInputElement).value)
    const next = { ...assume, [k]: Number.isFinite(v) && v >= 0 ? v : 0 }
    setAssume(next)
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next))
    } catch {
      /* private mode — assumptions just don't persist */
    }
  }

  if (state.error) return <ErrorBanner message={state.error} retry={state.retry} />
  if (state.loading && !metrics) return <Busy rows={3} />
  if (!metrics) return null

  const gw = metrics.gateway
  const intel = metrics.intelligence
  const queries = gw?.turns?.user_text ?? 0
  const mau = gw?.mau?.research_answered ?? 0
  const misses = gw?.cache?.misses ?? 0
  // Intelligence-side cache stats are authoritative (Redis-backed); the
  // gateway counter is the since-boot fallback — same rule as the Dashboard.
  const hitRate = intel?.cache ? intel.cache.hitRate : gw?.cache?.hitRate
  const cost = estimateCost(assume, queries, misses)
  const partnerRows = metrics.partnerMau ?? []
  // Measured usage wins whenever the intelligence service metered anything;
  // the assumptions estimator stays as the fallback for older deploys.
  const usage = intel?.usage
  const measured = usage && usage.promptTokens + usage.completionTokens > 0 ? usage : null

  return (
    <>
      <div class="page-head">
        <h1>Pilot</h1>
        <span class="dim">
          {gw?.mau?.month && `MAU month: ${gw.mau.month} · `}
          {updatedAt && `updated ${updatedAt.toLocaleTimeString()}`}
        </span>
      </div>
      <p class="dim">
        The rate-card numbers. MAU is durable (calendar month); every other counter is the gateway's
        in-process memory <b>since its last boot</b>.
      </p>

      <div class="cards">
        <div class="stat">
          <div class="n">{gw ? queries : '—'}</div>
          <div class="l">User queries · since boot</div>
        </div>
        <div class="stat">
          <div class="n">{gw && mau > 0 ? (queries / mau).toFixed(1) : '—'}</div>
          <div class="l">Queries / MAU</div>
        </div>
        <div class="stat">
          <div class="n">{pct(hitRate)}</div>
          <div class="l">Answer-cache hit rate</div>
        </div>
        <div class="stat">
          <div class="n">{pct(gw?.advice?.declineRate)}</div>
          <div class="l">
            Advice decline rate
            {gw?.advice
              ? ` (${gw.advice.declined}/${gw.advice.declined + gw.advice.answered})`
              : ''}
          </div>
        </div>
        <div class="stat">
          <div class="n">{gw ? mau : '—'}</div>
          <div class="l">MAU · research answered</div>
        </div>
        <div class="stat">
          <div class="n">{gw ? (gw.degraded?.seconds ?? 0) : '—'}</div>
          <div class="l">Degraded seconds</div>
        </div>
      </div>

      <h2>Load — last 24h</h2>
      {gw?.loadCurve ? (
        <LoadCurve curve={denseCurve(gw.loadCurve)} />
      ) : (
        <div class="dim">Gateway unreachable — no load data.</div>
      )}

      <h2>MAU by partner</h2>
      {partnerRows.length === 0 ? (
        <div class="dim">No partners yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Partner</th>
              <th>Status</th>
              <th>MAU</th>
              <th>Quota</th>
              <th style={{ width: '40%' }}>Utilization</th>
            </tr>
          </thead>
          <tbody>
            {partnerRows.map((p) => {
              const util = p.quota ? p.mau / p.quota : null
              return (
                <tr key={p.partnerId}>
                  <td>
                    <a href={`#/partners/${p.partnerId}`}>{p.venueName}</a>
                  </td>
                  <td>
                    <span class={`badge ${p.status}`}>{p.status}</span>
                  </td>
                  <td class="mono">{p.mau}</td>
                  <td class="mono">{p.quota ?? '—'}</td>
                  <td>
                    {util == null ? (
                      <span class="dim">no quota</span>
                    ) : (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span
                          style={{
                            flex: 1,
                            height: '6px',
                            borderRadius: '3px',
                            background: 'rgba(255,255,255,0.06)',
                            overflow: 'hidden',
                          }}
                        >
                          <span
                            style={{
                              display: 'block',
                              height: '100%',
                              width: `${Math.min(100, Math.round(util * 100))}%`,
                              background: util >= 1 ? 'var(--down)' : C_QUERIES,
                            }}
                          />
                        </span>
                        <span class="mono" style={{ minWidth: '4ch', textAlign: 'end' }}>
                          {Math.round(util * 100)}%
                        </span>
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <h2>
        Cost / MAU{' '}
        {measured ? (
          <span class="badge llm">measured tokens</span>
        ) : (
          <span class="badge none">estimate</span>
        )}
      </h2>
      {measured ? (
        <>
          <p class="dim">
            Token counts measured by the intelligence service since its boot — only the prices below
            are assumptions.
            {measured.unmetered > 0 &&
              ` ${measured.unmetered} call${measured.unmetered === 1 ? '' : 's'} returned no usage and are not counted.`}
          </p>
          <div class="cards">
            <div class="stat">
              <div class="n">{usd(measuredCost(assume, measured))}</div>
              <div class="l">LLM spend · measured</div>
            </div>
            <div class="stat">
              <div class="n">{mau > 0 ? usd(measuredCost(assume, measured) / mau) : '—'}</div>
              <div class="l">Cost / MAU</div>
            </div>
            <div class="stat">
              <div class="n">{measured.promptTokens.toLocaleString()}</div>
              <div class="l">Input tokens</div>
            </div>
            <div class="stat">
              <div class="n">{measured.completionTokens.toLocaleString()}</div>
              <div class="l">Output tokens</div>
            </div>
          </div>
          <table style={{ maxWidth: '560px' }}>
            <thead>
              <tr>
                <th>Purpose</th>
                <th>Calls</th>
                <th>Tokens in</th>
                <th>Tokens out</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(measured.byPurpose).map(([purpose, u]) => (
                <tr key={purpose}>
                  <td>{purpose}</td>
                  <td class="mono">{u.calls}</td>
                  <td class="mono">{u.promptTokens.toLocaleString()}</td>
                  <td class="mono">{u.completionTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <>
          <p class="dim">
            No measured usage yet — this model prices the two-stage flow from editable assumptions:
            interpret runs on <b>every query</b> ({queries}), research only on a <b>cache miss</b> (
            {misses}). Assumptions persist in this browser.
          </p>
          <div class="cards">
            <div class="stat">
              <div class="n">{usd(cost.total)}</div>
              <div class="l">Est. LLM spend · since boot</div>
            </div>
            <div class="stat">
              <div class="n">{mau > 0 ? usd(cost.total / mau) : '—'}</div>
              <div class="l">Est. cost / MAU</div>
            </div>
            <div class="stat">
              <div class="n">{usd(cost.interpret)}</div>
              <div class="l">↳ interpret calls</div>
            </div>
            <div class="stat">
              <div class="n">{usd(cost.research)}</div>
              <div class="l">↳ research calls (misses)</div>
            </div>
          </div>
        </>
      )}
      <table style={{ maxWidth: '560px' }}>
        <tbody>
          {(measured
            ? ([
                ['priceInPerM', '$ / 1M input tokens'],
                ['priceOutPerM', '$ / 1M output tokens'],
              ] as Array<[keyof Assumptions, string]>)
            : ([
                ['priceInPerM', '$ / 1M input tokens'],
                ['priceOutPerM', '$ / 1M output tokens'],
                ['interpretTokIn', 'Interpret · input tok/call'],
                ['interpretTokOut', 'Interpret · output tok/call'],
                ['researchTokIn', 'Research · input tok/call'],
                ['researchTokOut', 'Research · output tok/call'],
              ] as Array<[keyof Assumptions, string]>)
          ).map(([k, label]) => (
            <tr key={k}>
              <td>{label}</td>
              <td>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={assume[k]}
                  onInput={setField(k)}
                  style={{ width: '10ch' }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
