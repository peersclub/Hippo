/**
 * Price alerts engine — the durable, cross-session half of "alert me when BTC
 * crosses 70k".
 *
 * One unref'd interval (ALERT_POLL_MS, default 15s) polls market-data once per
 * DISTINCT symbol across all armed alerts and flips crossed alerts to
 * 'triggered' (above: last ≥ target; below: last ≤ target). The store flip is
 * the double-trigger guard: only the caller that wins armed→triggered emits.
 *
 * Delivery is the feature's soul: a trigger lands in every LIVE session owned
 * by the alert's (partnerId, userKey) — identity-aware via userKey(), so a
 * signed-in trader gets it on every open tab. No live session → the row stays
 * delivered=false and the SESSION-START sweep (sweepOnConnect, called from the
 * orchestrator's stream-connect path) delivers it then. A trader who closed
 * the tab still gets told.
 *
 * Creation/cancel are conversational (no wire uplink for create; alert_action
 * only carries cancel) — arm/cancelById/cancelConversational are the
 * orchestrator's wiring surface, kept here so every alert rule (cap, cross
 * resolution, ownership, server-authored conditionLabel) lives in one module.
 */
import { randomUUID } from 'node:crypto'
import { type Alert, type AlertStore, MAX_ARMED_ALERTS_PER_USER } from '@hippo/stores'
import { userKey } from './orchestrator/index.js'
import type { AlertIntent } from './orchestrator/intelligence.js'
import { formatPrice, type MarketClient, normalizeSymbol } from './orchestrator/market.js'
import type { Session, SessionStore } from './plugins/auth.js'
import type { EmitFrame } from './plugins/sse.js'

const DEFAULT_POLL_MS = 15_000

type Log = {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
}

export type AlertsEngineDeps = {
  store: AlertStore
  market: MarketClient
  /** The gateway's session store — live-session enumeration for delivery
   * (list() summaries → get() live objects, exactly how /internal/sessions
   * reads the same inventory). */
  sessions: SessionStore
  emit: EmitFrame
  log: Log
  /** Poll cadence override (tests). Defaults to ALERT_POLL_MS ?? 15s. */
  pollMs?: number
  /** Clock override (tests) — stamps createdAt/triggeredAt/tsIso. */
  now?: () => number
}

export type AlertsEngine = {
  /** Start the poll loop (unref'd — never holds the process open). */
  start(): void
  stop(): void
  /** One poll pass. Exposed so tests drive time explicitly. */
  tick(): Promise<void>
  /** Session (re)connected: deliver undelivered TRIGGERED alerts for its
   * effective user, then mark them delivered. Best-effort — never throws. */
  sweepOnConnect(session: Session): Promise<void>
  /** Conversational create. Resolves 'cross' against the live price, enforces
   * the armed cap honestly, emits the `armed` alert frame. */
  arm(session: Session, intent: AlertIntent): Promise<void>
  /** alert_action cancel. Ownership-checked; a non-armed/unknown/foreign
   * alertId is a silent no-op ack — never a crash. */
  cancelById(session: Session, alertId: string): Promise<void>
  /** "cancel my btc alert": exactly one armed match → cancel it; several →
   * re-emit their cards (each with a CANCEL chip) plus an explanatory line. */
  cancelConversational(session: Session, symbol?: string): Promise<void>
}

/** SERVER-authored display condition, e.g. "BTC/USDT ABOVE 70,000". The SDK
 * renders it verbatim — it never re-formats or recomputes a condition. */
export function conditionLabel(
  symbol: string,
  condition: 'above' | 'below',
  price: number,
): string {
  return `${symbol} ${condition.toUpperCase()} ${formatPrice(price)}`
}

function alertFrame(
  alert: Alert,
  state: 'armed' | 'triggered' | 'cancelled',
  extra: { note?: string; tsIso?: string } = {},
) {
  return {
    type: 'alert',
    alertId: alert.id,
    symbol: alert.symbol,
    conditionLabel: conditionLabel(alert.symbol, alert.condition, alert.price),
    state,
    ...(extra.note ? { note: extra.note } : {}),
    ...(extra.tsIso ? { tsIso: extra.tsIso } : {}),
  }
}

