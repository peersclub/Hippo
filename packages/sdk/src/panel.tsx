/**
 * Stage-2 panel — Preact app rendered into the loader's closed shadow root.
 * Server-driven: everything in the thread is a protocol frame; the panel
 * decides nothing about content or timing.
 */
import { type ComponentChildren, render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { FallbackCard, renderFrame } from './cards.js'
import {
  clearPulse,
  connection,
  openOrderCount,
  orders,
  posture,
  pulseTag,
  suggestedQueries,
  thread,
  venueName,
} from './state.js'
import { panelCss } from './styles.js'
import { connect, send } from './transport.js'

type MountOpts = {
  shadow: ShadowRoot
  pill: HTMLButtonElement
  config: { key: string; gateway: string; panelUrl: string }
}

function Composer() {
  const [text, setText] = useState('')
  const submit = (e: Event) => {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    send({ kind: 'user_text', text: t })
    setText('')
  }
  return (
    <form class="composer" onSubmit={submit}>
      <input
        value={text}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        placeholder="Ask about any market…"
        aria-label="Ask Hippo"
      />
      <button type="submit" class="send" aria-label="Send">↑</button>
    </form>
  )
}

function OrdersStrip() {
  const snap = orders.value
  if (!snap) return null
  return (
    <div class="orders">
      <div class="lab">
        <span>
          OPEN ORDERS <span class="cnt">· {openOrderCount.value}</span>
        </span>
        <span>POSITIONS · {snap.positionsCount}</span>
      </div>
      <div class="row">
        {snap.open.map((o) => (
          <div class={`opill ${o.side}`} key={o.orderId}>
            <span class="sd" />
            {o.summary} <span class="st">{o.status}</span>
          </div>
        ))}
        <button type="button" class="opill new" onClick={() => send({ kind: 'chip_tap', text: 'new order' })}>
          + New order
        </button>
      </div>
    </div>
  )
}

function Thread() {
  const ref = useRef<HTMLDivElement>(null)
  const items = thread.value
  useEffect(() => {
    // The thread always rests at the newest message.
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [items.length])
  return (
    <div class="thread" ref={ref}>
      {items.map((item) =>
        item.kind === 'frame' ? (
          <FrameWrap key={item.frame.id}>{renderFrame(item.frame)}</FrameWrap>
        ) : (
          <FallbackCard key={item.frame.id} frame={item.frame} />
        ),
      )}
      {connection.value === 'offline' && (
        <div class="banner offline">
          <div>
            <b>CONNECTION LOST</b>
            Reconnecting — your thread is safe, and nothing you typed is lost.
          </div>
        </div>
      )}
    </div>
  )
}

function FrameWrap({ children }: { children: ComponentChildren }) {
  return <>{children}</>
}

function Chips() {
  const chips = suggestedQueries.value
  if (chips.length === 0) return null
  return (
    <div class="chips">
      {chips.map((q) => (
        <button type="button" class="chip" key={q} onClick={() => send({ kind: 'chip_tap', text: q })}>
          {q}
        </button>
      ))}
    </div>
  )
}

function Panel({ onMinimize }: { onMinimize: () => void }) {
  const max = posture.value === 'max'
  return (
    <div class={`panel${max ? ' max' : ''}`}>
      <div class="hd">
        <span class="mark">H</span>
        <div class="name">
          Ask Hippo
          <small>MARKET INTELLIGENCE</small>
        </div>
        <div class="ctl">
          <button type="button" title="Settings" aria-label="Settings">⚙</button>
          <button
            type="button"
            title={max ? 'Dock panel' : 'Expand panel'}
            aria-label={max ? 'Dock panel' : 'Expand panel'}
            onClick={() => {
              posture.value = max ? 'dock' : 'max'
            }}
          >
            ⤢
          </button>
          <button type="button" title="Minimize" aria-label="Minimize" onClick={onMinimize}>
            —
          </button>
        </div>
      </div>
      <OrdersStrip />
      <Thread />
      <Chips />
      <Composer />
    </div>
  )
}

export function mountPanel({ shadow, pill, config }: MountOpts) {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(panelCss)
  shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet]

  const root = document.createElement('div')
  shadow.appendChild(root)

  const evt = pill.querySelector('.evt')

  const open = () => {
    posture.value = 'dock'
    pill.style.display = 'none'
    pill.classList.remove('alert')
    clearPulse()
    rerender()
  }
  const minimize = () => {
    posture.value = 'min'
    pill.style.display = ''
    rerender()
  }

  const rerender = () => {
    render(posture.value === 'min' ? null : <Panel onMinimize={minimize} />, root)
  }

  // Ambient market pulse → pill glow with mono event tag. Server decides when.
  pulseTag.subscribe((tag) => {
    if (tag && posture.value === 'min' && evt) {
      evt.textContent = tag
      pill.classList.add('alert')
    }
  })

  pill.addEventListener('hippo:open', open)
  // Connect eagerly (hover-preload warms the session too) — but only a click opens.
  void connect({ gateway: config.gateway, key: config.key })
}
