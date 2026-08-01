/**
 * Durable price alerts (migration 017) — the rows behind "alert me when BTC
 * crosses 70k". Rows are keyed by the session's effective user key at creation
 * time (`id:<username_lower>` when an in-panel identity is active, else the
 * host-minted sub / anonymous session id), so alerts travel with the person
 * like memory does. State machine is one-way: armed → triggered (the poll
 * loop) or armed → cancelled (the trader); `delivered` records whether the
 * triggered frame ever reached a live session — the session-start sweep
 * delivers the rest.
 */
import type pg from 'pg'

export type AlertCondition = 'above' | 'below'
export type AlertState = 'armed' | 'triggered' | 'cancelled'

export type Alert = {
  id: string
  partnerId: string
  /** Effective per-user key at creation time (identity-aware, like memory). */
  userKey: string
  /** "BTC/USDT" */
  symbol: string
  /** Resolved boundary — "crosses" is resolved against the live price BEFORE
   * the row exists, so the store never carries an ambiguous condition. */
  condition: AlertCondition
  price: number
  state: AlertState
  createdAt: number
  /** Set when state flips to 'triggered'. */
  triggeredAt?: number
  /** The triggered frame reached a live session (or the session-start sweep). */
  delivered: boolean
}

/** Hard per-user cap on ARMED alerts — creation beyond it fails honestly. */
export const MAX_ARMED_ALERTS_PER_USER = 10

/** The list API's bound — a per-user view, not an export surface. */
export const ALERTS_LIST_CAP = 50

export interface AlertStore {
  /** Arm a new alert. 'capped' when the user already holds the armed cap —
   * the row is NOT inserted; the caller declines honestly. */
  create(alert: Alert): Promise<'ok' | 'capped'>
  /** Cancel an ARMED alert the (partnerId, userKey) owner holds. Returns the
   * cancelled row on the armed→cancelled flip; null for anything else
   * (unknown id, foreign owner, already triggered/cancelled) — a no-op, never
   * an error, so cancel is idempotent by construction. */
  cancel(id: string, partnerId: string, userKey: string): Promise<Alert | null>
  /** Every armed alert across all users — the poll loop's working set. */
  listArmed(): Promise<Alert[]>
  /** One user's alerts, newest first, bounded (default ALERTS_LIST_CAP). */
  listByUser(partnerId: string, userKey: string, limit?: number): Promise<Alert[]>
  /** armed → triggered. Returns false when the alert wasn't armed (already
   * triggered/cancelled, or unknown) — the caller must not emit twice. */
  markTriggered(id: string, triggeredAt?: number): Promise<boolean>
  /** The triggered frame reached the trader — don't re-deliver on next start. */
  markDelivered(id: string): Promise<void>
}

export class InMemoryAlertStore implements AlertStore {
  private alerts = new Map<string, Alert>()

  private armedCount(partnerId: string, userKey: string): number {
    let n = 0
    for (const a of this.alerts.values()) {
      if (a.partnerId === partnerId && a.userKey === userKey && a.state === 'armed') n++
    }
    return n
  }

  async create(alert: Alert): Promise<'ok' | 'capped'> {
    if (this.armedCount(alert.partnerId, alert.userKey) >= MAX_ARMED_ALERTS_PER_USER) {
      return 'capped'
    }
    this.alerts.set(alert.id, { ...alert })
    return 'ok'
  }

  async cancel(id: string, partnerId: string, userKey: string): Promise<Alert | null> {
    const alert = this.alerts.get(id)
    if (
      !alert ||
      alert.partnerId !== partnerId ||
      alert.userKey !== userKey ||
      alert.state !== 'armed'
    ) {
      return null
    }
    alert.state = 'cancelled'
    return { ...alert }
  }

  async listArmed(): Promise<Alert[]> {
    return [...this.alerts.values()].filter((a) => a.state === 'armed').map((a) => ({ ...a }))
  }

  async listByUser(partnerId: string, userKey: string, limit = ALERTS_LIST_CAP): Promise<Alert[]> {
    return [...this.alerts.values()]
      .filter((a) => a.partnerId === partnerId && a.userKey === userKey)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((a) => ({ ...a }))
  }

  async markTriggered(id: string, triggeredAt = Date.now()): Promise<boolean> {
    const alert = this.alerts.get(id)
    if (alert?.state !== 'armed') return false
    alert.state = 'triggered'
    alert.triggeredAt = triggeredAt
    return true
  }

  async markDelivered(id: string): Promise<void> {
    const alert = this.alerts.get(id)
    if (alert) alert.delivered = true
  }
}

function rowToAlert(r: Record<string, unknown>): Alert {
  return {
    id: r.id as string,
    partnerId: r.partner_id as string,
    userKey: r.user_key as string,
    symbol: r.symbol as string,
    condition: r.condition as AlertCondition,
    price: Number(r.price),
    state: r.state as AlertState,
    createdAt: Number(r.created_at),
    ...(r.triggered_at != null ? { triggeredAt: Number(r.triggered_at) } : {}),
    delivered: Boolean(r.delivered),
  }
}

export class PostgresAlertStore implements AlertStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(alert: Alert): Promise<'ok' | 'capped'> {
    // Cap check + insert in ONE statement, so two racing creates can't both
    // slip under the ceiling by reading a stale count.
    const res = await this.pool.query(
      `INSERT INTO alerts
         (id, partner_id, user_key, symbol, condition, price, state, created_at, triggered_at, delivered)
       SELECT $1, $2, $3, $4, $5, $6, 'armed', $7, NULL, false
       WHERE (SELECT count(*) FROM alerts
              WHERE partner_id = $2 AND user_key = $3 AND state = 'armed') < $8
       ON CONFLICT (id) DO NOTHING`,
      [
        alert.id,
        alert.partnerId,
        alert.userKey,
        alert.symbol,
        alert.condition,
        alert.price,
        alert.createdAt,
        MAX_ARMED_ALERTS_PER_USER,
      ],
    )
    return (res.rowCount ?? 0) > 0 ? 'ok' : 'capped'
  }

  async cancel(id: string, partnerId: string, userKey: string): Promise<Alert | null> {
    const res = await this.pool.query(
      `UPDATE alerts SET state = 'cancelled'
       WHERE id = $1 AND partner_id = $2 AND user_key = $3 AND state = 'armed'
       RETURNING *`,
      [id, partnerId, userKey],
    )
    const row = res.rows[0]
    return row ? rowToAlert(row) : null
  }

  async listArmed(): Promise<Alert[]> {
    const res = await this.pool.query(`SELECT * FROM alerts WHERE state = 'armed'`)
    return res.rows.map(rowToAlert)
  }

  async listByUser(partnerId: string, userKey: string, limit = ALERTS_LIST_CAP): Promise<Alert[]> {
    const res = await this.pool.query(
      `SELECT * FROM alerts
       WHERE partner_id = $1 AND user_key = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [partnerId, userKey, limit],
    )
    return res.rows.map(rowToAlert)
  }

  async markTriggered(id: string, triggeredAt = Date.now()): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE alerts SET state = 'triggered', triggered_at = $2
       WHERE id = $1 AND state = 'armed'`,
      [id, triggeredAt],
    )
    return (res.rowCount ?? 0) > 0
  }

  async markDelivered(id: string): Promise<void> {
    await this.pool.query(`UPDATE alerts SET delivered = true WHERE id = $1`, [id])
  }
}
