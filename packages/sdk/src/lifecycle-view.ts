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
  label: string
  state: 'done' | 'active' | 'pending'
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
      { key: 'prepared', label: 'PREPARED', state: 'done' },
      { key: 'working', label: 'WORKING', state: 'done' },
      { key: 'terminal', label: 'CANCELLING', state: 'active' },
    ]
  }
  return [
    { key: 'prepared', label: 'PREPARED', state: 'done' },
    { key: 'placing', label: 'PLACING', state: active === 'placing' ? 'active' : 'done' },
    { key: 'working', label: 'WORKING', state: active === 'working' ? 'active' : 'pending' },
    { key: 'terminal', label: 'FILLED', state: 'pending' },
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
 * Fill-bar caption: left text is the server's own "Filled" row value (the
 * SDK never computes money), right text is the server's fillPct. Null when
 * there's no fillPct — the bar only draws server truth.
 */
export function fillCaption(
  rows: Array<{ label: string; value: string }>,
  fillPct: number | undefined,
): { left: string; right: string } | null {
  if (fillPct === undefined) return null
  const filled = rows.find((r) => /^filled$/i.test(r.label))?.value
  return { left: filled ? `FILLED ${filled}` : 'FILLED', right: `${fillPct}%` }
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
