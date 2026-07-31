/**
 * Operator diagnostics — the in-memory truth behind GET /internal/telemetry
 * (the admin panel's "Tech" page). Deliberately separate from
 * plugins/telemetry.ts: that class feeds the rate-card OTel instruments and
 * MAU/quota enforcement; this one is a bounded, restart-ephemeral window of
 * "what is this gateway process doing right now" — latency percentiles, a
 * call log, live load gauges. Everything here is a ring buffer or rolling
 * counter; nothing is durable and nothing aggregates ahead of time
 * (percentiles are recomputed on every read).
 *
 * All record hooks are fire-and-forget and O(1) — they sit on the turn path
 * and must never slow or break it.
 */

/** Rolling window of per-turn latencies (oldest evicted beyond this). */
const TURN_WINDOW = 500

/** Call-log ring capacity (oldest evicted beyond this). */
const CALL_LOG_CAP = 100

/** Rolling window for the uplinks-per-minute counter. */
const UPLINK_WINDOW_MS = 60_000

/** How a downstream call is classified in the call log. `upload` is reserved
 * for the identity/upload flow — no gateway call path classifies as it yet. */
export type CallKind = 'interpret' | 'research' | 'order' | 'memory-write' | 'upload' | 'other'

export type CallLogEntry = { ts: number; kind: CallKind; durationMs: number; ok: boolean }

export type DiagnosticsSnapshot = {
  /** Process boot — everything below resets when this changes. */
  bootAt: number
  turns: {
    window: number
    count: number
    totalMs: { p50: number | null; p95: number | null }
    firstTokenMs: { count: number; p50: number | null; p95: number | null }
  }
  /** Newest first, at most CALL_LOG_CAP entries. */
  calls: CallLogEntry[]
  load: { liveSessions: number; sseConnections: number; uplinksLastMinute: number }
}

/** Nearest-rank percentile over an UNSORTED sample; null on an empty one.
 * Copies + sorts on every call — recompute-on-read by design. */
export function percentile(sample: number[], p: number): number | null {
  if (sample.length === 0) return null
  const sorted = [...sample].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank] ?? null
}

export class Diagnostics {
  private readonly bootAt = Date.now()
  /** Rolling windows of raw samples — percentiles are computed on read. */
  private turnMs: number[] = []
  private firstTokenMs: number[] = []
  private calls: CallLogEntry[] = []
  /** Timestamps of uplinks within the rolling 60s window. */
  private uplinkTs: number[] = []
  private sseConnections = 0

  /** Total turn latency: uplink received → all frames for the turn emitted. */
  recordTurn(durationMs: number): void {
    this.turnMs.push(durationMs)
    if (this.turnMs.length > TURN_WINDOW) this.turnMs.shift()
  }

  /** First-token latency: user turn → first streamed brief content. */
  recordFirstToken(durationMs: number): void {
    this.firstTokenMs.push(durationMs)
    if (this.firstTokenMs.length > TURN_WINDOW) this.firstTokenMs.shift()
  }

  recordCall(kind: CallKind, durationMs: number, ok: boolean): void {
    this.calls.push({ ts: Date.now(), kind, durationMs, ok })
    if (this.calls.length > CALL_LOG_CAP) this.calls.shift()
  }

  recordUplink(now = Date.now()): void {
    this.pruneUplinks(now)
    this.uplinkTs.push(now)
  }

  uplinksLastMinute(now = Date.now()): number {
    this.pruneUplinks(now)
    return this.uplinkTs.length
  }

  private pruneUplinks(now: number): void {
    const cutoff = now - UPLINK_WINDOW_MS
    // Timestamps are appended in order — drop the expired prefix.
    let drop = 0
    while (drop < this.uplinkTs.length && (this.uplinkTs[drop] ?? now) <= cutoff) drop += 1
    if (drop > 0) this.uplinkTs.splice(0, drop)
  }

  sseOpened(): void {
    this.sseConnections += 1
  }

  sseClosed(): void {
    this.sseConnections = Math.max(0, this.sseConnections - 1)
  }

  /** `liveSessions` comes from the session store (the caller owns it). */
  snapshot(liveSessions: number): DiagnosticsSnapshot {
    return {
      bootAt: this.bootAt,
      turns: {
        window: TURN_WINDOW,
        count: this.turnMs.length,
        totalMs: { p50: percentile(this.turnMs, 50), p95: percentile(this.turnMs, 95) },
        firstTokenMs: {
          count: this.firstTokenMs.length,
          p50: percentile(this.firstTokenMs, 50),
          p95: percentile(this.firstTokenMs, 95),
        },
      },
      calls: [...this.calls].reverse(),
      load: {
        liveSessions,
        sseConnections: this.sseConnections,
        uplinksLastMinute: this.uplinksLastMinute(),
      },
    }
  }
}

// ── downstream-client instrumentation ───────────────────────────────────────

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function isAsyncIterable(value: unknown): value is AsyncGenerator<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  )
}

/** Wrap an async generator so completion (done/early-return = ok, throw =
 * fail) lands one call-log entry. An early `return()` (stream_stop) counts as
 * ok — the trader stopped it, the upstream call itself was healthy. */
function instrumentGenerator<E>(
  gen: AsyncGenerator<E>,
  done: (ok: boolean, durationMs: number) => void,
  start: number,
): AsyncGenerator<E> {
  return (async function* wrapped() {
    let settled = false
    try {
      yield* gen
      settled = true
      done(true, Date.now() - start)
    } catch (err) {
      settled = true
      done(false, Date.now() - start)
      throw err
    } finally {
      if (!settled) done(true, Date.now() - start)
    }
  })()
}

/**
 * Instrument a downstream client (intelligence / memory / seam) so every
 * method call lands a { kind, durationMs, ok } entry in the diagnostics call
 * log. Purely additive: methods are bound to the original client and behave
 * byte-identically — same values, same rejections, same generator protocol —
 * so the orchestrator (and the tests' call-recording stubs) never notice.
 * Methods absent from `kinds` classify as 'other'.
 */
export function instrumentClient<T extends object>(
  client: T,
  diagnostics: Diagnostics,
  kinds: Partial<Record<keyof T & string, CallKind>>,
): T {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(client) as Array<keyof T & string>) {
    const value = client[key]
    if (typeof value !== 'function') {
      out[key] = value
      continue
    }
    const kind: CallKind = kinds[key] ?? 'other'
    const fn = (value as (...args: unknown[]) => unknown).bind(client)
    out[key] = (...args: unknown[]) => {
      const start = Date.now()
      let result: unknown
      try {
        result = fn(...args)
      } catch (err) {
        diagnostics.recordCall(kind, Date.now() - start, false)
        throw err
      }
      if (isPromise(result)) {
        return result.then(
          (v) => {
            diagnostics.recordCall(kind, Date.now() - start, true)
            return v
          },
          (err) => {
            diagnostics.recordCall(kind, Date.now() - start, false)
            throw err
          },
        )
      }
      if (isAsyncIterable(result)) {
        return instrumentGenerator(
          result as AsyncGenerator<unknown>,
          (ok, durationMs) => diagnostics.recordCall(kind, durationMs, ok),
          start,
        )
      }
      diagnostics.recordCall(kind, Date.now() - start, true)
      return result
    }
  }
  return out as T
}
