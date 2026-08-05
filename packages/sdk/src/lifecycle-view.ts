/**
 * Lifecycle card view-model — every mapping from wire truth (phase + stage +
 * fillPct + side) to what the card draws, kept pure so it tests in node.
 *
 * The stage vocabulary is OPEN (protocol law): unknown stage strings must
 * degrade to the bare phase — exactly what an SDK without this module shows.
 * The journey line only ever advances on real server frames; the SDK never
 * animates toward a guessed future.
 */
import type { Frame } from '@hippo/protocol'

type Lifecycle = Extract<Frame, { type: 'lifecycle' }>
type Phase = Lifecycle['phase']

const KNOWN_STAGES = new Set(['placing', 'working', 'cancel_pending'])

export type JourneyStep = {
  key: 'prepared' | 'placing' | 'working' | 'terminal'
  /** i18n catalog key — the journey line is SDK chrome, so it localizes. */
  labelKey:
    | 'journey_prepared'
    | 'journey_placed'
    | 'journey_placing'
    | 'journey_working'
    | 'journey_filled'
    | 'journey_cancelling'
  state: 'done' | 'active' | 'pending'
}

/**
 * The confirm-in-flight loader: between a confirmed ticket_action and the
 * FIRST lifecycle frame for the ticket there is real dead air (gateway →
 * venue handoff) that used to read as a mute disabled button. Same journey
 * vocabulary as the lifecycle card — PLACED is done the moment the gateway
 * accepted the confirm (that's wire truth: the 200), WORKING pulses while we
 * wait for the venue, FILLED stays pending. Static by design: it never
 * advances client-side — the first lifecycle frame takes over the story.
 */
export function confirmPendingSteps(): JourneyStep[] {
  return [
    { key: 'prepared', labelKey: 'journey_placed', state: 'done' },
    { key: 'working', labelKey: 'journey_working', state: 'active' },
    { key: 'terminal', labelKey: 'journey_filled', state: 'pending' },
  ]
}

/**
 * The journey line for in-flight cards. Null means "nothing multi-step to
 * show" — legacy frames (no stage) and unknown future stages both render
 * today's single pulse row. Terminal phases return null too: receipts show
 * facts, not journeys.
 */
export function journeySteps(phase: Phase, stage: string | undefined): JourneyStep[] | null {
  const known = stage !== undefined && KNOWN_STAGES.has(stage)
  if (phase === 'partial') {
    // A partial IS working — even if a legacy server omitted the stage.
    return steps('working')
  }
  if (phase !== 'awaiting_confirm' || !known) return null
  return steps(stage as 'placing' | 'working' | 'cancel_pending')
}

function steps(active: 'placing' | 'working' | 'cancel_pending'): JourneyStep[] {
  if (active === 'cancel_pending') {
    return [
      { key: 'prepared', labelKey: 'journey_prepared', state: 'done' },
      { key: 'working', labelKey: 'journey_working', state: 'done' },
      { key: 'terminal', labelKey: 'journey_cancelling', state: 'active' },
    ]
  }
  return [
    { key: 'prepared', labelKey: 'journey_prepared', state: 'done' },
    {
      key: 'placing',
      labelKey: 'journey_placing',
      state: active === 'placing' ? 'active' : 'done',
    },
    {
      key: 'working',
      labelKey: 'journey_working',
      state: active === 'working' ? 'active' : 'pending',
    },
    { key: 'terminal', labelKey: 'journey_filled', state: 'pending' },
  ]
}

/**
 * Root modifier class for terminal ticket cards. Prototype contract:
 * filled = green receipt (.ok) · partial = amber attention (.part) ·
 * cancelled = neutral grey, acknowledged without judgment (.cxl) ·
 * expired = amber attention too — "check the venue" is uncertainty, not
 * failure (red/.err stays reserved for rejections).
 */
export function ticketStateClass(phase: Phase): '' | 'ok' | 'part' | 'cxl' {
  switch (phase) {
    case 'filled':
      return 'ok'
    case 'partial':
    case 'expired':
      return 'part'
    case 'cancelled':
      return 'cxl'
    default:
      return ''
  }
}

/**
 * Side badge for terminal cards. With a server-sent side it reads like the
 * prototype receipt ("BUY · FILLED"); without one (old gateway) it falls
 * back to a NEUTRAL phase badge — never the old hardcoded buy-green, which
 * painted CANCELLED in profit color.
 */
export function sideBadge(
  phase: Phase,
  side: 'buy' | 'sell' | undefined,
): { cls: string; text: string } {
  const phaseWord = phase === 'awaiting_confirm' ? 'WORKING' : phase.toUpperCase()
  if (!side) {
    const cls = phase === 'filled' ? 'side buy' : 'side dim'
    return { cls, text: phaseWord }
  }
  const cls = phase === 'cancelled' || phase === 'expired' ? 'side dim' : `side ${side}`
  return { cls, text: `${side.toUpperCase()} · ${phaseWord}` }
}

/**
 * Terminal receipt headline. The SERVER's statusLine is its description of
 * the completed trade ("FILLED", "ORDER #A31 CANCELLED — NOTHING EXECUTED")
 * — draw it verbatim. `filledFallback` is the caller's localized "Order
 * filled", used ONLY when a filled frame carries no statusLine at all; a
 * non-filled frame without one gets no invented headline.
 */
export function terminalTitle(phase: Phase, statusLine: string, filledFallback: string): string {
  if (statusLine.trim() !== '') return statusLine
  return phase === 'filled' ? filledFallback : ''
}

/**
 * Fill meter: the percentage IS the server's fillPct. Null when there's no
 * fillPct — the bar never draws a guess.
 *
 * It deliberately takes NO rows. The old version located the fill VALUE by
 * matching row labels against /^filled$/i and recomposed "FILLED <value>",
 * so a frame whose rows are in any other language rendered a bare "FILLED"
 * with the money missing. The lifecycle frame carries no structural field for
 * the fill value, so the card renders the server's ROWS VERBATIM (in the
 * server's own words) instead of reconstructing a caption out of them. If the
 * protocol ever grows a structural fill field, it belongs here — not another
 * locale regex.
 */
export function fillMeter(fillPct: number | undefined): { pct: string } | null {
  if (fillPct === undefined) return null
  return { pct: `${fillPct}%` }
}

/** What cancel affordance the card offers, from wire truth only. */
export function cancelAffordance(
  phase: Phase,
  stage: string | undefined,
  cancellable: boolean,
): 'button' | 'pending' | 'none' {
  if (phase !== 'awaiting_confirm' && phase !== 'partial') return 'none'
  if (stage === 'cancel_pending') return 'pending'
  return cancellable ? 'button' : 'none'
}

/** In-flight = more venue events are coming — the LIVE footer's gate. */
export function isInFlight(phase: Phase): boolean {
  return phase === 'awaiting_confirm' || phase === 'partial'
}
