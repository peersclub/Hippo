/**
 * Card registry — one Preact component per protocol card type.
 * Cards are pure: props in, DOM out. Unknown types render <FallbackCard/>.
 */
import type {
  AdviceDecline,
  Alert,
  Banner,
  BriefDelta,
  Clarification,
  Frame,
  HostAction,
  Interpretation,
  Lifecycle,
  OrderDraft,
  OrdersSummary,
  OrderTicket,
  Positions,
  RejectionTicket,
  ResearchBrief,
  Skeleton,
  Thinking,
  UnknownFrame,
  UploadStatus,
  UserEcho,
} from '@hippo/protocol'
import type { JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  ALERT_STATE_KEY,
  alertStateClass,
  cancelAlertUplink,
  showCancelChip,
} from './alerts-view.js'
import { chosenOptionId, clarificationState, isAnswerable, pickOption } from './clarification.js'
import {
  assembleDraftParams,
  initialLeverage,
  maxLeverageOf,
  protectiveEnabled,
  sizeValid,
} from './draft.js'
import {
  FEEDBACK_REASONS,
  type FeedbackEvent,
  feedbackDoneLabel,
  feedbackTransition,
} from './feedback.js'
import { isStale, LANDED_FLASH_MS, STALE_CHECK_INTERVAL_MS, staleAgeLabel } from './freshness.js'
import { type HostActionPhase, hostActionMap } from './host-actions.js'
import { type Locale, type MessageKey, t } from './i18n.js'
import {
  cancelAffordance,
  confirmPendingSteps,
  fillMeter,
  isInFlight,
  journeySteps,
  sideBadge,
  terminalTitle,
  ticketStateClass,
} from './lifecycle-view.js'
import { emptyLabelKey, hasFill, orderedRows, scopeLabelKey, totalCells } from './orders-summary.js'
import { dispatch } from './outbox.js'
import { positionsEmptyText } from './positions-view.js'
import { briefClipboardText, COPIED_FLASH_MS } from './share.js'
import { connection, feedbackMap, livePrice, locale, shareFrame, thread } from './state.js'
import { interruptedStreamIds } from './streaming.js'
import { send } from './transport.js'

