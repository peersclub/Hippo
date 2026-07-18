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
import { isStale, STALE_CHECK_INTERVAL_MS } from './freshness.js'
import { t } from './i18n.js'
import { dispatch } from './outbox.js'
import { briefClipboardText, COPIED_FLASH_MS } from './share.js'
import { connection, feedbackMap, locale, shareFrame } from './state.js'
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

function LiveBarRow({ frame }: { frame: ResearchBrief }) {
  const lb = frame.liveBar
  // Feedback lives in a keyed signal map (not component state) so "already
  // gave feedback" survives minimize/reopen; the reducer's terminal states
  // guarantee replays can't double-send.
  const fb = feedbackMap.value[frame.id] ?? { phase: 'idle' as const }
  const [flash, setFlash] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef(0)
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  // Stale data is declared, never silent (edge state №5): past the threshold
  // the as-of turns amber and REFRESH becomes the loudest element.
  const [stale, setStale] = useState(() => (lb ? isStale(lb.asOfIso) : false))
  useEffect(() => {
    if (!lb) return
    const check = () => setStale(isStale(lb.asOfIso))
    check()
    const t = setInterval(check, STALE_CHECK_INTERVAL_MS)
    return () => clearInterval(t)
  }, [lb])
  if (!lb) return null
  const refresh = () => {
    setFlash(true)
    setTimeout(() => setFlash(false), 900)
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
        <span class={`asof${flash ? ' flash' : ''}`}>{lb.asOf}</span>
        {lb.refreshable && (
          <button type="button" class="rf" onClick={refresh}>
            ↻ REFRESH
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
                  👍
                </button>
                <button
                  type="button"
                  aria-label={t(locale.value, 'feedback_not_helpful')}
                  onClick={() => applyFeedback({ type: 'vote', vote: 'down' })}
                >
                  👎
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
        {frame.live && <span class="live">● LIVE</span>}
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
          later without the trader present is unacceptable. Offline: fail loud. */}
      <button
        type="button"
        class="cta"
        disabled={connection.value !== 'live'}
        title={connection.value !== 'live' ? t(locale.value, 'ticket_offline_hint') : undefined}
        onClick={() =>
          send({ kind: 'ticket_action', ticketId: frame.ticketId, action: 'confirm_handoff' })
        }
      >
        {frame.cta}
      </button>
      <div class="tfoot">{frame.footnote}</div>
    </div>
  )
}

function LifecycleCard({ frame }: { frame: Lifecycle }) {
  if (frame.phase === 'awaiting_confirm') {
    return (
      <div class="ticket">
        <div class="await">
          <span class="pulse" />
          {frame.statusLine}
          {frame.cancellable && (
            <button
              type="button"
              class="cxl"
              disabled={connection.value !== 'live'}
              title={
                connection.value !== 'live' ? t(locale.value, 'ticket_offline_hint') : undefined
              }
              onClick={() =>
                send({ kind: 'ticket_action', ticketId: frame.ticketId, action: 'cancel' })
              }
            >
              CANCEL
            </button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div class={`ticket${frame.phase === 'filled' ? ' ok' : ''}`}>
      <div class="th">
        <span class="tt">
          {frame.phase === 'filled' ? t(locale.value, 'order_filled') : frame.statusLine}
        </span>
        <span class="side buy">{frame.phase.toUpperCase()}</span>
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
      {frame.rows.map((r) => (
        <div class="pos-row" key={r.instrument}>
          <span>{r.instrument}</span>
          <span>{r.size}</span>
          <span class={r.tone}>{r.pnl}</span>
        </div>
      ))}
    </div>
  )
}

function RejectionCard({ frame }: { frame: RejectionTicket }) {
  return (
    <div class="ticket" style="border-color:rgba(255,133,133,.45)">
      <div class="th">
        <span class="tt">{frame.title}</span>
        <span class="side sell">REJECTED</span>
      </div>
      <div class="tb">
        <p style="font-size:12px;line-height:1.5;color:#E8B8B8;padding:8px 0">{frame.reason}</p>
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
    </div>
  )
}

/** Streaming research prose: the growing text that fills the skeleton while
 * the research engine generates. state.ts accumulates consecutive
 * brief_delta frames into one; the final research_brief replaces this card. */
function StreamingBriefCard({ frame }: { frame: BriefDelta }) {
  return (
    <div class="bubble">
      <div class="eyebrow">
        <span>MARKET BRIEF</span>
        <span class="live">● LIVE</span>
      </div>
      <p class="stream-text">
        {frame.text}
        <span class="stream-cursor" aria-hidden="true" />
      </p>
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
