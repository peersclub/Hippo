/**
 * Card registry — one Preact component per protocol card type.
 * Cards are pure: props in, DOM out. Unknown types render <FallbackCard/>.
 */
import type {
  AdviceDecline,
  Banner,
  BriefDelta,
  Frame,
  Lifecycle,
  OrderTicket,
  Positions,
  RejectionTicket,
  ResearchBrief,
  Skeleton,
  Thinking,
  UnknownFrame,
  UserEcho,
} from '@hippo/protocol'
import type { JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  FEEDBACK_REASONS,
  type FeedbackEvent,
  feedbackDoneLabel,
  feedbackTransition,
} from './feedback.js'
import { isStale, LANDED_FLASH_MS, STALE_CHECK_INTERVAL_MS, staleAgeLabel } from './freshness.js'
import { t } from './i18n.js'
import {
  cancelAffordance,
  fillCaption,
  isInFlight,
  journeySteps,
  sideBadge,
  ticketStateClass,
} from './lifecycle-view.js'
import { dispatch } from './outbox.js'
import { briefClipboardText, COPIED_FLASH_MS } from './share.js'
import { connection, feedbackMap, locale, shareFrame, thread } from './state.js'
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
  }
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
      {/* ticket_action is deliberately NOT queueable — a confirm fired minutes
          later without the trader present is unacceptable. Offline: fail loud.
          `busy` reflects the real uplink round-trip; `handedOff` is wire truth. */}
      <button
        type="button"
        class="cta"
        disabled={busy || handedOff || connection.value !== 'live'}
        aria-busy={busy}
        title={connection.value !== 'live' ? t(locale.value, 'ticket_offline_hint') : undefined}
        onClick={confirm}
      >
        {handedOff
          ? t(locale.value, 'handed_off')
          : busy
            ? t(locale.value, 'confirming')
            : frame.cta}
      </button>
      {failed && <div class="action-failed">{t(locale.value, 'action_failed')}</div>}
      <div class="tfoot">{frame.footnote}</div>
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
    const fill = fillCaption(frame.rows, frame.fillPct)
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
        {fill && (
          <div class="fillwrap">
            <div class="fillmeta">
              <span>{fill.left}</span>
              <span class="pct">{fill.right}</span>
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
        <span class="tt">{frame.phase === 'filled' ? t(L, 'order_filled') : frame.statusLine}</span>
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
  return (
    <div class="bubble">
      <div class="eyebrow">
        <span>POSITIONS</span>
      </div>
      {frame.rows.length === 0 ? (
        // Honest empty state — a fresh account has no positions; nothing is
        // ever fabricated to fill the card.
        <div class="pos-row">
          <span class="dim">No open positions yet — trades you place appear here live.</span>
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
    case 'skeleton':
      return <SkeletonCard frame={frame} />
    case 'brief_delta':
      return <StreamingBriefCard frame={frame} />
    case 'banner':
      return <BannerCard frame={frame} />
    case 'user_echo':
      return <UserEchoCard frame={frame} />
    default:
      return null // orders_snapshot & pulse are handled by stores, never rendered in-thread
  }
}