/** Exported for the share overlay — the co-branded card reuses the exact spark. */
export function SparklineSvg({ points }: { points: number[] }) {
  const max = Math.max(...points)
  const min = Math.min(...points)
  const span = max - min || 1
  const step = 300 / (points.length - 1)
  const y = (p: number) => 44 - ((p - min) / span) * 40
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(p).toFixed(1)}`)
    .join(' ')
  return (
    <svg class="spark" viewBox="0 0 300 48" preserveAspectRatio="none" aria-hidden="true">
      <path class="fill" d={`${line} L300,48 L0,48 Z`} />
      <path class="line" d={line} />
    </svg>
  )
}

/** Crisp inline thumb glyphs — emoji rendered differently on every host
 * platform and fought the mono aesthetic; currentColor lets CSS drive the
 * neutral→amber state. */
function ThumbSvg({ down }: { down?: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={down ? 'transform:scale(-1)' : undefined}
    >
      <path d="M2 10h4v11H2zM22 11c0-1.1-.9-2-2-2h-5.3l.9-4.6c.1-.5-.1-1-.4-1.4L14 2 8.6 8.6c-.4.4-.6 1-.6 1.6V19c0 1.1.9 2 2 2h7c.8 0 1.5-.5 1.8-1.2l3-7c.1-.2.2-.5.2-.8v-1z" />
    </svg>
  )
}

function LiveBarRow({ frame }: { frame: ResearchBrief }) {
  const lb = frame.liveBar
  // Feedback lives in a keyed signal map (not component state) so "already
  // gave feedback" survives minimize/reopen; the reducer's terminal states
  // guarantee replays can't double-send.
  const fb = feedbackMap.value[frame.id] ?? { phase: 'idle' as const }
  // REFRESH is held pending (disabled) until the replacing brief lands. The
  // server answers a refresh with a research_brief carrying `replaces:<this
  // id>`, which swaps this card out in place (state.ts) — unmounting this row
  // and clearing the pending state for free. No optimistic fixed-time flash:
  // the button reflects the real in-flight re-run, not a guess at its length.
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef(0)
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  // Refresh-land flash (the brand's "flash" verb): a brief that REPLACED an
  // older one mounts a fresh row — hold the as-of amber for a beat so the
  // update registers. Coupled to the replaces-swap remount in state.ts; if
  // that ever preserves component instances, this hook moves.
  const [landed, setLanded] = useState(() => Boolean(frame.replaces))
  useEffect(() => {
    if (!landed) return
    const timer = setTimeout(() => setLanded(false), LANDED_FLASH_MS)
    return () => clearTimeout(timer)
  }, [landed])
  // Stale data is declared, never silent (edge state №5): past the threshold
  // the as-of turns amber (with an age prefix) and REFRESH becomes the
  // loudest element.
  const [stale, setStale] = useState(() => (lb ? isStale(lb.asOfIso) : false))
  const [ageLabel, setAgeLabel] = useState<string | null>(() =>
    lb ? staleAgeLabel(lb.asOfIso) : null,
  )
  useEffect(() => {
    if (!lb) return
    const check = () => {
      setStale(isStale(lb.asOfIso))
      setAgeLabel(staleAgeLabel(lb.asOfIso))
    }
    check()
    const t = setInterval(check, STALE_CHECK_INTERVAL_MS)
    return () => clearInterval(t)
  }, [lb])
  if (!lb) return null
  const refresh = () => {
    if (pending) return
    setPending(true)
    void dispatch({ kind: 'chip_tap', text: `refresh:${frame.id}` })
  }
  // 👍 stays instant; 👎 asks one follow-up. The three reason chips map 1:1
  // to eval-harness scoring criteria — labels arrive pre-categorized (Layer 2).
  const applyFeedback = (event: FeedbackEvent) => {
    const { state: next, uplink } = feedbackTransition(fb, event)
    feedbackMap.value = { ...feedbackMap.value, [frame.id]: next }
    if (uplink) void dispatch({ kind: 'feedback', frameId: frame.id, ...uplink })
  }
  const share = () => {
    shareFrame.value = frame
    // No share backend yet — the overlay renders from frame data alone;
    // this uplink lets the server log share intent.
    void dispatch({ kind: 'chip_tap', text: `share:${frame.id}` })
  }
  const copy = () => {
    // Clipboard can be unavailable — the button simply doesn't confirm.
    void navigator.clipboard?.writeText(briefClipboardText(frame)).catch(() => {})
    setCopied(true)
    clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), COPIED_FLASH_MS)
  }
  const done = feedbackDoneLabel(fb)
  return (
    <>
      <div class={`livebar${stale ? ' stale' : ''}`}>
        <span class={`asof${pending ? ' flash' : ''}${landed ? ' landed' : ''}`}>
          {stale && ageLabel}
          {lb.asOf}
        </span>
        {lb.refreshable && (
          <button
            type="button"
            class={`rf${pending ? ' pending' : ''}`}
            disabled={pending}
            aria-busy={pending}
            onClick={refresh}
          >
            {pending ? '⟳ REFRESHING…' : stale ? '↻ REFRESH NOW' : '↻ REFRESH'}
          </button>
        )}
        <button type="button" onClick={copy} aria-label={t(locale.value, 'copy_brief')}>
          {copied ? 'COPIED ✓' : '⧉ COPY'}
        </button>
        {lb.shareable && (
          <button type="button" onClick={share}>
            ↗ SHARE
          </button>
        )}
        {lb.feedback && fb.phase !== 'asking' && (
          <span class="fb">
            {done ? (
              <span class="done">{done}</span>
            ) : (
              <>
                <button
                  type="button"
                  aria-label={t(locale.value, 'feedback_helpful')}
                  onClick={() => applyFeedback({ type: 'vote', vote: 'up' })}
                >
                  <ThumbSvg />
                </button>
                <button
                  type="button"
                  aria-label={t(locale.value, 'feedback_not_helpful')}
                  onClick={() => applyFeedback({ type: 'vote', vote: 'down' })}
                >
                  <ThumbSvg down />
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {fb.phase === 'asking' && (
        <div class="fbask">
          <span class="q">WHAT WAS OFF?</span>
          {FEEDBACK_REASONS.map((r) => (
            <button
              type="button"
              class="fbchip"
              key={r.reason}
              onClick={() => applyFeedback({ type: 'reason', reason: r.reason })}
            >
              {r.label}
            </button>
          ))}
          <button type="button" class="fbskip" onClick={() => applyFeedback({ type: 'skip' })}>
            skip
          </button>
        </div>
      )}
    </>
  )
}

function ResearchBriefCard({ frame }: { frame: ResearchBrief }) {
  return (
    <div class="bubble">
      <div class="eyebrow">
        <span>{frame.eyebrow}</span>
        <span class="eyebrow-right">
          {frame.live && <span class="live">● LIVE</span>}
          {frame.model && <span class="model-tag">{frame.model}</span>}
        </span>
      </div>
      {frame.liveBar?.cached && (
        <span class="cache-badge">CACHED BRIEF · {frame.liveBar.cacheAge}</span>
      )}
      <h3>{frame.headline}</h3>
      {frame.paragraphs.map((p) => (
        <p key={p}>{p}</p>
      ))}
      {frame.stats.length > 0 && (
        <div class="kv">
          {frame.stats.map((s) => (
            <div key={s.k}>
              <span class="k">{s.k}</span>
              <span class={`v ${s.tone === 'neg' ? 'neg' : s.tone === 'pos' ? 'pos' : ''}`}>
                {s.v}
              </span>
            </div>
          ))}
        </div>
      )}
      {frame.spark && (
        <>
          <SparklineSvg points={frame.spark.points} />
          <div class="figcap">
            <span>{frame.spark.captionLeft}</span>
            <span>{frame.spark.captionRight}</span>
          </div>
        </>
      )}
      {frame.sources.length > 0 && (
        <div class="srcs">
          {frame.sources.map((s) => (
            <span class="src" key={s}>
              {s}
            </span>
          ))}
        </div>
      )}
      <LiveBarRow frame={frame} />
    </div>
  )
}

function OrderTicketCard({ frame }: { frame: OrderTicket }) {
  // A trading action that fails silently is the worst kind: the trader can't
  // tell if the order registered. ticket_action is never queued (a confirm
  // fired minutes later is unacceptable) — so a live failure must surface here.
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  // Confirm accepted by the gateway — the order is genuinely in flight. Drives
  // the stepped loader below until the first lifecycle frame takes over.
  const [placed, setPlaced] = useState(false)
  // Once a lifecycle frame exists for this ticket the order is handed off —
  // derived from the thread (not component state) so it survives remounts.
  const handedOff = thread.value.some(
    (x) =>
      x.kind === 'frame' && x.frame.type === 'lifecycle' && x.frame.ticketId === frame.ticketId,
  )
  const confirm = async () => {
    setFailed(false)
    setBusy(true)
    const ok = await send({
      kind: 'ticket_action',
      ticketId: frame.ticketId,
      action: 'confirm_handoff',
    })
    setBusy(false)
    if (!ok) setFailed(true)
    else setPlaced(true)
  }
  const L = locale.value
  return (
    <div class="ticket">
      <div class="th">
        <span class="tt">{frame.title}</span>
        <span class={`side ${frame.side}`}>{frame.sideLabel}</span>
      </div>
      <div class="tb">
        {frame.rows.map((r) => (
          <div class="trow" key={r.label}>
            <span class="lab">{r.label}</span>
            <b>{r.value}</b>
          </div>
        ))}
      </div>
      {placed && !handedOff ? (
        // Between the accepted confirm and the FIRST lifecycle frame: a
        // stepped loader in the lifecycle vocabulary (PLACED · WORKING →
        // FILLED) instead of a mute disabled button. Static by design — it
        // never advances client-side; the lifecycle card takes the story over.
        <>
          <div class="journey" aria-hidden="true">
            {confirmPendingSteps().map((s) => (
              <span class={`stp ${s.state}`} key={s.key}>
                {s.state === 'done' && <span class="tick">✓</span>}
                {s.state === 'active' && <span class="pulse" />}
                {t(L, s.labelKey)}
              </span>
            ))}
          </div>
          <div class="await" role="status" aria-live="polite">
            {t(L, 'order_in_flight')}
          </div>
        </>
      ) : (
        /* ticket_action is deliberately NOT queueable — a confirm fired minutes
           later without the trader present is unacceptable. Offline: fail loud.
           `busy` reflects the real uplink round-trip; `handedOff` is wire truth. */
        <button
          type="button"
          class="cta"
          disabled={busy || handedOff || connection.value !== 'live'}
          aria-busy={busy}
          title={connection.value !== 'live' ? t(L, 'ticket_offline_hint') : undefined}
          onClick={confirm}
        >
          {handedOff ? t(L, 'handed_off') : busy ? t(L, 'confirming') : frame.cta}
        </button>
      )}
      {failed && <div class="action-failed">{t(L, 'action_failed')}</div>}
      <div class="tfoot">{frame.footnote}</div>
    </div>
  )
}

/**
 * Interactive order DRAFT — the editable stage BEFORE a ticket. The controls
 * are seeded from the server's frame and the card only ever ECHOES the
 * trader's edits back (draft_action → gateway re-validation → the normal
 * prepare → order_ticket flow). The SDK never invents an order.
 *
 * The price row draws from the transient livePrice signal — and only when the
 * tick's symbol matches the card's currently selected instrument; otherwise
 * an honest dash. Like ticket confirm, submit is never queued offline: a
 * trading action fired minutes later without the trader present is
 * unacceptable, so the button simply disables until the stream is live.
 */
function OrderDraftCard({ frame }: { frame: OrderDraft }) {
  const L = locale.value
  const perp = frame.capability === 'futures_perp'
  const maxLev = maxLeverageOf(frame)
  // Local edit state, seeded from the frame (thin client: server proposes,
  // trader edits, server re-validates).
  const [instrument, setInstrument] = useState(frame.instrument)
  const [orderType, setOrderType] = useState<'market' | 'limit'>(frame.orderType)
  const [size, setSize] = useState(frame.size)
  const [limitPrice, setLimitPrice] = useState(frame.limitPrice ?? '')
  // Protective exits: inputs exist only when the SERVER put the fields on the
  // frame (venue supports attaching them) — frame presence drives it.
  const protective = protectiveEnabled(frame)
  const [stopLossPrice, setStopLossPrice] = useState(frame.stopLossPrice ?? '')
  const [takeProfitPrice, setTakeProfitPrice] = useState(frame.takeProfitPrice ?? '')
  const [leverage, setLeverage] = useState(() => initialLeverage(frame))
  const [marginMode, setMarginMode] = useState(frame.marginMode ?? frame.marginModes[0])
  const [phase, setPhase] = useState<'editing' | 'busy' | 'sent' | 'dismissed'>('editing')
  const [failed, setFailed] = useState(false)

  // Live price for the card's CURRENT selection — dash when the tick belongs
  // to a different symbol (or none arrived yet). Flash briefly on change so
  // the update registers; CSS drops the transition under reduced motion.
  const lp = livePrice.value
  const price = lp && lp.symbol === instrument ? lp : null
  const [flash, setFlash] = useState(false)
  const lastSeen = useRef<number | null>(null)
  useEffect(() => {
    const cur = price?.last ?? null
    if (cur !== null && lastSeen.current !== null && cur !== lastSeen.current) {
      setFlash(true)
      const t = setTimeout(() => setFlash(false), 600)
      lastSeen.current = cur
      return () => clearTimeout(t)
    }
    lastSeen.current = cur
  }, [price?.last])

  const submit = async () => {
    if (phase !== 'editing' || !sizeValid(size) || connection.value !== 'live') return
    setFailed(false)
    setPhase('busy') // exactly once — disabled the instant it's tapped
    const ok = await send({
      kind: 'draft_action',
      draftId: frame.draftId,
      action: 'submit',
      params: assembleDraftParams({
        capability: frame.capability,
        instrument,
        orderType,
        size,
        limitPrice,
        stopLossPrice: protective ? stopLossPrice : '',
        takeProfitPrice: protective ? takeProfitPrice : '',
        leverage,
        maxLeverage: maxLev,
        marginMode,
      }),
    })
    // Success stays disabled — the server's ticket/rejection is the response.
    // Failure fails loud and re-arms (nothing reached the venue).
    if (ok) setPhase('sent')
    else {
      setPhase('editing')
      setFailed(true)
    }
  }
  const dismiss = () => {
    if (phase === 'busy' || phase === 'sent') return
    setPhase('dismissed')
    // Quiet by design: the collapse is immediate; the uplink just informs the
    // server (a lost dismiss is inconsequential — nothing trades).
    void send({ kind: 'draft_action', draftId: frame.draftId, action: 'dismiss' }).catch(() => {})
  }

  if (phase === 'dismissed') {
    return (
      <div class="draft-gone" role="status">
        {t(L, 'draft_dismissed')}
      </div>
    )
  }

  const live = connection.value === 'live'
  const canSubmit = phase === 'editing' && live && sizeValid(size)
  const sideLabel = (frame.direction ?? frame.side).toUpperCase()
  const busyOrSent = phase === 'busy' || phase === 'sent'
  return (
    <div class="ticket draft">
      <div class="th">
        <span class="tt">{frame.title}</span>
        <span class={`side ${frame.side}`}>{sideLabel}</span>
      </div>
      <div class="dpx" aria-live="off">
        <span class="dpsym">{instrument}</span>
        <span class={`dplast${flash ? ' tick' : ''}`}>{price ? price.lastDisplay : '—'}</span>
        {price?.changePct !== undefined && (
          <span class={`dpchg ${price.changePct >= 0 ? 'pos' : 'neg'}`}>
            {price.changePct >= 0 ? '+' : ''}
            {price.changePct.toFixed(2)}%
          </span>
        )}
      </div>
      <div class="dgrid">
        {frame.symbols.length > 1 && (
          <label class="dfield">
            <span class="dlab">{t(L, 'draft_pair')}</span>
            <select
              value={instrument}
              disabled={busyOrSent}
              onChange={(e) => setInstrument((e.target as HTMLSelectElement).value)}
            >
              {frame.symbols.map((s) => (
                <option value={s} key={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        <div class="drow">
          <label class="dfield">
            <span class="dlab">{t(L, 'draft_order_type')}</span>
            <select
              value={orderType}
              disabled={busyOrSent}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value as 'market' | 'limit'
                setOrderType(v)
                // Switching to limit with no price yet: prefill from the live
                // price (raw number — the echo must stay server-parseable).
                if (v === 'limit' && limitPrice.trim() === '' && price) {
                  setLimitPrice(String(price.last))
                }
              }}
            >
              <option value="market">{t(L, 'draft_type_market')}</option>
              <option value="limit">{t(L, 'draft_type_limit')}</option>
            </select>
          </label>
          <label class="dfield">
            <span class="dlab">
              {t(L, 'draft_price')}
              {orderType === 'market' && <span class="dnote"> {t(L, 'draft_price_market')}</span>}
            </span>
            <input
              type="text"
              inputMode="decimal"
              readOnly={orderType === 'market'}
              disabled={busyOrSent}
              value={orderType === 'market' ? (price ? `≈ ${price.lastDisplay}` : '—') : limitPrice}
              onInput={(e) => setLimitPrice((e.target as HTMLInputElement).value)}
              aria-label={t(L, 'draft_price')}
            />
          </label>
        </div>
        <label class="dfield">
          <span class="dlab">
            {t(L, 'draft_size')}
            <span class="dnote"> · {frame.sizeAsset}</span>
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={size}
            disabled={busyOrSent}
            onInput={(e) => setSize((e.target as HTMLInputElement).value)}
            aria-label={`${t(L, 'draft_size')} (${frame.sizeAsset})`}
          />
        </label>
        {protective && (
          <div class="drow">
            <label class="dfield">
              <span class="dlab">{t(L, 'draft_stop_loss')}</span>
              <input
                type="text"
                inputMode="decimal"
                value={stopLossPrice}
                disabled={busyOrSent}
                onInput={(e) => setStopLossPrice((e.target as HTMLInputElement).value)}
                aria-label={t(L, 'draft_stop_loss')}
              />
            </label>
            <label class="dfield">
              <span class="dlab">{t(L, 'draft_take_profit')}</span>
              <input
                type="text"
                inputMode="decimal"
                value={takeProfitPrice}
                disabled={busyOrSent}
                onInput={(e) => setTakeProfitPrice((e.target as HTMLInputElement).value)}
                aria-label={t(L, 'draft_take_profit')}
              />
            </label>
          </div>
        )}
        {perp && (
          <label class="dfield">
            <span class="dlab">
              {t(L, 'draft_leverage')}
              <output class="dlevout">{leverage}×</output>
            </span>
            <input
              type="range"
              min={1}
              max={maxLev}
              step={1}
              value={leverage}
              disabled={busyOrSent}
              onInput={(e) => setLeverage(Number((e.target as HTMLInputElement).value))}
              aria-label={t(L, 'draft_leverage')}
            />
          </label>
        )}
        {perp && frame.marginModes.length > 1 && (
          <label class="dfield">
            <span class="dlab">{t(L, 'draft_margin')}</span>
            <select
              value={marginMode}
              disabled={busyOrSent}
              onChange={(e) =>
                setMarginMode((e.target as HTMLSelectElement).value as 'isolated' | 'cross')
              }
            >
              {frame.marginModes.map((m) => (
                <option value={m} key={m}>
                  {t(L, m === 'isolated' ? 'draft_margin_isolated' : 'draft_margin_cross')}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <button
        type="button"
        class="cta"
        disabled={!canSubmit}
        aria-busy={phase === 'busy'}
        title={!live && phase === 'editing' ? t(L, 'ticket_offline_hint') : undefined}
        onClick={() => void submit()}
      >
        {phase === 'sent' ? t(L, 'draft_sent') : phase === 'busy' ? t(L, 'confirming') : frame.cta}
      </button>
      {failed && <div class="action-failed">{t(L, 'action_failed')}</div>}
      {phase === 'editing' && (
        <button type="button" class="ddismiss" onClick={dismiss}>
          {t(L, 'draft_dismiss')}
        </button>
      )}
      {frame.footnote && <div class="tfoot">{frame.footnote}</div>}
    </div>
  )
}

/**
 * One card tells the whole order journey (the store collapses lifecycle
 * frames by ticketId; the panel keys the card by ticket so updates never
 * remount). Everything drawn here is wire truth: the journey line advances
 * only on real server frames, the fill bar's width IS the server's fillPct,
 * and unknown future stages degrade to the bare pulse row.
 */
function LifecycleCard({ frame }: { frame: Lifecycle }) {
  const [cancelFailed, setCancelFailed] = useState(false)
  const L = locale.value

  if (isInFlight(frame.phase)) {
    const steps = journeySteps(frame.phase, frame.stage)
    const affordance = cancelAffordance(frame.phase, frame.stage, frame.cancellable)
    const fill = fillMeter(frame.fillPct)
    const cancel = async () => {
      setCancelFailed(false)
      const ok = await send({ kind: 'ticket_action', ticketId: frame.ticketId, action: 'cancel' })
      if (!ok) setCancelFailed(true)
    }
    return (
      <div class={`ticket${frame.phase === 'partial' ? ' part' : ''}`}>
        {steps && (
          <div class="journey" aria-hidden="true">
            {steps.map((s) => (
              <span class={`stp ${s.state}`} key={s.key}>
                {s.state === 'done' && <span class="tick">✓</span>}
                {s.state === 'active' && <span class="pulse" />}
                {t(L, s.labelKey)}
              </span>
            ))}
          </div>
        )}
        {/* Screen readers hear every server status change as it lands. */}
        <div class="await" role="status" aria-live="polite">
          {!steps && <span class="pulse" />}
          {affordance === 'pending' && steps && <span class="pulse" />}
          {frame.statusLine}
          {affordance === 'button' && (
            <button
              type="button"
              class="cxl"
              disabled={connection.value !== 'live'}
              title={connection.value !== 'live' ? t(L, 'ticket_offline_hint') : undefined}
              onClick={cancel}
            >
              CANCEL
            </button>
          )}
        </div>
        {/* The server's own rows, drawn verbatim: on a partial this is where
            the fill quantity lives, in the SERVER's language. The meter below
            never reconstructs that money into a caption. */}
        {frame.rows.length > 0 && (
          <div class="tb">
            {frame.rows.map((r) => (
              <div class="trow" key={r.label}>
                <span class="lab">{r.label}</span>
                <b>{r.value}</b>
              </div>
            ))}
          </div>
        )}
        {fill && (
          <div class="fillwrap">
            <div class="fillmeta">
              {/* Chrome label (localized) + the server's percentage — no money. */}
              <span>{t(L, 'journey_filled')}</span>
              <span class="pct">{fill.pct}</span>
            </div>
            <div class="fillbar">
              {/* Width is the server's number — the bar never animates toward a guess. */}
              <span style={{ width: `${frame.fillPct}%` }} />
            </div>
          </div>
        )}
        {cancelFailed && <div class="action-failed">{t(L, 'action_failed')}</div>}
        <div class="oid">{t(L, 'live_updates')}</div>
      </div>
    )
  }

  // Terminal: a receipt of facts. State modifiers follow the prototype —
  // green only for fills, neutral grey for cancelled (no judgment), amber
  // attention for expired.
  const badge = sideBadge(frame.phase, frame.side)
  const stateCls = ticketStateClass(frame.phase)
  return (
    <div class={`ticket${stateCls ? ` ${stateCls}` : ''}`}>
      <div class="th">
        {/* The server described this completed trade — draw its words. The
            localized "Order filled" is only the fallback for a filled frame
            that arrived without a statusLine. */}
        <span class="tt">{terminalTitle(frame.phase, frame.statusLine, t(L, 'order_filled'))}</span>
        <span class={badge.cls}>{badge.text}</span>
      </div>
      {frame.rows.length > 0 && (
        <div class="tb">
          {frame.rows.map((r) => (
            <div class="trow" key={r.label}>
              <span class="lab">{r.label}</span>
              <b>{r.value}</b>
            </div>
          ))}
        </div>
      )}
      {frame.venueOrderId && <div class="oid">VENUE ORDER · {frame.venueOrderId}</div>}
    </div>
  )
}

function AdviceDeclineCard({ frame }: { frame: AdviceDecline }) {
  return (
    <div class="decline">
      <div class="dchead">
        <span class="dcbadge">{frame.badge}</span>
      </div>
      <div class="body">
        <p>{frame.message}</p>
        <div class="pivot">{frame.pivotTitle}</div>
        <div class="facts">
          {frame.facts.map((f) => (
            <div class="fact" key={f.text}>
              <span class="fi">{f.icon}</span>
              <div>{f.text}</div>
            </div>
          ))}
        </div>
        {frame.followups.length > 0 && (
          <div class="chips" style="border-top:0;padding:10px 0 0">
            {frame.followups.map((q) => (
              <button
                type="button"
                class="chip"
                key={q}
                onClick={() => void dispatch({ kind: 'chip_tap', text: q })}
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PositionsCard({ frame }: { frame: Positions }) {
  const L = locale.value
  return (
    <div class="bubble">
      <div class="eyebrow">
        <span>POSITIONS</span>
      </div>
      {frame.rows.length === 0 ? (
        // Empty rows are ambiguous (flat account, failed fetch, partial venue
        // answer) — so the card never says the account is flat. Server text
        // when it authored one; otherwise a neutral line that claims nothing.
        <div class="pos-row">
          <span class="dim">{positionsEmptyText(frame.emptyText, t(L, 'positions_empty'))}</span>
        </div>
      ) : (
        frame.rows.map((r) => (
          <div class="pos-row" key={r.instrument}>
            <span>{r.instrument}</span>
            <span>{r.size}</span>
            <span class={r.tone}>{r.pnl}</span>
          </div>
        ))
      )}
    </div>
  )
}

function RejectionCard({ frame }: { frame: RejectionTicket }) {
  return (
    <div class="ticket err">
      <div class="th">
        <span class="tt">{frame.title}</span>
        <span class="side sell">REJECTED</span>
      </div>
      <div class="tb">
        <p class="errbody">{frame.reason}</p>
      </div>
      {frame.fix && (
        <button
          type="button"
          class="cta"
          onClick={() => void dispatch({ kind: 'chip_tap', text: frame.fix?.action ?? '' })}
        >
          {frame.fix.label}
        </button>
      )}
    </div>
  )
}

/**
 * Stage-1 "understanding" — a persistent, collapsible card that sits above the
 * answer (research-view style). Collapsed by default: the trader sees the
 * summary, taps to expand the reasoning + which memory scopes were applied.
 * Everything shown is server-authored (thin-client); the SDK only draws.
 */
function InterpretationCard({ frame }: { frame: Interpretation }) {
  const [open, setOpen] = useState(false)
  const L = locale.value
  const hasDetail = Boolean(frame.detail) || frame.memoryScopes.length > 0
  return (
    <div class={`interp${open ? ' open' : ''}`}>
      <button
        type="button"
        class="interp-head"
        aria-expanded={open}
        disabled={!hasDetail}
        onClick={() => hasDetail && setOpen((v) => !v)}
      >
        {hasDetail && <span class="interp-caret">{open ? '▾' : '▸'}</span>}
        <span class="interp-eyebrow">{t(L, 'understood')}</span>
        <span class="interp-summary">{frame.summary}</span>
      </button>
      {open && hasDetail && (
        <div class="interp-body">
          {frame.detail && <p>{frame.detail}</p>}
          {frame.memoryScopes.length > 0 && (
            <div class="interp-scopes">
              {t(L, 'memory_applied')}
              {frame.memoryScopes.map((s) => (
                <span class="interp-scope" key={s}>
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ThinkingCard({ frame }: { frame: Thinking }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (frame.lines.length < 2) return
    const t = setInterval(() => setI((n) => (n + 1) % frame.lines.length), 1200)
    return () => clearInterval(t)
  }, [frame.lines.length])
  return (
    <div class="think">
      <span class="dot" />
      {frame.lines[i % frame.lines.length]}
    </div>
  )
}

function SkeletonCard({ frame }: { frame: Skeleton }) {
  return (
    <div class="bubble" aria-hidden="true">
      <div class="sk sk-title" />
      <div class="sk sk-line" />
      <div class="sk sk-line short" />
      {frame.shape === 'brief' && (
        <div class="sk-grid">
          <div class="sk sk-cell" />
          <div class="sk sk-cell" />
          <div class="sk sk-cell" />
        </div>
      )}
      {frame.shape === 'ticket' && (
        <>
          <div class="sk sk-line" />
          <div class="sk sk-cta" />
        </>
      )}
    </div>
  )
}

/** Streaming research prose: the growing text that fills the skeleton while
 * the research engine generates. state.ts accumulates consecutive
 * brief_delta frames into one; the final research_brief replaces this card. */
function StreamingBriefCard({ frame }: { frame: BriefDelta }) {
  // The watchdog (state.ts) marks a delta interrupted when its stream stalls
  // — deltas stopped and the authoritative brief never came. Finalize
  // honestly: drop the ● LIVE + blinking cursor and say the brief was cut
  // off, rather than blinking forever on a dead stream.
  const interrupted = interruptedStreamIds.value.has(frame.id)
  return (
    <div class="bubble">
      <div class="eyebrow">
        <span>MARKET BRIEF</span>
        <span class="eyebrow-right">
          {!interrupted && <span class="live">● LIVE</span>}
          {frame.model && <span class="model-tag">{frame.model}</span>}
        </span>
      </div>
      <p class="stream-text">
        {frame.text}
        {!interrupted && <span class="stream-cursor" aria-hidden="true" />}
      </p>
      {interrupted && (
        <div class="stream-cut" role="status">
          ⚠ BRIEF INTERRUPTED — the connection dropped before it finished. Ask again for a complete
          answer.
        </div>
      )}
    </div>
  )
}

/** Kind glyph for a file chip / row — a CSV grid vs an image frame. Mono
 * currentColor so CSS drives the tone, like the composer paperclip. */
export function fileGlyph(kind?: 'csv' | 'image'): string {
  return kind === 'image' ? '▦' : '▤'
}

/**
 * Upload journey chip — the server-side phases of an uploaded file (the
 * client's own byte-progress bar lives in the composer; these frames take
 * over once the gateway has the bytes). One chip per file: the store
 * collapses upload_status frames in place by fileId, and the panel keys the
 * chip by file so phase changes never remount. `analyzing` gets a distinct
 * indeterminate treatment (shimmer across the chip); the TERMINAL phases
 * (`analyzed` / `failed`) are journaled, so this chip is the file's lasting
 * thread presence — it survives reload/resume. The analysis answer itself
 * arrives as a normal research_brief below.
 */
function UploadStatusCard({ frame }: { frame: UploadStatus }) {
  const L = locale.value
  const failed = frame.phase === 'failed'
  const analyzing = frame.phase === 'analyzing'
  const analyzed = frame.phase === 'analyzed'
  const phaseLabel = failed
    ? t(L, 'upload_failed')
    : analyzed
      ? t(L, 'upload_analyzed')
      : analyzing
        ? t(L, 'upload_analyzing')
        : t(L, 'upload_received')
  return (
    <div
      class={`upchip${analyzing ? ' analyzing' : ''}${analyzed ? ' analyzed' : ''}${failed ? ' failed' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span class="upicon" aria-hidden="true">
        {fileGlyph(frame.kind)}
      </span>
      <span class="upname">{frame.name}</span>
      <span class="upsize">{frame.sizeDisplay}</span>
      <span class="upphase">
        {analyzing && <span class="pulse" aria-hidden="true" />}
        {phaseLabel}
      </span>
      {failed && frame.reason && <span class="upreason">{frame.reason}</span>}
    </div>
  )
}

function BannerCard({ frame }: { frame: Banner }) {
  return (
    <div class={`banner ${frame.kind}`}>
      <div>
        <b>{frame.title}</b>
        {frame.text}
      </div>
    </div>
  )
}

function UserEchoCard({ frame }: { frame: UserEcho }) {
  return <div class="umsg">{frame.text}</div>
}

const HOST_ACTION_PHASE_KEY: Record<HostActionPhase, MessageKey> = {
  pending: 'host_action_pending',
  applied: 'host_action_applied',
  failed: 'host_action_failed',
  timeout: 'host_action_timeout',
}

/** The chip's note — server-authored when present, else composed from the
 * action so an older gateway that omits `note` still reads clearly. For any
 * verb beyond the legacy chart trio the gateway always authors `note`; the
 * humanized-slug fallback below is a defensive last resort (a verb slug is
 * wire data, not translatable chrome — nothing here enters the catalog). */
function hostActionNote(frame: HostAction, L: Locale): string {
  if (frame.note) return frame.note
  const ind = (frame.indicator ?? '').toUpperCase()
  if (frame.action === 'set_timeframe')
    return `${t(L, 'host_action_chart')} → ${frame.timeframe ?? ''}`
  if (frame.action === 'remove_indicator') return `${t(L, 'host_action_indicator')} ✕ ${ind}`
  if (frame.action === 'apply_indicator') return `${t(L, 'host_action_indicator')} → ${ind}`
  return frame.action.replaceAll('_', ' ')
}

/**
 * Host page-control chip — reflects a host_action the SDK forwarded to the host
 * page (state.ts posts the message + arms the timeout; the phase lives in the
 * hostActionMap signal so it survives minimize/reopen). The SDK never touches
 * the chart — this chip only mirrors what the page reported back:
 * pending → applied ✓ / "host didn't apply this" (+reason) / "no response".
 */
function HostActionCard({ frame }: { frame: HostAction }) {
  const L = locale.value
  const st = hostActionMap.value[frame.actionId] ?? { phase: 'pending' as const }
  const phaseLabel = t(L, HOST_ACTION_PHASE_KEY[st.phase])
  return (
    <div class={`hostact ${st.phase}`} role="status" aria-live="polite">
      <span class="haicon" aria-hidden="true">
        ◈
      </span>
      <span class="hanote">{hostActionNote(frame, L)}</span>
      <span class="haphase">
        {st.phase === 'pending' && <span class="pulse" aria-hidden="true" />}
        {phaseLabel}
        {st.phase === 'failed' && st.reason ? ` · ${st.reason}` : ''}
      </span>
    </div>
  )
}

/**
 * Consolidated orders card — the full "show my orders" answer (scope + totals +
 * per-order rows), distinct from the compact open-orders pill (OrdersSnapshot).
 * Presentation logic (scope label, totals, newest-first ordering, empty state)
 * lives in orders-summary.ts; this only draws, reusing .oside / .fillbar so it
 * reads like the rest of the order UI.
 */
function OrdersSummaryCard({ frame }: { frame: OrdersSummary }) {
  const L = locale.value
  const rows = orderedRows(frame.orders)
  return (
    <div class="osumm">
      <div class="osumm-hd">
        <span class="osumm-scope">{t(L, scopeLabelKey(frame.scope))}</span>
        <span class="osumm-totals">
          {totalCells(frame.totals).map((c) => (
            <span class="osumm-total" key={c.key}>
              <b>{c.value}</b> {t(L, c.key)}
            </span>
          ))}
        </span>
      </div>
      {rows.length === 0 ? (
        <div class="osumm-empty">{t(L, emptyLabelKey(frame.scope))}</div>
      ) : (
        <div class="osumm-list">
          {rows.map((o) => (
            <div class="osumm-row" key={o.orderId}>
              <div class="osumm-line">
                <span class={`oside ${o.side}`}>{o.side === 'buy' ? 'BUY' : 'SELL'}</span>
                <span class="osumm-sym">{o.symbol}</span>
                <span class="osumm-kind">{o.kind}</span>
                <span class="osumm-qty">{o.qty}</span>
                {o.price && <span class="osumm-price">{o.price}</span>}
                <span class="osumm-status">{o.status}</span>
              </div>
              {hasFill(o.filledPct) && (
                <div class="fillbar osumm-fill">
                  {/* Width IS the server's fillPct — the bar never guesses. */}
                  <span style={{ width: `${o.filledPct}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Price alert card — one alert's current state, updated in place (the store
 * collapses alert frames by alertId; the panel keys the card by alert, so a
 * state change never remounts). `conditionLabel` and `note` are SERVER-
 * authored and rendered verbatim — the SDK never re-formats or recomputes a
 * condition. Only armed cards carry the CANCEL chip; like ticket actions it
 * rides transport `send` (live-only, never queued) and fails loud.
 */
function AlertCard({ frame }: { frame: Alert }) {
  const L = locale.value
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const cancel = async () => {
    if (busy) return
    setFailed(false)
    setBusy(true)
    const ok = await send(cancelAlertUplink(frame.alertId))
    setBusy(false)
    if (!ok) setFailed(true)
    // Success stays quiet — the server's `cancelled` alert frame is the
    // response and swaps this card's state in place.
  }
  return (
    <div class={`alertcard ${alertStateClass(frame.state)}`}>
      <div class="alhd">
        <span class="aleyebrow">{t(L, 'alert_eyebrow')}</span>
        <span class="albadge">
          {frame.state === 'armed' && <span class="pulse" aria-hidden="true" />}
          {t(L, ALERT_STATE_KEY[frame.state])}
        </span>
      </div>
      <div class="albody">
        <span class="alsym">{frame.symbol}</span>
        <span class="alcond">{frame.conditionLabel}</span>
      </div>
      {frame.note && <div class="alnote">{frame.note}</div>}
      {showCancelChip(frame.state) && (
        <button
          type="button"
          class="alcancel"
          disabled={busy || connection.value !== 'live'}
          aria-busy={busy}
          title={connection.value !== 'live' ? t(L, 'ticket_offline_hint') : undefined}
          onClick={() => void cancel()}
        >
          {busy ? t(L, 'confirming') : t(L, 'alert_cancel')}
        </button>
      )}
      {failed && <div class="action-failed">{t(L, 'action_failed')}</div>}
    </div>
  )
}

/**
 * Clarification card — the server ASKING instead of guessing, so this must
 * never read as an answer: its own eyebrow, its own question mark, a dashed
 * amber edge, and no brief/ticket chrome anywhere on it.
 *
 * `question`, `options[].label/hint`, `originalText` and `note` are all
 * SERVER-AUTHORED and rendered VERBATIM — the SDK never invents or re-words an
 * interpretation (stop-line law). A tap sends only the option's ID.
 *
 * One-shot: the pick lives in the clarificationMap signal (survives
 * minimize/reopen and journal replay), and pickOption refuses a second tap
 * before it sends anything. Like ticket and alert actions this rides transport
 * `send` — live-only, never the offline outbox — so a disconnected panel
 * disables the options and says why rather than queueing a stale answer.
 */
function ClarificationCard({ frame }: { frame: Clarification }) {
  const L = locale.value
  const st = clarificationState(frame.clarificationId)
  const chosen = chosenOptionId(st)
  const chosenLabel = chosen ? frame.options.find((o) => o.id === chosen)?.label : undefined
  const offline = connection.value !== 'live'
  const busy = st.phase === 'sending'
  const answerable = isAnswerable(st)
  return (
    <div class={`clarify${answerable ? '' : ' settled'}`}>
      <div class="clhd">
        <span class="cleyebrow">{t(L, 'clarify_eyebrow')}</span>
        <span class="clmark" aria-hidden="true">
          ?
        </span>
      </div>
      <div class="clq">{frame.question}</div>
      {frame.originalText && (
        <div class="clsaid">
          <span class="clsaid-label">{t(L, 'clarify_you_said')}</span>
          <span class="clsaid-text">“{frame.originalText}”</span>
        </div>
      )}
      {answerable || !chosenLabel ? (
        // No group role: each option is a button whose own label is the whole
        // answer, and the question is the visible line directly above it.
        <div class="clopts">
          {frame.options.map((o) => (
            <button
              type="button"
              class="clopt"
              key={o.id}
              disabled={busy || offline || !answerable}
              aria-busy={busy && chosen === o.id}
              title={offline ? t(L, 'clarify_offline_hint') : undefined}
              onClick={() => void pickOption(frame.clarificationId, o.id, send)}
            >
              <span class="clopt-label">{o.label}</span>
              {o.hint && <span class="clopt-hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      ) : (
        // Read-back: the transcript must show what was decided, not just that
        // something was. The server re-states it on the next card too.
        <div class="clchosen">
          <span class="clchosen-label">{t(L, 'clarify_chosen')}</span>
          <span class="clchosen-text">{chosenLabel}</span>
        </div>
      )}
      {busy && <div class="clsending">{t(L, 'clarify_sending')}</div>}
      {st.phase === 'failed' && <div class="action-failed">{t(L, 'clarify_failed')}</div>}
      {frame.note && <div class="clnote">{frame.note}</div>}
    </div>
  )
}

export function FallbackCard({ frame }: { frame: UnknownFrame }) {
  const fb = frame.fallback
  if (!fb) return null
  return (
    <div class="fallback">
      <p>
        {fb.text}{' '}
        {fb.href && (
          <a href={fb.href} target="_blank" rel="noreferrer">
            Open →
          </a>
        )}
      </p>
    </div>
  )
}

export function renderFrame(frame: Frame): JSX.Element | null {
  switch (frame.type) {
    case 'research_brief':
      return <ResearchBriefCard frame={frame} />
    case 'order_ticket':
      return <OrderTicketCard frame={frame} />
    case 'order_draft':
      return <OrderDraftCard frame={frame} />
    case 'lifecycle':
      return <LifecycleCard frame={frame} />
    case 'advice_decline':
      return <AdviceDeclineCard frame={frame} />
    case 'positions':
      return <PositionsCard frame={frame} />
    case 'rejection_ticket':
      return <RejectionCard frame={frame} />
    case 'thinking':
      return <ThinkingCard frame={frame} />
    case 'interpretation':
      return <InterpretationCard frame={frame} />
    case 'skeleton':
      return <SkeletonCard frame={frame} />
    case 'brief_delta':
      return <StreamingBriefCard frame={frame} />
    case 'banner':
      return <BannerCard frame={frame} />
    case 'upload_status':
      return <UploadStatusCard frame={frame} />
    case 'user_echo':
      return <UserEchoCard frame={frame} />
    case 'host_action':
      return <HostActionCard frame={frame} />
    case 'orders_summary':
      return <OrdersSummaryCard frame={frame} />
    case 'alert':
      return <AlertCard frame={frame} />
    case 'clarification':
      return <ClarificationCard frame={frame} />
    default:
      return null // orders_snapshot, pulse, price_tick, learned_memory & identity are handled by stores, never rendered in-thread
  }
}
