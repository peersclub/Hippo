/**
 * Orchestrator — the card state machine (Build Plan/10 BE Architecture §2).
 *
 * Per turn: validate uplink (done in the route) → emit `thinking` immediately
 * (<150ms budget: it goes out before ANY network call) → intent service →
 * route:
 *
 *   research/concept → skeleton → intelligence /v1/respond → research_brief
 *   advice           → /v1/respond → advice_decline
 *   action           → market-data quote → order_ticket (seam stub)
 *   portfolio        → positions frame (in-memory demo table, seam stub)
 *   smalltalk/low-χ  → short research_brief-style nudge
 *
 * Deliberately a plain TS state machine, not an agent framework: routing is
 * deterministic; only the model calls are model-driven.
 *
 * DEGRADED MODE (the SLA contract): if the intelligence service times out or
 * errors, we emit one `banner(degraded)` per session per episode, classify
 * with the deterministic `guessIntent`, and answer research turns with a
 * market-data-only brief — degraded but truthful. Orders, prices and
 * portfolio never depend on the intelligence service and stay fully live.
 */
import { randomUUID } from 'node:crypto'
import type { Session } from '../plugins/auth.js'
import type { EmitFrame, FrameDraft } from '../plugins/sse.js'
import type { Telemetry } from '../plugins/telemetry.js'
import type {
  BriefResponse,
  DeclineResponse,
  IntelligenceClient,
  IntentResult,
  OrderIntent,
} from './intelligence.js'
import { guessIntent } from './intelligence.js'
import type { MarketClient, MarketSnapshot } from './market.js'
import type { MemoryClient } from './memory.js'
import {
  asOfDisplay,
  cacheAgeDisplay,
  formatAmount,
  formatPrice,
  symbolFromText,
} from './market.js'
import { demoOpenOrders, demoPositions } from './positions.js'

/** Flat dev taker-fee assumption (0.1%) used for the est-cost line. The seam
 * adapter returns venue-true fees in Phase 3. */
const FEE_RATE = 0.001

/** Below this intent confidence we don't trust the route and nudge instead. */
const LOW_CONFIDENCE = 0.4

const DEFAULT_FILL_DELAY_MS = 3_000

/** Coalescing window for streamed brief_delta frames (journal economy). */
const DELTA_FLUSH_MS = 150

type Uplink = import('@hippo/protocol').Uplink

type Log = {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
}

export type OrchestratorDeps = {
  intel: IntelligenceClient
  market: MarketClient
  memory: MemoryClient
  emit: EmitFrame
  telemetry: Telemetry
  log: Log
  /** Simulated venue fill latency; tests shrink it. */
  fillDelayMs?: number
}

export type Orchestrator = {
  onStreamConnect(session: Session): void
  handleUplink(session: Session, uplink: Uplink): void
}

