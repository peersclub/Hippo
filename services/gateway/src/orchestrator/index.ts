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
import { asOfDisplay, cacheAgeDisplay, symbolFromText } from './market.js'
import type { MemoryClient } from './memory.js'
import type { SeamClient } from './seam.js'

/** Below this intent confidence we don't trust the route and nudge instead. */
const LOW_CONFIDENCE = 0.4

/** Coalescing window for streamed brief_delta frames (journal economy). */
const DELTA_FLUSH_MS = 150

/** Race winner when the trader stops an in-flight stream (stream_stop). */
const STOPPED = Symbol('stream-stopped')

/** brief frameId → originating turn, kept for REFRESH re-runs (FIFO cap). */
const BRIEF_TURNS_CAP = 500

/** Card actions ride the chip_tap uplink with reserved prefixes (v1 keeps
 * the uplink surface frozen). They are commands, not conversation: never
 * echoed, never classified, never written to persona memory. */
const CARD_ACTION_RE = /^(refresh|share|manage):(.+)$/

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
  seam: SeamClient
  emit: EmitFrame
  telemetry: Telemetry
  log: Log
}

export type Orchestrator = {
  onStreamConnect(session: Session): void
  handleUplink(session: Session, uplink: Uplink): void
  /** Venue lifecycle event from the seam callback. false = unknown ticket. */
  onVenueEvent(event: import('./seam.js').VenueEvent): boolean
}

