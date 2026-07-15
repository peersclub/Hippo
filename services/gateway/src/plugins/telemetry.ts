/**
 * In-memory telemetry counters.
 *
 * In regional pods this module is replaced by OTel metrics + the Postgres
 * `telemetry_events` table (BE doc §4/§7); the JSON returned by
 * GET /internal/metrics mirrors the metric names we register there so
 * dashboards port over unchanged.
 *
 * MAU events (the billable unit): `research_answered` counts the FIRST
 * research brief per user per calendar month; `order_executed` counts the
 * first filled lifecycle. Distinctness is enforced with `${user}:${YYYY-MM}`
 * keys — a user key is the venue_user_id when the session is JWT-bound, else
 * the session id (anonymous dev sessions).
 */

function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7) // "2026-07"
}

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

  recordTurn(kind: string): void {
    this.turns[kind] = (this.turns[kind] ?? 0) + 1
  }

  recordIntent(intent: string): void {
    this.intents[intent] = (this.intents[intent] ?? 0) + 1
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