function userKey(session: Session): string {
  return session.venueUserId ?? session.id
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { intel, market, memory, emit, telemetry, log } = deps
  const fillDelayMs = deps.fillDelayMs ?? DEFAULT_FILL_DELAY_MS

  // ── frame builders ─────────────────────────────────────────────────────

  function briefFrame(res: BriefResponse, intent: string): FrameDraft {
    return {
      type: 'research_brief',
      eyebrow: intent === 'concept' ? 'CONCEPT' : 'MARKET BRIEF',
      live: !res.cached,
      headline: res.headline,
      paragraphs: res.paragraphs,
      stats: res.stats,
      ...(res.sparkPoints && res.sparkPoints.length >= 2
        ? { spark: { points: res.sparkPoints } }
        : {}),
      sources: res.sources,
      followups: res.followups,
      liveBar: {
        asOf: asOfDisplay(res.asOfIso),
        asOfIso: res.asOfIso,
        refreshable: true,
        shareable: true,
        feedback: true,
        cached: res.cached,
        ...(res.cached ? { cacheAge: cacheAgeDisplay(res.asOfIso) } : {}),
      },
    }
  }

  function declineFrame(res: DeclineResponse): FrameDraft {
    return {
      type: 'advice_decline',
      message: res.message,
      pivotTitle: res.pivotTitle,
      facts: res.facts,
      followups: res.followups,
    }
  }

  /** Static decline for degraded mode — no model, no market call, still honest. */
  function staticDeclineFrame(): FrameDraft {
    return {
      type: 'advice_decline',
      message:
        "I can't tell you whether to trade — an assistant that gives trading calls isn't on your side. Here's what I can do instead:",
      pivotTitle: 'What I can show you right now',
      facts: [
        { icon: '◎', text: 'The live picture for any asset — price, 12h move, funding.' },
        { icon: '▤', text: 'Your open orders and positions, straight from the venue.' },
        { icon: '✎', text: 'A prepared order ticket you confirm on the exchange, never here.' },
      ],
      followups: ['BTC price picture', 'My positions & P&L'],
    }
  }

  /** Degraded-mode research: headline/stats/spark built directly from the
   * market-data snapshot; one templated sentence of prose; provenance is the
   * price feed and nothing else. */
  function marketOnlyBriefFrame(snap: MarketSnapshot): FrameDraft {
    const base = snap.symbol.split('/')[0] ?? snap.symbol
    const direction = snap.change12hPct < 0 ? 'down' : 'up'
    const magnitude = snap.change12hDisplay.replace(/^[+−-]/, '')
    const stats: Array<{ k: string; v: string; tone: string }> = [
      { k: 'LAST', v: snap.lastDisplay, tone: 'neutral' },
      { k: '12H', v: snap.change12hDisplay, tone: snap.change12hPct < 0 ? 'neg' : 'pos' },
    ]
    if (snap.fundingDisplay !== null && snap.fundingRate !== null) {
      stats.push({
        k: 'FUNDING',
        v: snap.fundingDisplay,
        tone: snap.fundingRate < 0 ? 'neg' : 'pos',
      })
    }
    return {
      type: 'research_brief',
      eyebrow: 'MARKET BRIEF',
      live: true,
      headline: `${base} is ${direction} ${magnitude} over 12 hours`,
      paragraphs: [
        `Fresh research is briefly paused, so this comes straight from the live price feed: ${base} last traded at ${snap.lastDisplay}, ${snap.change12hDisplay} over the past 12 hours.`,
      ],
      stats,
      spark: {
        points: snap.spark,
        captionLeft: `${snap.symbol} · 12H`,
        captionRight: `$${snap.lastDisplay}`,
      },
      sources: ['PRICE FEED'],
      followups: ['My positions & P&L', 'Explain funding rates'],
      liveBar: {
        asOf: asOfDisplay(snap.asOfIso),
        asOfIso: snap.asOfIso,
        refreshable: true,
        shareable: true,
        feedback: true,
        cached: false,
      },
    }
  }

  /** Smalltalk / low-confidence: a short, helpful nudge in brief clothing. */
  function nudgeFrame(session: Session): FrameDraft {
    return {
      type: 'research_brief',
      eyebrow: 'HIPPO',
      live: false,
      headline: 'Ask me about the market',
      paragraphs: [
        'I can research any listed asset, explain concepts, prepare orders for you to confirm on the exchange, and show your positions. Try one of these:',
      ],
      stats: [],
      sources: [],
      followups: session.partner.suggestedQueries.slice(0, 4),
    }
  }

  // ── degraded-mode helpers ──────────────────────────────────────────────

  function enterDegraded(session: Session, err: unknown): void {
    telemetry.markDegraded()
    log.warn({ err }, 'intelligence unreachable — degraded mode')
    if (!session.degradedBannerShown) {
      session.degradedBannerShown = true
      emit(session, {
        type: 'banner',
        kind: 'degraded',
        title: 'HIGH MARKET LOAD',
        text: 'Fresh research may take longer than usual; orders, prices and saved briefs are unaffected.',
      })
    }
  }

  async function emitMarketOnlyBrief(session: Session, text: string): Promise<void> {
    try {
      const snap = await market.snapshot(symbolFromText(text))
      emit(session, marketOnlyBriefFrame(snap))
      telemetry.recordResearchAnswered(userKey(session))
    } catch (err) {
      // Both intelligence AND market-data are down: say so, truthfully.
      log.error({ err }, 'market-data also unreachable in degraded mode')
      emit(session, {
        type: 'research_brief',
        eyebrow: 'MARKET BRIEF',
        live: false,
        headline: 'Live research is temporarily unavailable',
        paragraphs: [
          'Both fresh research and the live price feed are briefly unreachable. Your orders and positions are unaffected — try again in a moment.',
        ],
        stats: [],
        sources: [],
        followups: session.partner.suggestedQueries.slice(0, 2),
      })
    }
  }

  // ── action: order tickets (seam stub) ──────────────────────────────────

  async function prepareTicket(session: Session, order: OrderIntent, text: string) {
    // SEAM STUB — Phase 3 replaces this block with the Canonical Trading
    // Interface adapter (seam service): prepare() against the venue with real
    // fee schedules and balance checks. Until then the gateway quotes the
    // estimate from market-data and simulates the venue lifecycle.
    const sizeNum = Number(order.size)
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `I couldn't read the order size — try phrasing it like "buy 0.05 BTC".`,
      })
      return
    }

    let snap: MarketSnapshot
    try {
      snap = await market.snapshot(order.instrument)
    } catch (err) {
      log.error({ err, instrument: order.instrument }, 'quote unavailable')
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `Live pricing for ${order.instrument} is unavailable right now, so I won't guess at a quote.`,
        fix: { label: 'Try again', action: text },
      })
      return
    }

    const isLimit = order.orderType === 'limit' && order.limitPrice !== undefined
    const price = isLimit ? Number(order.limitPrice) : snap.last
    if (!Number.isFinite(price) || price <= 0) {
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `I couldn't read the limit price — try phrasing it like "buy 0.05 BTC at 61000".`,
      })
      return
    }

    // Est. cost = size × price × 1.001 — flat 0.1% dev taker fee (FEE_RATE);
    // the seam adapter substitutes venue-true fees in Phase 3.
    const estCost = sizeNum * price * (1 + FEE_RATE)
    const base = order.instrument.split('/')[0] ?? order.instrument
    const sizeDisplay = `${order.size} ${base}`
    const ticketId = `t_${randomUUID().replaceAll('-', '').slice(0, 10)}`

    session.tickets.set(ticketId, {
      side: order.side,
      instrument: order.instrument,
      sizeDisplay,
      sizeNum,
      price,
      feeRate: FEE_RATE,
    })

    const rows: Array<{ label: string; value: string }> = [
      { label: 'Instrument', value: order.instrument.replace('/', ' / ') },
      { label: 'Size', value: sizeDisplay },
      ...(isLimit
        ? [{ label: 'Limit price', value: formatPrice(price) }]
        : [{ label: 'Est. price', value: formatPrice(price) }]),
      { label: 'Est. cost incl. fees', value: `${formatAmount(estCost)} USDT` },
    ]

    emit(session, {
      type: 'order_ticket',
      ticketId,
      title: 'Order prepared',
      side: order.side,
      sideLabel: `${order.side.toUpperCase()} · ${isLimit ? 'LMT' : 'MKT'}`,
      rows,
      cta: `Review & confirm in ${session.partner.venueName} →`,
      footnote: `Hippo prepared this order. ${session.partner.venueName} will ask you to confirm before anything executes.`,
    })
  }

  function confirmHandoff(session: Session, ticketId: string): void {
    const quote = session.tickets.get(ticketId)
    emit(session, {
      type: 'lifecycle',
      ticketId,
      phase: 'awaiting_confirm',
      statusLine: `WAITING FOR YOUR CONFIRM ON ${session.partner.venueName.toUpperCase()}`,
      cancellable: true,
    })

    // SEAM STUB — Phase 3: the seam's webhook receiver + poll reconciler
    // deliver real venue events here. Until then we simulate a fill with the
    // actuals taken from the quote captured at prepare time.
    const timer = setTimeout(() => {
      const venueOrderId = `KBX-${Math.floor(10_000_000 + Math.random() * 89_999_999)}`
      const rows: Array<{ label: string; value: string }> = quote
        ? [
            { label: 'Avg fill', value: formatPrice(quote.price) },
            {
              label: 'Fees (actual)',
              value: `${formatAmount(quote.sizeNum * quote.price * quote.feeRate)} USDT`,
            },
            { label: 'Venue order ID', value: venueOrderId },
          ]
        : [{ label: 'Venue order ID', value: venueOrderId }]
      emit(session, {
        type: 'lifecycle',
        ticketId,
        phase: 'filled',
        statusLine: 'FILLED',
        venueOrderId,
        rows,
      })
      telemetry.recordOrderExecuted(userKey(session))
      session.tickets.delete(ticketId)
    }, fillDelayMs)
    if (quote) quote.fillTimer = timer

    telemetry.recordUplink('ticket_confirm')
  }

  function cancelTicket(session: Session, ticketId: string): void {
    const quote = session.tickets.get(ticketId)
    if (quote?.fillTimer) clearTimeout(quote.fillTimer)
    session.tickets.delete(ticketId)
    emit(session, {
      type: 'lifecycle',
      ticketId,
      phase: 'cancelled',
      statusLine: 'CANCELLED — NOTHING WAS SENT TO THE VENUE',
    })
    telemetry.recordUplink('ticket_cancel')
  }

  // ── per-turn routing ───────────────────────────────────────────────────

  async function processTurn(session: Session, text: string): Promise<void> {
    let intentRes: IntentResult
    let degraded = false
    try {
      intentRes = await intel.intent({ text, language: session.language })
      telemetry.markHealthy()
      // Recovered: a future degradation episode gets its banner again.
      session.degradedBannerShown = false
    } catch (err) {
      degraded = true
      enterDegraded(session, err)
      intentRes = guessIntent(text)
    }
    telemetry.recordIntent(intentRes.intent)

    // Low confidence: don't act on a guess — nudge. (Never applies to the
    // deterministic fallback, which pins confidence at 0.5.)
    if (intentRes.intent === 'smalltalk' || intentRes.confidence < LOW_CONFIDENCE) {
      emit(session, nudgeFrame(session))
      return
    }

    switch (intentRes.intent) {
      case 'research':
      case 'concept': {
        emit(session, { type: 'skeleton', shape: 'brief' })
        if (degraded) {
          await emitMarketOnlyBrief(session, text)
          return
        }
        // Persona (Memory v1): one read per research turn — null (opted out
        // or memory down) costs nothing and changes nothing. Experience
        // level calibrates concept depth in the research engine; the asset
        // and question are remembered ONLY for opted-in users.
        const persona = await memory.get(session.partner.partnerId, userKey(session))
        const symbol = symbolFromText(text)
        if (persona?.optIn) {
          memory
            .update(session.partner.partnerId, userKey(session), {
              followAsset: symbol.split('/')[0] ?? symbol,
              openThread: { text, symbol: symbol.split('/')[0] },
            })
            .catch(() => {}) // fire-and-forget; a turn never waits on memory
        }
        try {
          // Streaming path: brief_delta frames fill the skeleton with prose
          // as the research engine generates; the final research_brief frame
          // is authoritative and replaces the accumulated text in the SDK.
          // Deltas are coalesced (~DELTA_FLUSH_MS) so the frame journal and
          // SSE fan-out carry dozens of frames per brief, not hundreds.
          let pending = ''
          let lastFlush = 0
          let finished = false
          for await (const ev of intel.respondStream({
            text,
            intent: intentRes.intent,
            symbol,
            ...(persona?.optIn && persona.experienceLevel
              ? { persona: { experienceLevel: persona.experienceLevel } }
              : {}),
          })) {
            if (ev.event === 'delta') {
              pending += ev.data.text
              const now = Date.now()
              if (pending.trim() && now - lastFlush >= DELTA_FLUSH_MS) {
                emit(session, { type: 'brief_delta', text: pending })
                pending = ''
                lastFlush = now
              }
            } else if (ev.event === 'done') {
              telemetry.recordCache(ev.data.cached)
              emit(session, briefFrame(ev.data, intentRes.intent))
              telemetry.recordResearchAnswered(userKey(session))
              finished = true
            } else if (ev.event === 'replace' || ev.event === 'decline') {
              emit(session, declineFrame(ev.data))
              finished = true
            }
            // 'meta' carries the snapshot facts; they land in the final
            // brief either way and the skeleton is already up — no frame.
          }
          if (!finished) throw new Error('respond stream ended without done/decline')
        } catch (err) {
          enterDegraded(session, err)
          await emitMarketOnlyBrief(session, text)
        }
        return
      }

      case 'advice': {
        if (degraded) {
          emit(session, staticDeclineFrame())
          return
        }
        try {
          const res = await intel.respond({
            text,
            intent: 'advice',
            symbol: symbolFromText(text),
          })
          emit(session, res.kind === 'decline' ? declineFrame(res) : briefFrame(res, 'research'))
        } catch (err) {
          enterDegraded(session, err)
          emit(session, staticDeclineFrame())
        }
        return
      }

      case 'action': {
        if (!intentRes.order) {
          emit(session, {
            type: 'rejection_ticket',
            title: 'Order not prepared',
            reason: 'Tell me the side, size and asset — for example "buy 0.05 BTC at market".',
          })
          return
        }
        await prepareTicket(session, intentRes.order, text)
        return
      }

      case 'portfolio': {
        // Never cached; seam stub serves the demo table (positions.ts).
        emit(session, { type: 'positions', rows: demoPositions })
        return
      }

      default:
        emit(session, nudgeFrame(session))
        return
    }
  }

  // ── public surface ─────────────────────────────────────────────────────

  return {
    onStreamConnect(session) {
      // Opening state: current orders strip only. No scripted conversation —
      // the thread starts empty and the SDK shows its empty-state hero.
      // Emit once per session: on reconnect the journal replay covers it.
      if (session.journal.lastSeq() === 0) {
        emit(session, {
          type: 'orders_snapshot',
          open: demoOpenOrders,
          positionsCount: demoPositions.length,
        })
      }
    },

    handleUplink(session, uplink) {
      telemetry.recordTurn(uplink.kind)
      switch (uplink.kind) {
        case 'user_text':
        case 'chip_tap': {
          // Echo + thinking go out synchronously — before any network call —
          // to hold the <150ms first-frame budget.
          emit(session, { type: 'user_echo', text: uplink.text })
          emit(session, {
            type: 'thinking',
            lines: ['Parsing intent…', 'Fetching live market data…', 'Reading funding & flows…'],
          })
          processTurn(session, uplink.text).catch((err) => {
            log.error({ err }, 'turn processing failed')
          })
          return
        }
        case 'ticket_action': {
          if (uplink.action === 'confirm_handoff') confirmHandoff(session, uplink.ticketId)
          else cancelTicket(session, uplink.ticketId)
          return
        }
        case 'settings': {
          if (uplink.language) session.language = uplink.language
          if (uplink.memoryOptIn !== undefined) {
            memory
              .update(session.partner.partnerId, userKey(session), {
                optIn: uplink.memoryOptIn,
              })
              .catch(() => {})
          }
          if (uplink.clearMemory) {
            // The settings promise: wipe persona data (opt-in choice survives).
            memory.clear(session.partner.partnerId, userKey(session)).catch(() => {})
          }
          telemetry.recordUplink('settings')
          return
        }
        case 'consent': {
          // Onboarding consent: the moment memory is allowed to exist.
          memory
            .update(session.partner.partnerId, userKey(session), {
              optIn: uplink.memoryOptIn,
            })
            .catch(() => {})
          telemetry.recordUplink('consent')
          return
        }
        case 'feedback': {
          // Recorded for the L2 export pipeline (BE doc §4); counters only here.
          telemetry.recordUplink(uplink.kind)
          return
        }
      }
    },
  }
}