function userKey(session: Session): string {
  return session.venueUserId ?? session.id
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { intel, market, memory, seam, emit, telemetry, log } = deps

  // ── frame builders ─────────────────────────────────────────────────────

  function briefFrame(res: BriefResponse, intent: string): FrameDraft {
    return {
      type: 'research_brief',
      eyebrow: intent === 'concept' ? 'CONCEPT' : 'MARKET BRIEF',
      live: !res.cached,
      headline: res.headline,
      paragraphs: res.paragraphs,
      stats: res.stats,
      model: res.model,
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

  /**
   * Stopped-stream brief: the authoritative frame for a stream the trader
   * halted. Assembled SERVER-SIDE from the text that already streamed —
   * honest and truncated. No stats, no spark: the server never fabricates
   * numbers it didn't retrieve. liveBar appears only when the snapshot meta
   * (real asOf) was already fetched before the stop.
   */
  function stoppedBriefFrame(
    accumulated: string,
    intent: string,
    asOfIso: string | null,
  ): FrameDraft {
    const paragraphs = accumulated
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
    return {
      type: 'research_brief',
      eyebrow: intent === 'concept' ? 'CONCEPT · STOPPED' : 'MARKET BRIEF · STOPPED',
      live: false,
      headline: 'Stopped early — partial brief',
      paragraphs:
        paragraphs.length > 0
          ? paragraphs
          : ['Stopped before any of the brief had streamed. Ask again for the full picture.'],
      stats: [],
      sources: [],
      followups: [],
      ...(asOfIso
        ? {
            liveBar: {
              asOf: asOfDisplay(asOfIso),
              asOfIso,
              refreshable: true,
              shareable: true,
              feedback: true,
              cached: false,
            },
          }
        : {}),
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

  async function emitMarketOnlyBrief(
    session: Session,
    text: string,
    replaces?: string,
  ): Promise<void> {
    try {
      const snap = await market.snapshot(symbolFromText(text))
      const frame = emit(session, {
        ...marketOnlyBriefFrame(snap),
        ...(replaces ? { replaces } : {}),
      })
      rememberBrief(frame, text, 'research')
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

  // ── action: order tickets (Canonical Trading Interface, Build Plan/04) ──

  /** Live tickets → their session, so venue events (which carry only a
   * ticketId) can be routed back into the right thread. */
  const ticketSessions = new Map<string, Session>()

  /** Tickets whose confirm was handed to the venue — from that moment the
   * order may exist venue-side, so cancel copy and routing must stay honest
   * about it (never "nothing was sent"). */
  const confirmedTickets = new Set<string>()

  /** Post-confirm venue-event backstop: if the seam's callback delivery fails
   * (it retries exactly once, then only audits) the trader must never sit on
   * "WAITING FOR YOUR CONFIRM" forever. Env-tunable so tests can shrink it;
   * read per orchestrator so tests set it before buildApp. */
  const ticketTimeoutMs = Number(process.env.TICKET_EVENT_TIMEOUT_MS ?? 10 * 60_000)

  /** Per-ticket backstop timers (see ticketTimeoutMs). */
  const ticketTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function clearTicketTimeout(ticketId: string): void {
    const timer = ticketTimers.get(ticketId)
    if (timer !== undefined) {
      clearTimeout(timer)
      ticketTimers.delete(ticketId)
    }
  }

  /** (Re)arm the no-venue-event backstop: past the window, close the card
   * with an honest terminal frame instead of leaving it waiting forever. */
  function armTicketTimeout(session: Session, ticketId: string): void {
    clearTicketTimeout(ticketId)
    const timer = setTimeout(() => {
      ticketTimers.delete(ticketId)
      if (!ticketSessions.has(ticketId)) return // already resolved by an event
      // Read the side BEFORE the delete below tears the ticket entry down.
      const side = session.tickets.get(ticketId)?.side
      ticketSessions.delete(ticketId)
      session.tickets.delete(ticketId)
      confirmedTickets.delete(ticketId)
      log.warn({ ticketId }, 'no venue event within the backstop window')
      emit(session, {
        type: 'lifecycle',
        ticketId,
        phase: 'expired',
        statusLine: `NO UPDATE FROM ${session.partner.venueName.toUpperCase()} — CHECK THE VENUE FOR FINAL STATUS`,
        ...(side ? { side } : {}),
      })
    }, ticketTimeoutMs)
    timer.unref?.()
    ticketTimers.set(ticketId, timer)
  }

  // ── stop-streaming (stream_stop uplink) ─────────────────────────────────

  /** In-flight research stream per session. `stop` aborts it: the consuming
   * loop below races every stream event against the stop signal, aborts
   * consumption, and emits the stopped brief; `settled` resolves once that
   * loop has fully wound down. stream_stop with no entry here is a silent
   * no-op. One stream per session — a new research turn stops the previous
   * stream and awaits `settled`, so two streams can never interleave deltas
   * or steal each other's stop handle. */
  const activeStreams = new Map<string, { stop: () => void; settled: Promise<void> }>()

  // ── REFRESH re-runs (card_action refresh:<frameId>) ─────────────────────

  /** Emitted brief frameId → the turn that produced it. REFRESH re-runs the
   * ORIGINAL question and the new brief replaces the old card in place —
   * never a re-classification of the raw "refresh:f_…" string. */
  const briefTurns = new Map<string, { text: string; intent: string }>()

  function rememberBrief(frame: ReturnType<EmitFrame>, text: string, intent: string): void {
    if (!frame) return
    briefTurns.set(frame.id, { text, intent })
    if (briefTurns.size > BRIEF_TURNS_CAP) {
      const oldest = briefTurns.keys().next().value
      if (oldest !== undefined) briefTurns.delete(oldest)
    }
  }

  async function refreshBrief(session: Session, frameId: string): Promise<void> {
    const origin = briefTurns.get(frameId)
    if (!origin) {
      // Gateway restarted or the mapping aged out: an in-place re-run would
      // be a guess at what the trader asked. Say so instead of guessing.
      emit(session, {
        type: 'rejection_ticket',
        title: 'Refresh unavailable',
        reason:
          'This brief is too old to refresh in place — ask the question again for a fresh answer.',
      })
      return
    }
    try {
      const res = await intel.respond({
        text: origin.text,
        intent: origin.intent,
        symbol: symbolFromText(origin.text),
      })
      if (res.kind === 'decline') {
        emit(session, declineFrame(res))
        return
      }
      telemetry.recordCache(res.cached)
      const frame = emit(session, { ...briefFrame(res, origin.intent), replaces: frameId })
      rememberBrief(frame, origin.text, origin.intent)
      telemetry.recordResearchAnswered(userKey(session))
    } catch (err) {
      enterDegraded(session, err)
      await emitMarketOnlyBrief(session, origin.text, frameId)
    }
  }

  async function prepareTicket(session: Session, order: OrderIntent, text: string) {
    // The seam owns quoting, fees and validation (per-venue adapter). The
    // gateway forwards the prepared ticket verbatim — it never computes money.
    let ticket: import('./seam.js').PreparedTicket
    try {
      if (order.capability === 'futures_perp' && order.direction && order.leverage) {
        // Futures perp → the seam's capability plan path.
        ticket = await seam.prepareOrder({
          capability: 'futures_perp',
          partnerId: session.partner.partnerId,
          userId: userKey(session),
          instrument: order.instrument,
          direction: order.direction,
          action: order.action ?? 'open',
          leverage: order.leverage,
          marginMode: order.marginMode ?? 'isolated',
          size: order.size,
          reduceOnly: order.reduceOnly ?? false,
          orderType: order.orderType,
          ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
        })
      } else {
        ticket = await seam.prepare({
          partnerId: session.partner.partnerId,
          userId: userKey(session),
          side: order.side,
          size: order.size,
          instrument: order.instrument,
          orderType: order.orderType,
          ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
        })
      }
    } catch (err) {
      log.error({ err, instrument: order.instrument }, 'seam prepare failed')
      emit(session, {
        type: 'rejection_ticket',
        title: 'Order not prepared',
        reason: `${session.partner.venueName} couldn't quote this order right now, so I won't guess at a price. Nothing was sent to the venue.`,
        fix: { label: 'Try again', action: text },
      })
      return
    }

    ticketSessions.set(ticket.ticketId, session)
    session.tickets.set(ticket.ticketId, {
      side: ticket.side,
      instrument: ticket.instrument,
      sizeDisplay: order.size,
      sizeNum: Number(order.size),
      price: 0, // actuals come back on venue events; the gateway holds no math
      feeRate: 0,
    })

    emit(session, {
      type: 'order_ticket',
      ticketId: ticket.ticketId,
      title: 'Order prepared',
      side: ticket.side,
      sideLabel: ticket.sideLabel,
      rows: ticket.rows,
      cta: `Review & confirm in ${session.partner.venueName} →`,
      footnote: `Hippo prepared this order. ${session.partner.venueName} will ask you to confirm before anything executes.`,
    })
  }

  function confirmHandoff(session: Session, ticketId: string): void {
    const side = session.tickets.get(ticketId)?.side
    // Neutral copy on purpose: the confirm surface (api vs js_callback) is
    // resolved inside the venue adapter, so "sending" is the only claim the
    // gateway can honestly make here. The venue's own event follows with the
    // surface-true status (PLACED — WORKING, or WAITING FOR YOUR CONFIRM).
    emit(session, {
      type: 'lifecycle',
      ticketId,
      phase: 'awaiting_confirm',
      stage: 'placing',
      statusLine: `SENDING ORDER TO ${session.partner.venueName.toUpperCase()}…`,
      cancellable: true,
      ...(side ? { side } : {}),
    })
    // Venue events (fill, partial, reject) flow back asynchronously through
    // POST /internal/venue-events → onVenueEvent below. If the confirm call
    // itself fails, say so — silence is the one unacceptable outcome. And if
    // NO event ever arrives (lost callback), the armed backstop closes the
    // card honestly instead of waiting forever.
    confirmedTickets.add(ticketId)
    armTicketTimeout(session, ticketId)
    seam.confirm(ticketId).catch((err) => {
      log.error({ err, ticketId }, 'seam confirm failed')
      ticketSessions.delete(ticketId)
      session.tickets.delete(ticketId)
      confirmedTickets.delete(ticketId)
      clearTicketTimeout(ticketId)
      emit(session, {
        type: 'lifecycle',
        ticketId,
        phase: 'expired',
        statusLine: `COULDN'T HAND OFF TO ${session.partner.venueName.toUpperCase()} — NOTHING EXECUTED`,
        ...(side ? { side } : {}),
      })
    })
    telemetry.recordUplink('ticket_confirm')
  }

  function cancelTicket(session: Session, ticketId: string): void {
    telemetry.recordUplink('ticket_cancel')
    if (!confirmedTickets.has(ticketId)) {
      // Pre-confirm: nothing ever reached the venue — dismiss locally.
      ticketSessions.delete(ticketId)
      session.tickets.delete(ticketId)
      clearTicketTimeout(ticketId)
      // Fire-and-forget: locally the ticket is gone either way; the seam call
      // stops the venue-side lifecycle.
      seam.cancel(ticketId).catch((err) => log.warn({ err, ticketId }, 'seam cancel failed'))
      emit(session, {
        type: 'lifecycle',
        ticketId,
        phase: 'cancelled',
        statusLine: 'CANCELLED — NOTHING WAS SENT TO THE VENUE',
      })
      return
    }
    // Post-confirm: the order IS on the venue, so "nothing was sent" would be
    // a lie and a racing fill must still reach the trader. Keep the routing
    // entry alive; the venue's own lifecycle event (cancelled — or filled, if
    // the fill won the race) decides the outcome, with the backstop behind it.
    const venue = session.partner.venueName.toUpperCase()
    const side = session.tickets.get(ticketId)?.side
    emit(session, {
      type: 'lifecycle',
      ticketId,
      phase: 'awaiting_confirm',
      stage: 'cancel_pending',
      statusLine: `CANCEL REQUESTED — CONFIRMING WITH ${venue}`,
      cancellable: false,
      ...(side ? { side } : {}),
    })
    seam.cancel(ticketId).then(
      () => armTicketTimeout(session, ticketId),
      (err) => {
        log.warn({ err, ticketId }, 'seam cancel failed post-confirm')
        emit(session, {
          type: 'lifecycle',
          ticketId,
          phase: 'awaiting_confirm',
          stage: 'working', // the order is still live on the venue
          statusLine: `${venue} COULDN'T CANCEL — THE ORDER MAY STILL EXECUTE`,
          cancellable: true,
          ...(side ? { side } : {}),
        })
        armTicketTimeout(session, ticketId)
      },
    )
  }

  /** Venue lifecycle event (from the seam's callback webhook) → frame.
   * This is the mechanism behind "status changes made elsewhere still arrive
   * in the thread": the frame journal + SSE resume deliver it even if the
   * trader reconnects later. */
  function onVenueEvent(event: import('./seam.js').VenueEvent): boolean {
    const session = ticketSessions.get(event.ticketId)
    if (!session) return false // unknown/expired ticket — audit-only
    const side = session.tickets.get(event.ticketId)?.side
    emit(session, {
      type: 'lifecycle',
      ticketId: event.ticketId,
      phase: event.phase,
      statusLine: event.statusLine,
      ...(event.stage ? { stage: event.stage } : {}),
      ...(event.cancellable !== undefined ? { cancellable: event.cancellable } : {}),
      ...(side ? { side } : {}),
      ...(event.venueOrderId ? { venueOrderId: event.venueOrderId } : {}),
      ...(event.fillPct !== undefined ? { fillPct: event.fillPct } : {}),
      ...(event.rows ? { rows: event.rows } : {}),
    })
    if (event.phase === 'filled') telemetry.recordOrderExecuted(userKey(session))
    // Non-terminal phases: placement/cancel acks (awaiting_confirm) and
    // partials both precede more events — treating them as terminal would
    // delete the routing entry and silently drop the fill that follows.
    if (event.phase === 'awaiting_confirm' || event.phase === 'partial') {
      // Still in flight — push the no-event backstop out another window.
      armTicketTimeout(session, event.ticketId)
    } else {
      ticketSessions.delete(event.ticketId)
      session.tickets.delete(event.ticketId)
      confirmedTickets.delete(event.ticketId)
      clearTicketTimeout(event.ticketId)
    }
    return true
  }

  // ── per-turn routing ───────────────────────────────────────────────────

  async function processTurn(session: Session, text: string): Promise<void> {
    const turnStart = Date.now()
    let intentRes: IntentResult
    let degraded = false
    // Span + latency around intent classification (intent-p95 rate-card number).
    const span = telemetry.startSpan('hippo.turn')
    const intentStart = Date.now()
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
    telemetry.recordIntent(intentRes.intent, Date.now() - intentStart)
    span.setAttribute('hippo.intent', intentRes.intent)
    span.setAttribute('hippo.degraded', degraded)
    span.end()

    // Low confidence: don't act on a guess — nudge. (Never applies to the
    // deterministic fallback, which pins confidence at 0.5.)
    if (intentRes.intent === 'smalltalk' || intentRes.confidence < LOW_CONFIDENCE) {
      emit(session, nudgeFrame(session))
      return
    }

    switch (intentRes.intent) {
      case 'research':
      case 'concept': {
        // Serialize research streams per session: stop any in-flight stream
        // and wait for its stopped brief to land BEFORE this turn's skeleton,
        // so the thread never interleaves two streams' prose.
        const prior = activeStreams.get(session.id)
        if (prior) {
          prior.stop()
          await prior.settled
        }
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
          let firstTokenSent = false
          // Everything that streamed, flushed or not — the stopped brief is
          // assembled server-side from exactly this.
          let accumulated = ''
          let metaAsOfIso: string | null = null
          // Model id from the intelligence deltas — forwarded on every
          // brief_delta so provenance shows mid-stream, not just at the end.
          let streamModel: string | undefined
          // First readable token → the first-token-p95 rate-card number.
          const markFirstToken = () => {
            if (firstTokenSent) return
            firstTokenSent = true
            telemetry.recordFirstToken(Date.now() - turnStart, intentRes.intent)
          }
          // stream_stop: the uplink handler fires this session's stop signal;
          // every iteration races the next stream event against it, so a stop
          // lands even while the model is mid-generation between events.
          let requestStop: () => void = () => {}
          const stopSignal = new Promise<typeof STOPPED>((resolve) => {
            requestStop = () => resolve(STOPPED)
          })
          let settle: () => void = () => {}
          const handle = {
            stop: requestStop,
            settled: new Promise<void>((resolve) => {
              settle = resolve
            }),
          }
          activeStreams.set(session.id, handle)
          const stream = intel.respondStream({
            text,
            intent: intentRes.intent,
            symbol,
            ...(persona?.optIn && persona.experienceLevel
              ? { persona: { experienceLevel: persona.experienceLevel } }
              : {}),
          })
          try {
            while (true) {
              const nextEvent = stream.next()
              // Abandoned on stop — must never become an unhandled rejection.
              nextEvent.catch(() => {})
              const step = await Promise.race([nextEvent, stopSignal])
              if (step === STOPPED) {
                // Abort consumption (AbortController-equivalent for the SSE
                // generator: return() runs its finally and drops the rest).
                stream.return(undefined).catch(() => {})
                // Flush the coalescing buffer, then emit the authoritative
                // stopped brief — honest, truncated, server-assembled.
                if (pending.trim()) {
                  emit(session, {
                    type: 'brief_delta',
                    text: pending,
                    ...(streamModel ? { model: streamModel } : {}),
                  })
                }
                const stopped = emit(
                  session,
                  stoppedBriefFrame(accumulated, intentRes.intent, metaAsOfIso),
                )
                rememberBrief(stopped, text, intentRes.intent)
                telemetry.recordResearchAnswered(userKey(session))
                return
              }
              if (step.done) break
              const ev = step.value
              if (ev.event === 'delta') {
                // The delta's model tag is additive on the pinned wire
                // contract — read defensively so an older intelligence
                // service (no tag) still streams fine.
                const model = (ev.data as { model?: unknown }).model
                if (typeof model === 'string') streamModel = model
                accumulated += ev.data.text
                pending += ev.data.text
                const now = Date.now()
                if (pending.trim() && now - lastFlush >= DELTA_FLUSH_MS) {
                  markFirstToken()
                  emit(session, {
                    type: 'brief_delta',
                    text: pending,
                    ...(streamModel ? { model: streamModel } : {}),
                  })
                  pending = ''
                  lastFlush = now
                }
              } else if (ev.event === 'done') {
                // Cache-hit path streams straight to done — that's still the
                // first token the trader sees.
                markFirstToken()
                telemetry.recordCache(ev.data.cached)
                const brief = emit(session, briefFrame(ev.data, intentRes.intent))
                rememberBrief(brief, text, intentRes.intent)
                telemetry.recordResearchAnswered(userKey(session))
                finished = true
              } else if (ev.event === 'replace' || ev.event === 'decline') {
                // Guardrail trip mid-brief is an advice decline too.
                telemetry.recordAdvice(true)
                emit(session, declineFrame(ev.data))
                finished = true
              } else if (ev.event === 'meta') {
                // Snapshot facts land in the final brief either way and the
                // skeleton is already up — no frame. The real asOf is kept so
                // a stopped brief can carry a truthful liveBar.
                const asOf = (ev.data as Record<string, unknown>).asOfIso
                if (typeof asOf === 'string') metaAsOfIso = asOf
              }
            }
            if (!finished) throw new Error('respond stream ended without done/decline')
          } finally {
            settle()
            // Guarded delete: a newer turn may have replaced our handle.
            if (activeStreams.get(session.id) === handle) activeStreams.delete(session.id)
          }
        } catch (err) {
          enterDegraded(session, err)
          await emitMarketOnlyBrief(session, text)
        }
        return
      }

      case 'advice': {
        if (degraded) {
          telemetry.recordAdvice(true)
          emit(session, staticDeclineFrame())
          return
        }
        try {
          const res = await intel.respond({
            text,
            intent: 'advice',
            symbol: symbolFromText(text),
          })
          const declined = res.kind === 'decline'
          telemetry.recordAdvice(declined)
          if (declined) {
            emit(session, declineFrame(res))
          } else {
            rememberBrief(emit(session, briefFrame(res, 'research')), text, 'research')
          }
        } catch (err) {
          enterDegraded(session, err)
          telemetry.recordAdvice(true)
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
        // Ticket-shaped skeleton while the seam quotes — replaces the thinking
        // card (pushFrame's ephemeral rule); the ticket or rejection replaces it.
        emit(session, { type: 'skeleton', shape: 'ticket' })
        await prepareTicket(session, intentRes.order, text)
        return
      }

      case 'portfolio': {
        // Never cached — every read goes to the venue via the seam adapter.
        try {
          const { positions } = await seam.portfolio(session.partner.partnerId, userKey(session))
          emit(session, { type: 'positions', rows: positions })
        } catch (err) {
          log.error({ err }, 'seam portfolio unavailable')
          emit(session, {
            type: 'rejection_ticket',
            title: 'Portfolio temporarily unavailable',
            reason: `${session.partner.venueName} isn't answering position queries right now. Your funds and orders are unaffected — try again in a moment.`,
          })
        }
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
      // Fetched from the seam asynchronously; if the venue is unreachable
      // the strip simply doesn't render — never a fabricated snapshot.
      if (session.journal.lastSeq() === 0) {
        seam
          .portfolio(session.partner.partnerId, userKey(session))
          .then(({ openOrders, positions }) => {
            emit(session, {
              type: 'orders_snapshot',
              open: openOrders,
              positionsCount: positions.length,
            })
          })
          .catch((err) => log.warn({ err }, 'orders snapshot unavailable'))
      }
    },

    onVenueEvent,

    handleUplink(session, uplink) {
      telemetry.recordTurn(uplink.kind)
      switch (uplink.kind) {
        case 'user_text':
        case 'chip_tap': {
          if (uplink.kind === 'chip_tap') {
            // Reserved card-action prefixes are commands, not conversation:
            // no echo bubble, no thinking card, no intent classification —
            // "refresh:f_…" must never run as a research turn.
            const action = uplink.text.match(CARD_ACTION_RE)
            if (action) {
              telemetry.recordUplink(`card_${action[1]}`)
              if (action[1] === 'refresh' && action[2]) {
                refreshBrief(session, action[2]).catch((err) => {
                  log.error({ err }, 'brief refresh failed')
                })
              }
              // share:/manage: are telemetry-only acks — the SDK already did
              // the visible work (share overlay / venue deep-link).
              return
            }
          }
          // Echo + thinking go out synchronously — before any network call —
          // to hold the <150ms first-frame budget. guessIntent is the sync
          // deterministic classifier, so order turns get order-shaped status
          // lines in the SAME thinking frame (a second thinking frame would
          // strand a card on old SDKs — pushFrame only replaces the last
          // ephemeral item).
          emit(session, { type: 'user_echo', text: uplink.text })
          const looksLikeOrder = guessIntent(uplink.text).intent === 'action'
          emit(session, {
            type: 'thinking',
            lines: looksLikeOrder
              ? [
                  'Constructing order…',
                  `Checking balance on ${session.partner.venueName}…`,
                  'Preparing your ticket…',
                ]
              : ['Parsing intent…', 'Fetching live market data…', 'Reading funding & flows…'],
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
        case 'stream_stop': {
          // Stop the session's in-flight research stream: the consuming loop
          // aborts and emits the stopped brief. No active stream (the brief
          // already landed, or none was running) → silent no-op.
          activeStreams.get(session.id)?.stop()
          return
        }
      }
    },
  }
}
