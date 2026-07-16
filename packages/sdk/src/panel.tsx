/**
 * Stage-2 panel — Preact app rendered into the loader's closed shadow root.
 * Server-driven: everything in the thread is a protocol frame; the panel
 * decides nothing about content or timing.
 */

import type { OrdersSnapshot } from '@hippo/protocol'
import { type ComponentChildren, render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { FallbackCard, renderFrame } from './cards.js'
import { resolveLocale, t } from './i18n.js'
import { createOnboardingStore, HERO_QUERIES, type OnboardingStore } from './onboarding.js'
import { EXAMPLE_INTENTS, NEW_ORDER, parseOrderSummary, toggleExpand } from './orders-expand.js'
import { OnboardingOverlay, SettingsSheet, ShareOverlay } from './overlays.js'
import { cyclePosture, isMobileViewport, openPosture } from './posture.js'
import {
  banners,
  clearPulse,
  composerPrefill,
  connection,
  dir,
  locale,
  openOrderCount,
  orders,
  posture,
  prefillComposer,
  pulseTag,
  settingsOpen,
  shareFrame,
  suggestedQueries,
  takeComposerPrefill,
  thread,
  venueName,
} from './state.js'
import { panelCss } from './styles.js'
import { connect, send } from './transport.js'

type MountOpts = {
  shadow: ShadowRoot
  pill: HTMLButtonElement
  config: { key: string; gateway: string; panelUrl: string; locale?: string }
}

let onboarding: OnboardingStore | null = null

/** Re-open the intro flow (settings → "Replay the intro", or host-side). */
export function replayOnboarding() {
  onboarding?.replay()
}

function Composer() {
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const offline = connection.value === 'offline'
  // New-order example intents FILL the input — never auto-send (baseline §3:
  // order placement stays conversational; the trader always hits send).
  const pending = composerPrefill.value
  useEffect(() => {
    if (!pending) return
    const t = takeComposerPrefill()
    if (t) {
      setText(t)
      setFailed(false)
      inputRef.current?.focus()
    }
  }, [pending])
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
  const L = locale.value
  return (
    <div class="cwrap">
      {failed && <div class="sendfail">{t(L, 'send_failed')}</div>}
      <form class="composer" onSubmit={submit}>
        <input
          ref={inputRef}
          value={text}
          disabled={offline}
          onInput={(e) => {
            setText((e.target as HTMLInputElement).value)
            setFailed(false)
          }}
          placeholder={t(L, offline ? 'composer_placeholder_offline' : 'composer_placeholder')}
          aria-label={t(L, 'brand_ask')}
        />
        <button
          type="submit"
          class="send"
          disabled={offline}
          title={failed ? t(L, 'retry_send') : undefined}
          aria-label={failed ? t(L, 'retry_send') : t(L, 'send')}
        >
          {failed ? '↻' : '↑'}
        </button>
      </form>
    </div>
  )
}

/** Expanded order card — in place below the strip, thread pushed down (§3). */
function OrderExpandCard({ order }: { order: OrdersSnapshot['open'][number] }) {
  const parsed = parseOrderSummary(order.summary)
  return (
    <div class="ocard">
      <div class="och">
        <span class={`oside ${order.side}`}>{order.side.toUpperCase()}</span>
        <b class="osum">{parsed.main}</b>
        {parsed.details.map((d) => (
          <span class="odet" key={d}>
            {d}
          </span>
        ))}
      </div>
      <div class="ostat">{order.status}</div>
      <button
        type="button"
        class="omanage"
        onClick={() => send({ kind: 'chip_tap', text: `manage:${order.orderId}` })}
      >
        {t(locale.value, 'manage_on', { venue: venueName.value })}
      </button>
    </div>
  )
}

/** "+ New order" hint — conversational, never a form (§3). Chips fill the
 * composer via the prefill signal; the trader must hit send. */
function NewOrderHint({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div class="newhint">
      <b>{t(locale.value, 'new_order_hint')}</b>
      <div class="nchips">
        {EXAMPLE_INTENTS.map((t) => (
          <button type="button" class="chip" key={t} onClick={() => onPick(t)}>
            {t}
          </button>
        ))}
      </div>
    </div>
  )
}

function OrdersStrip() {
  const snap = orders.value
  const [expanded, setExpanded] = useState<string | null>(null)
  if (!snap) return null
  // A pill that vanished from the latest snapshot silently collapses.
  const open = snap.open.find((o) => o.orderId === expanded)
  const active = open ? expanded : expanded === NEW_ORDER ? NEW_ORDER : null
  return (
    <div class="orders">
      <div class="lab">
        <span>
          {t(locale.value, 'orders_open')} <span class="cnt">· {openOrderCount.value}</span>
        </span>
        <span>
          {t(locale.value, 'orders_positions')} · {snap.positionsCount}
        </span>
      </div>
      <div class="row">
        {snap.open.map((o) => (
          <button
            type="button"
            class={`opill ${o.side}${active === o.orderId ? ' on' : ''}`}
            key={o.orderId}
            aria-expanded={active === o.orderId}
            onClick={() => setExpanded(toggleExpand(expanded, o.orderId))}
          >
            <span class="sd" />
            {o.summary} <span class="st">{o.status}</span>
          </button>
        ))}
        <button
          type="button"
          class={`opill new${active === NEW_ORDER ? ' on' : ''}`}
          aria-expanded={active === NEW_ORDER}
          onClick={() => setExpanded(toggleExpand(expanded, NEW_ORDER))}
        >
          {t(locale.value, 'new_order')}
        </button>
      </div>
      <div class={`oexp${active ? ' open' : ''}`}>
        {open && <OrderExpandCard order={open} />}
        {active === NEW_ORDER && (
          <NewOrderHint
            onPick={(t) => {
              prefillComposer(t) // fills the input only — never auto-sends
              setExpanded(null)
            }}
          />
        )}
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
      <h2>{t(locale.value, 'hero_title')}</h2>
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
            <b>{t(locale.value, 'connection_lost')}</b>
            {t(locale.value, 'connection_lost_body')}
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
  // `pill` never reaches here (the panel renders null when minimized), so any
  // posture we hold is a concrete on-screen one; drive the class straight off it.
  const p = posture.value
  const L = locale.value
  return (
    <div class={`panel ${p}`} dir={dir.value}>
      <div class="hd">
        <span class="mark">H</span>
        <div class="name">
          {t(L, 'brand_ask')}
          <small>{t(L, 'header_subtitle')}</small>
        </div>
        <div class="ctl">
          <button
            type="button"
            title={t(L, 'settings')}
            aria-label={t(L, 'settings')}
            onClick={() => {
              settingsOpen.value = true
            }}
          >
            ⚙
          </button>
          <button
            type="button"
            title={t(L, 'change_layout')}
            aria-label={t(L, 'change_layout')}
            onClick={() => {
              posture.value = cyclePosture(posture.value, isMobileViewport())
            }}
          >
            ⤢
          </button>
          <button
            type="button"
            title={t(L, 'minimize')}
            aria-label={t(L, 'minimize')}
            onClick={onMinimize}
          >
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
      {!ob.active.value && shareFrame.value && <ShareOverlay frame={shareFrame.value} />}
      {!ob.active.value && !shareFrame.value && settingsOpen.value && (
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
  // Chrome locale from the embed config; content language stays server-decided.
  locale.value = resolveLocale(config.locale)

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
    posture.value = openPosture(isMobileViewport())
    pill.style.display = 'none'
    pill.classList.remove('alert')
    clearPulse()
    // First open (and every open until consent is given) leads with the flow.
    ob.offerIfNeeded()
    rerender()
  }
  const minimize = () => {
    posture.value = 'pill'
    pill.style.display = ''
    rerender()
  }

  const rerender = () => {
    render(posture.value === 'pill' ? null : <Panel onMinimize={minimize} ob={ob} />, root)
  }

  // Ambient market pulse → pill glow with mono event tag. Server decides when.
  pulseTag.subscribe((tag) => {
    if (tag && posture.value === 'pill' && evt) {
      evt.textContent = tag
      pill.classList.add('alert')
    }
  })

  pill.addEventListener('hippo:open', open)
  // Connect eagerly (hover-preload warms the session too) — but only a click opens.
  void connect({ gateway: config.gateway, key: config.key })
}
