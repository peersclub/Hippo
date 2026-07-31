import { useEffect, useState } from 'preact/hooks'
import { get } from '../api.js'
import { Busy, Empty, ErrorBanner, useLoad } from '../ui.js'

type CallKind = 'interpret' | 'research' | 'order' | 'memory-write' | 'upload' | 'other'

type Telemetry = {
  gateway: {
    bootAt: number
    turns: {
      window: number
      count: number
      totalMs: { p50: number | null; p95: number | null }
      firstTokenMs: { count: number; p50: number | null; p95: number | null }
    }
    calls: Array<{ ts: number; kind: CallKind; durationMs: number; ok: boolean }>
    load: { liveSessions: number; sseConnections: number; uplinksLastMinute: number }
    degraded: { active: boolean; seconds: number }
    config: { sessionsBackend: 'redis' | 'memory'; devMode: boolean; intelligenceUrl: string }
  } | null
  intelligence: { mode: string; model: string } | null
}

/** Live-truth cadence: this page is a diagnostics scope, not a dashboard. */
const REFRESH_MS = 5_000

const ms = (v: number | null) => (v == null ? '—' : `${Math.round(v)} ms`)
const time = (ts: number) => new Date(ts).toLocaleTimeString()

/** Operator-grade gateway diagnostics: latency percentiles, downstream call
 * log, live load, degraded clock. Everything shown here is the gateway's
 * in-process memory — it resets whenever the gateway restarts. */
export function TechPage() {
  const [data, setData] = useState<Telemetry | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const state = useLoad(async () => {
    setData(await get<Telemetry>('/v1/tech/telemetry'))
    setUpdatedAt(new Date())
  })

  // Tight auto-refresh, but only while the tab is actually visible — a hidden
  // panel must not keep hammering the gateway. Timer cleared on unmount.
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) state.retry()
    }, REFRESH_MS)
    return () => clearInterval(t)
  }, [state.retry])

  if (state.error) return <ErrorBanner message={state.error} retry={state.retry} />
  if (state.loading && !data) return <Busy rows={3} />
  if (!data) return null

  const gw = data.gateway
  const intel = data.intelligence

  return (
    <>
      <div class="page-head">
        <h1>Tech</h1>
        <span class="dim">
          {gw && `gateway up since ${new Date(gw.bootAt).toLocaleString()} · `}
          {updatedAt && `updated ${updatedAt.toLocaleTimeString()} · refreshes every 5s`}
        </span>
      </div>

      <p class="dim">
        In-memory telemetry from the live gateway process — rolling windows (last{' '}
        {gw ? gw.turns.window : 500} turns, last 100 calls), recomputed on every read. All of it
        resets when the gateway restarts.
      </p>

      {!gw && (
        <ErrorBanner
          message="Gateway unreachable — no live diagnostics right now."
          retry={state.retry}
        />
      )}

      {gw && (
        <div class="cards">
          <div class="stat">
            <div class="n">{ms(gw.turns.firstTokenMs.p50)}</div>
            <div class="l">First token · p50</div>
          </div>
          <div class="stat">
            <div class="n">{ms(gw.turns.firstTokenMs.p95)}</div>
            <div class="l">First token · p95</div>
          </div>
          <div class="stat">
            <div class="n">{ms(gw.turns.totalMs.p50)}</div>
            <div class="l">Turn latency · p50</div>
          </div>
          <div class="stat">
            <div class="n">{ms(gw.turns.totalMs.p95)}</div>
            <div class="l">Turn latency · p95</div>
          </div>
          <div class="stat">
            <div class="n">{gw.load.liveSessions}</div>
            <div class="l">Live sessions</div>
          </div>
          <div class="stat">
            <div class="n">{gw.load.sseConnections}</div>
            <div class="l">Open SSE connections</div>
          </div>
          <div class="stat">
            <div class="n">{gw.load.uplinksLastMinute}</div>
            <div class="l">Uplinks / min</div>
          </div>
          <div class="stat">
            <div class="n">
              {gw.degraded.seconds}
              {gw.degraded.active && <span class="badge suspended">now</span>}
            </div>
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
            <div class="l">LLM mode</div>
          </div>
          <div class="stat">
            <div class="n text">
              {gw.config.sessionsBackend}
              {gw.config.devMode && <span class="badge sandbox">dev mode</span>}
            </div>
            <div class="l">Sessions backend</div>
          </div>
        </div>
      )}
      {gw && gw.turns.count === 0 && (
        <div class="dim">
          No turns recorded since the gateway booted — latency percentiles fill in as traffic
          arrives.
        </div>
      )}
      {!intel && <div class="dim">Intelligence service unreachable — LLM mode unknown.</div>}

      {gw && (
        <>
          <div class="page-head">
            <h1>Call log</h1>
            <span class="dim">last {gw.calls.length} downstream calls, newest first</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Kind</th>
                <th>Duration</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {gw.calls.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <Empty
                      title="No downstream calls since the gateway booted."
                      hint="Rows appear as turns hit intelligence, memory and the venue seam."
                    />
                  </td>
                </tr>
              )}
              {gw.calls.map((c) => (
                <tr key={`${c.ts}-${c.kind}-${c.durationMs}`}>
                  <td class="mono dim">{time(c.ts)}</td>
                  <td>
                    <span class="badge plan">{c.kind}</span>
                  </td>
                  <td class="mono">{ms(c.durationMs)}</td>
                  <td>
                    <span class={`badge ${c.ok ? 'active' : 'blocked'}`}>
                      {c.ok ? 'ok' : 'fail'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}
