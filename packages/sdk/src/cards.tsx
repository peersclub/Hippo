/**
 * Card registry — one Preact component per protocol card type.
 * Cards are pure: props in, DOM out. Unknown types render <FallbackCard/>.
 */
import type {
  AdviceDecline,
  Banner,
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
import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { send } from './transport.js'

function SparklineSvg({ points }: { points: number[] }) {
  const max = Math.max(...points)
  const min = Math.min(...points)
  const span = max - min || 1
  const step = 300 / (points.length - 1)
  const y = (p: number) => 44 - ((p - min) / span) * 40
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(p).toFixed(1)}`).join(' ')
  return (
    <svg class="spark" viewBox="0 0 300 48" preserveAspectRatio="none" aria-hidden="true">
      <path class="fill" d={`${line} L300,48 L0,48 Z`} />
      <path class="line" d={line} />
    </svg>
  )
}

function LiveBarRow({ frame }: { frame: ResearchBrief }) {
  const lb = frame.liveBar
  const [voted, setVoted] = useState<null | 'up' | 'down'>(null)
  const [flash, setFlash] = useState(false)
  if (!lb) return null
  const refresh = () => {
    setFlash(true)
    setTimeout(() => setFlash(false), 900)
    send({ kind: 'chip_tap', text: `refresh:${frame.id}` })
  }
  const vote = (v: 'up' | 'down') => {
    setVoted(v)
    send({ kind: 'feedback', frameId: frame.id, vote: v })
  }
  return (
    <div class="livebar">
      <span class={`asof${flash ? ' flash' : ''}`}>{lb.asOf}</span>
      {lb.refreshable && <button type="button" onClick={refresh}>↻ REFRESH</button>}
      {lb.shareable && <button type="button">↗ SHARE</button>}
      {lb.feedback && (
        <span class="fb">
          {voted ? (
            <span class="done">{voted === 'up' ? 'THANKS' : 'NOTED'}</span>
          ) : (
            <>
              <button type="button" aria-label="Helpful" onClick={() => vote('up')}>👍</button>
              <button type="button" aria-label="Not helpful" onClick={() => vote('down')}>👎</button>
            </>
          )}
        </span>
      )}
    </div>
  )
}

function ResearchBriefCard({ frame }: { frame: ResearchBrief }) {
  return (
    <div class="bubble">
      <div class="eyebrow">
        <span>{frame.eyebrow}</span>
        {frame.live && <span class="live">● LIVE</span>}
      </div>
      {frame.liveBar?.cached && <span class="cache-badge">CACHED BRIEF · {frame.liveBar.cacheAge}</span>}
      <h3>{frame.headline}</h3>
      {frame.paragraphs.map((p) => (
        <p key={p}>{p}</p>
      ))}
      {frame.stats.length > 0 && (
        <div class="kv">
          {frame.stats.map((s) => (
            <div key={s.k}>
              <span class="k">{s.k}</span>
              <span class={`v ${s.tone === 'neg' ? 'neg' : s.tone === 'pos' ? 'pos' : ''}`}>{s.v}</span>
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
            <span class="src" key={s}>{s}</span>
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
      <button
        type="button"
        class="cta"
        onClick={() => send({ kind: 'ticket_action', ticketId: frame.ticketId, action: 'confirm_handoff' })}
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
              onClick={() => send({ kind: 'ticket_action', ticketId: frame.ticketId, action: 'cancel' })}
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
        <span class="tt">{frame.phase === 'filled' ? 'Order filled' : frame.statusLine}</span>
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
              <button type="button" class="chip" key={q} onClick={() => send({ kind: 'chip_tap', text: q })}>
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
      <div class="eyebrow"><span>POSITIONS</span></div>
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
        <button type="button" class="cta" onClick={() => send({ kind: 'chip_tap', text: frame.fix?.action ?? '' })}>
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
          <div class="sk sk-cell" /><div class="sk sk-cell" /><div class="sk sk-cell" />
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
        {fb.text} {fb.href && <a href={fb.href} target="_blank" rel="noreferrer">Open →</a>}
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
    case 'banner':
      return <BannerCard frame={frame} />
    case 'user_echo':
      return <UserEchoCard frame={frame} />
    default:
      return null // orders_snapshot & pulse are handled by stores, never rendered in-thread
  }
}
