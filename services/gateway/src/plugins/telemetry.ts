/**
 * Telemetry: in-memory counters (GET /internal/metrics) PLUS OpenTelemetry
 * metrics/spans for the pilot rate-card numbers.
 *
 * In regional pods the counters here are backed by OTel metrics + the Postgres
 * `telemetry_events` table (BE doc §4/§7); the JSON returned by
 * GET /internal/metrics mirrors the metric names we register there so
 * dashboards port over unchanged. The four instruments the rate card depends
 * on are emitted through the OTel API (no-op until a MeterProvider is
 * registered, so local dev + tests need no collector):
 *   - hippo.intent.classification.duration  (histogram, ms)  → intent p95
 *   - hippo.first_token.duration            (histogram, ms)  → first-token p95
 *   - hippo.answer_cache.requests           (counter, {result}) → hit rate
 *   - hippo.advice.turns                    (counter, {outcome}) → decline rate
 *
 * MAU events (the billable unit): `research_answered` counts the FIRST
 * research brief per user per calendar month; `order_executed` counts the
 * first filled lifecycle. Distinctness is enforced with `${user}:${YYYY-MM}`
 * keys — a user key is the venue_user_id when the session is JWT-bound, else
 * the session id (anonymous dev sessions).
 */
import {
  type Counter,
  type Histogram,
  type Meter,
  metrics,
  type Span,
  type Tracer,
  trace,
} from '@opentelemetry/api'

const INSTRUMENTATION_NAME = '@hippo/gateway'

function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7) // "2026-07"
}

/** Optional OTel handles — defaults to the global API (no-op with no provider,
 * so the existing tests and local dev are unaffected). Tests inject their own
 * meter/tracer wired to an in-memory exporter. */
export type TelemetryOtel = { meter?: Meter; tracer?: Tracer }

export class Telemetry {
  private turns: Record<string, number> = {}
  private intents: Record<string, number> = {}
  private uplinks: Record<string, number> = {}
  private researchMau = new Set<string>()
  private orderMau = new Set<string>()
  private cacheHits = 0
  private cacheMisses = 0
  private degradedSince: number | null = null
  private degradedMsTotal = 0

  private readonly tracer: Tracer
  private readonly intentDuration: Histogram
  private readonly firstTokenDuration: Histogram
  private readonly cacheRequests: Counter
  private readonly adviceTurns: Counter
  private readonly intentClassifications: Counter

  constructor(otel: TelemetryOtel = {}) {
    const meter = otel.meter ?? metrics.getMeter(INSTRUMENTATION_NAME)
    this.tracer = otel.tracer ?? trace.getTracer(INSTRUMENTATION_NAME)
    this.intentDuration = meter.createHistogram('hippo.intent.classification.duration', {
      description: 'Intent classification latency (p95 underwrites the pilot SLA)',
      unit: 'ms',
    })
    this.firstTokenDuration = meter.createHistogram('hippo.first_token.duration', {
      description: 'Time from turn start to the first streamed brief token',
      unit: 'ms',
    })
    this.cacheRequests = meter.createCounter('hippo.answer_cache.requests', {
      description: 'Answer-cache lookups by result — hit rate underwrites the rate card',
    })
    this.adviceTurns = meter.createCounter('hippo.advice.turns', {
      description: 'Advice-intent turns by outcome — decline rate',
    })
    this.intentClassifications = meter.createCounter('hippo.intent.classifications', {
      description: 'Intent classifications by resolved intent',
    })
  }

  recordTurn(kind: string): void {
    this.turns[kind] = (this.turns[kind] ?? 0) + 1
  }

  /** Records the resolved intent; `durationMs` (when the caller timed the
   * classification) feeds the intent-p95 histogram. */
  recordIntent(intent: string, durationMs?: number): void {
    this.intents[intent] = (this.intents[intent] ?? 0) + 1
    this.intentClassifications.add(1, { intent })
    if (durationMs !== undefined) this.intentDuration.record(durationMs, { intent })
  }

  /** First-token latency for a streamed research brief (the < 2s budget). */
  recordFirstToken(durationMs: number, intent: string): void {
    this.firstTokenDuration.record(durationMs, { intent })
  }

  /** Advice-turn outcome — the decline rate the compliance story rests on. */
  recordAdvice(declined: boolean): void {
    this.adviceTurns.add(1, { outcome: declined ? 'declined' : 'answered' })
  }

  /** Start a turn span; caller sets attributes and ends it. No-op tracer when
   * no provider is registered. */
  startSpan(name: string, attributes: Record<string, string | number | boolean> = {}): Span {
    return this.tracer.startSpan(name, { attributes })
  }

  recordUplink(kind: string): void {
    this.uplinks[kind] = (this.uplinks[kind] ?? 0) + 1
  }

  recordResearchAnswered(userKey: string): void {
    this.researchMau.add(`${userKey}:${monthKey()}`)
  }

  recordOrderExecuted(userKey: string): void {
    this.orderMau.add(`${userKey}:${monthKey()}`)
  }

  /** Cache-hit passthrough from the intelligence service's `cached` flag —
   * hit rate is a first-class metric; it underwrites the rate card (§5). */
  recordCache(hit: boolean): void {
    if (hit) this.cacheHits += 1
    else this.cacheMisses += 1
    this.cacheRequests.add(1, { result: hit ? 'hit' : 'miss' })
  }

  /** Degraded-mode clock: starts on the first intelligence failure, stops on
   * the next success. Total seconds feed the SLA report. */
  markDegraded(): void {
    if (this.degradedSince === null) this.degradedSince = Date.now()
  }

  markHealthy(): void {
    if (this.degradedSince !== null) {
      this.degradedMsTotal += Date.now() - this.degradedSince
      this.degradedSince = null
    }
  }

  snapshot(): Record<string, unknown> {
    const month = monthKey()
    const countMonth = (set: Set<string>) => [...set].filter((k) => k.endsWith(`:${month}`)).length
    const cacheTotal = this.cacheHits + this.cacheMisses
    const liveDegradedMs = this.degradedSince === null ? 0 : Date.now() - this.degradedSince
    return {
      turns: this.turns,
      intents: this.intents,
      uplinks: this.uplinks,
      mau: {
        month,
        research_answered: countMonth(this.researchMau),
        order_executed: countMonth(this.orderMau),
      },
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate: cacheTotal === 0 ? null : this.cacheHits / cacheTotal,
      },
      degraded: {
        active: this.degradedSince !== null,
        seconds: Math.round((this.degradedMsTotal + liveDegradedMs) / 1000),
      },
    }
  }
}