export function createAlertsEngine(deps: AlertsEngineDeps): AlertsEngine {
  const { store, market, sessions, emit, log } = deps
  const pollMs = deps.pollMs ?? Number(process.env.ALERT_POLL_MS ?? DEFAULT_POLL_MS)
  const now = deps.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | null = null

  /** Every LIVE (connected, unexpired) session owned by (partnerId, userKey).
   * Enumerates the session store the same way /internal/sessions does, then
   * resolves summaries to live objects — the identity-aware effective key
   * lives on the Session, not the summary. */
  function liveSessionsFor(partnerId: string, key: string): Session[] {
    const out: Session[] = []
    for (const summary of sessions.list()) {
      if (summary.partnerId !== partnerId || !summary.connected) continue
      const session = sessions.get(summary.id)
      if (session && userKey(session) === key) out.push(session)
    }
    return out
  }

  /** Emit the triggered frame into every live owner session's journal (SSE
   * delivers it, resume replays it). Returns true when at least one session
   * received it — only then is the alert marked delivered. */
  async function deliverTriggered(alert: Alert, observed: number): Promise<void> {
    const tsIso = new Date(now()).toISOString()
    const note = `Triggered at ${formatPrice(observed)}`
    const owners = liveSessionsFor(alert.partnerId, alert.userKey)
    for (const session of owners) {
      emit(session, alertFrame(alert, 'triggered', { note, tsIso }))
    }
    if (owners.length > 0) await store.markDelivered(alert.id)
  }

  async function tick(): Promise<void> {
    const armed = await store.listArmed()
    if (armed.length === 0) return
    // One snapshot per DISTINCT symbol per tick — a failed fetch skips the
    // symbol this beat (never a fake price, never a spurious trigger).
    const symbols = [...new Set(armed.map((a) => a.symbol))]
    const prices = new Map<string, number>()
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          prices.set(symbol, (await market.snapshot(symbol)).last)
        } catch (err) {
          log.warn({ err, symbol }, 'alert poll: market snapshot failed — skipping symbol')
        }
      }),
    )
    for (const alert of armed) {
      const last = prices.get(alert.symbol)
      if (last === undefined) continue
      const crossed = alert.condition === 'above' ? last >= alert.price : last <= alert.price
      if (!crossed) continue
      // The armed→triggered flip is the idempotency gate: a raced tick (or a
      // second pod) loses the flip and must not emit a second frame.
      const flipped = await store.markTriggered(alert.id, now())
      if (!flipped) continue
      log.info({ alertId: alert.id, symbol: alert.symbol, last }, 'price alert triggered')
      await deliverTriggered(alert, last)
    }
  }

  async function sweepOnConnect(session: Session): Promise<void> {
    try {
      const mine = await store.listByUser(session.partner.partnerId, userKey(session))
      const pending = mine.filter((a) => a.state === 'triggered' && !a.delivered)
      for (const alert of pending) {
        const tsIso = alert.triggeredAt ? new Date(alert.triggeredAt).toISOString() : undefined
        emit(
          session,
          alertFrame(alert, 'triggered', {
            note: 'Triggered while you were away',
            ...(tsIso ? { tsIso } : {}),
          }),
        )
        await store.markDelivered(alert.id)
      }
    } catch (err) {
      // Best-effort by contract: the sweep must never break a stream connect.
      log.warn({ err }, 'alert sweep on connect failed')
    }
  }

  async function arm(session: Session, intent: AlertIntent): Promise<void> {
    // The intent payload crosses a service boundary — validate defensively.
    const symbol = normalizeSymbol(intent.symbol)
    const price = intent.price
    const direction = intent.direction
    if (
      !symbol ||
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price <= 0 ||
      (direction !== 'above' && direction !== 'below' && direction !== 'cross')
    ) {
      emit(session, {
        type: 'banner',
        kind: 'info',
        title: 'Alert not set',
        text: 'Tell me the level and the asset — like "alert me when BTC goes above 70,000".',
      })
      return
    }

    // "crosses"/"hits" resolve against the LIVE price: target above the
    // current price watches upward, otherwise downward. No price feed → an
    // honest decline, never a guessed direction.
    let condition: 'above' | 'below'
    if (direction === 'cross') {
      let last: number
      try {
        last = (await market.snapshot(symbol)).last
      } catch (err) {
        log.warn({ err, symbol }, 'alert arm: snapshot unavailable for cross resolution')
        emit(session, {
          type: 'rejection_ticket',
          title: 'Alert not set',
          reason: `The live price feed for ${symbol} isn't answering right now, so I can't tell which side of ${formatPrice(price)} you're on. Nothing was armed — try again in a moment.`,
        })
        return
      }
      condition = price > last ? 'above' : 'below'
    } else {
      condition = direction
    }

    const alert: Alert = {
      id: `al_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      partnerId: session.partner.partnerId,
      userKey: userKey(session),
      symbol,
      condition,
      price,
      state: 'armed',
      createdAt: now(),
      delivered: false,
    }
    const created = await store.create(alert)
    if (created === 'capped') {
      emit(session, {
        type: 'rejection_ticket',
        title: 'Alert not set',
        reason: `You already have ${MAX_ARMED_ALERTS_PER_USER} armed alerts — the ceiling. Cancel one first, then set this one.`,
      })
      return
    }
    emit(session, alertFrame(alert, 'armed', { tsIso: new Date(alert.createdAt).toISOString() }))
  }

  async function cancelById(session: Session, alertId: string): Promise<void> {
    const cancelled = await store.cancel(alertId, session.partner.partnerId, userKey(session))
    // Unknown / foreign / already terminal → idempotent no-op ack: the card
    // (if any) already shows its terminal state; nothing to add, never a crash.
    if (!cancelled) return
    emit(session, alertFrame(cancelled, 'cancelled', { tsIso: new Date(now()).toISOString() }))
  }

  async function cancelConversational(session: Session, symbol?: string): Promise<void> {
    const wanted = normalizeSymbol(symbol)
    const mine = await store.listByUser(session.partner.partnerId, userKey(session))
    const armed = mine.filter((a) => a.state === 'armed' && (!wanted || a.symbol === wanted))
    if (armed.length === 0) {
      emit(session, {
        type: 'banner',
        kind: 'info',
        title: 'No armed alerts',
        text: wanted
          ? `You don't have an armed ${wanted} alert right now.`
          : "You don't have any armed price alerts right now.",
      })
      return
    }
    if (armed.length === 1 && armed[0]) {
      await cancelById(session, armed[0].id)
      return
    }
    // Several match — never guess which one. List them: each card carries its
    // own CANCEL chip (the SDK collapses alert cards in place by alertId, so
    // re-emitting an armed card updates rather than duplicates).
    emit(session, {
      type: 'banner',
      kind: 'info',
      title: 'Which alert?',
      text: `You have ${armed.length} armed alerts${wanted ? ` on ${wanted}` : ''} — tap CANCEL on the one you mean.`,
    })
    for (const alert of armed) emit(session, alertFrame(alert, 'armed'))
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        tick().catch((err) => log.error({ err }, 'alert poll tick failed'))
      }, pollMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
    sweepOnConnect,
    arm,
    cancelById,
    cancelConversational,
  }
}
