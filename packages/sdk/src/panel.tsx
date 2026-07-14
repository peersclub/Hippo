/**
 * Stage-2 panel — Preact app rendered into the loader's closed shadow root.
 * Server-driven: everything in the thread is a protocol frame; the panel
 * decides nothing about content or timing.
 */
import { type ComponentChildren, render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { FallbackCard, renderFrame } from './cards.js'
import { createOnboardingStore, HERO_QUERIES, type OnboardingStore } from './onboarding.js'
import { OnboardingOverlay, SettingsSheet } from './overlays.js'
import {
  banners,
  clearPulse,
  connection,
  openOrderCount,
  orders,
  posture,
  pulseTag,
  settingsOpen,
  suggestedQueries,
  thread,
} from './state.js'
import { panelCss } from './styles.js'
import { connect, send } from './transport.js'

type MountOpts = {
  shadow: ShadowRoot
  pill: HTMLButtonElement
  config: { key: string; gateway: string; panelUrl: string }
}

let onboarding: OnboardingStore | null = null

/** Re-open the intro flow (settings → "Replay the intro", or host-side). */
export function replayOnboarding() {
  onboarding?.replay()
}

function Composer() {
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)
  const offline = connection.value === 'offline'
  const submit = async (e: Event) => {
    e.preventDefault()
    const t = text.trim()
    if (!t || connection.value === 'offline') return
    setText('')
    setFailed(false)
    const ok = await send({ kind: 'user_text', text: t })
    if (!ok) {
      // Edge state №6: nothing the trader wrote is ever lost.
      setText(t)
      setFailed(true)
    }
  }
  return (
    <div class="cwrap">
      {failed && <div class="sendfail">SEND FAILED — your message is kept. Tap ↻ to retry.</div>}
      <form class="composer" onSubmit={submit}>
        <input
          value={text}
          disabled={offline}
          onInput={(e) => {
            setText((e.target as HTMLInputElement).value)
            setFailed(false)
          }}
          placeholder={
            offline ? "Reconnecting — you can't send right now" : 'Ask about any market…'
          }
          aria-label="Ask Hippo"
        />
        <button
          type="submit"
          class="send"
          disabled={offline}
          title={failed ? 'Retry send' : undefined}
          aria-label={failed ? 'Retry send' : 'Send'}
        >
          {failed ? '↻' : '↑'}
        </button>
      </form>
    </div>
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
        <button
          type="button"
          class="opill new"
          onClick={() => send({ kind: 'chip_tap', text: 'new order' })}
        >
          + New order
        </button>
      </div>
    </div>
  )
}

/** Pinned banners (degraded/offline/info) live above the orders strip so
 * they can never scroll away in-thread. */
function PinnedBanners() {
  const list = banners.value
  if (list.length === 0) return null
  return (
    <div class="pins">
      {list.map((b) => (
        <div class={`banner ${b.kind}`} key={b.id}>
          <div>
            <b>{b.title}</b>
            {b.text}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Empty thread — never blank: value is one tap away (edge state №1). */
function EmptyHero() {
  const chips = suggestedQueries.value.slice(0, 3)
  const list = chips.length > 0 ? chips : HERO_QUERIES
  return (
    <div class="empty">
      <span class="emark">H</span>
      <h2>Ask your market anything.</h2>
      <div class="echips">
        {list.map((q) => (
          <button
            type="button"
            class="chip"
            key={q}
            onClick={() => send({ kind: 'chip_tap', text: q })}
          >
            {q}
          </button>
        ))}
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
      {items.length === 0 && <EmptyHero />}
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
        <button
          type="button"
          class="chip"
          key={q}
          onClick={() => send({ kind: 'chip_tap', text: q })}
        >
          {q}
        </button>
      ))}
    </div>
  )
}

function Panel({ onMinimize, ob }: { onMinimize: () => void; ob: OnboardingStore }) {
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
          <button
            type="button"
            title="Settings"
            aria-label="Settings"
            onClick={() => {
              settingsOpen.value = true
            }}
          >
            ⚙
          </button>
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
      <PinnedBanners />
      <OrdersStrip />
      <Thread />
      <Chips />
      <Composer />
      {ob.active.value && <OnboardingOverlay store={ob} onNotNow={onMinimize} />}
      {!ob.active.value && settingsOpen.value && (
        <SettingsSheet
          onReplay={() => {
            settingsOpen.value = false
            ob.replay()
          }}
        />
      )}
    </div>
  )
}

export function mountPanel({ shadow, pill, config }: MountOpts) {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(panelCss)
  shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet]

  const root = document.createElement('div')
  shadow.appendChild(root)

  // Onboarding completion is the only thing the SDK persists here —
  // namespaced like all hippo storage. "Not now" writes nothing.
  const doneKey = `hippo:${config.key}:onboarded`
  const ob = createOnboardingStore({
    isDone: () => {
      try {
        return localStorage.getItem(doneKey) === '1'
      } catch {
        return false
      }
    },
    markDone: () => {
      try {
        localStorage.setItem(doneKey, '1')
      } catch {
        // Storage may be unavailable (private mode) — the flow simply re-offers.
      }
    },
  })
  onboarding = ob

  const evt = pill.querySelector('.evt')

  const open = () => {
    posture.value = 'dock'
    pill.style.display = 'none'
    pill.classList.remove('alert')
    clearPulse()
    // First open (and every open until consent is given) leads with the flow.
    ob.offerIfNeeded()
    rerender()
  }
  const minimize = () => {
    posture.value = 'min'
    pill.style.display = ''
    rerender()
  }

  const rerender = () => {
    render(posture.value === 'min' ? null : <Panel onMinimize={minimize} ob={ob} />, root)
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
