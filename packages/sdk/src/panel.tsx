/**
 * Stage-2 panel — Preact app rendered into the loader's closed shadow root.
 * Server-driven: everything in the thread is a protocol frame; the panel
 * decides nothing about content or timing.
 */

import type { OrdersSnapshot } from '@hippo/protocol'
import { type ComponentChildren, render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  advertisePageControl,
  installHostBridge,
  requestHostCapabilities,
  SYMBOL_RE,
  setPageControl,
} from './bridge.js'
import { FallbackCard, renderFrame } from './cards.js'
import { LONG_PRESS_MS, PRESS_MOVE_SLOP_PX, roveIndex } from './chips.js'
import { counterLabel, enterAction, MAX_COMPOSER_HEIGHT_PX } from './composer.js'
import { filesOpen, openFiles } from './files.js'
import { resolveLocale, t } from './i18n.js'
import { IdentityFirstRunCard } from './identity-card.js'
import { createOnboardingStore, HERO_QUERIES, type OnboardingStore } from './onboarding.js'
import { EXAMPLE_INTENTS, NEW_ORDER, parseOrderSummary, toggleExpand } from './orders-expand.js'
import { dispatch, outbox } from './outbox.js'
import { FilesSheet, OnboardingOverlay, SettingsSheet, ShareOverlay } from './overlays.js'
import { clampToViewport, cyclePosture, isMobileViewport, openPosture } from './posture.js'
import { initPriceSource, normalizePriceSource } from './price.js'
import { isNearBottom } from './scroll.js'
import {
  activeChips,
  banners,
  clearPulse,
  composerDraft,
  composerPrefill,
  connection,
  dir,
  floatPos,
  glass,
  locale,
  localUploads,
  openOrderCount,
  orders,
  pageSymbol,
  persistFloatPos,
  posture,
  prefillComposer,
  pulseTag,
  setFloatPosPersistence,
  setGlassPersistence,
  setLocalePersistence,
  settingsOpen,
  shareFrame,
  suggestedQueries,
  takeComposerPrefill,
  thread,
  venueName,
} from './state.js'
import { isStreaming } from './streaming.js'
import { panelCss } from './styles.js'
import { connect, send } from './transport.js'
import { dismissUpload, retryUpload, startUploads } from './upload.js'

type MountOpts = {
  shadow: ShadowRoot
  pill: HTMLButtonElement
  config: {
    key: string
    gateway: string
    panelUrl: string
    locale?: string
    tokenUrl?: string
    symbol?: string
    priceSource?: string
  }
}

/** The Hippo mark, served from the SDK's own dist (same origin as panel.js).
 *  Referenced by URL — never inlined — so the panel bundle carries no image. */
const HIPPO_MARK = new URL('hippo-mark.png', import.meta.url).href

let onboarding: OnboardingStore | null = null

/** Re-open the intro flow (settings → "Replay the intro", or host-side). */
export function replayOnboarding() {
  onboarding?.replay()
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Fire a non-queueable action (stop, and anything else routed straight through
 * the panel) and report failure to the caller. These never touch the outbox —
 * they're time-sensitive — so a send that fails while the connection still
 * reads 'live' (gateway 500 / timeout / dead session) would otherwise vanish
 * silently. `onFail` lets the composer surface it, mirroring SEND FAILED.
 */
export async function runActionSend(
  partial: Parameters<typeof send>[0],
  onFail: () => void,
  sender: (p: Parameters<typeof send>[0]) => Promise<boolean> = send,
): Promise<void> {
  const ok = await sender(partial).catch(() => false)
  if (!ok) onFail()
}

/**
 * One suggestion chip. Tap sends; holding LONG_PRESS_MS (or Shift+click)
 * drops the text into the composer to edit instead — same fill-never-send
 * path as the "+ New order" hint. Pointer travel past the slop cancels the
 * press so horizontal chip-scrolling never misfires an edit.
 */
function ChipButton({
  text,
  tabIndex,
  onFocus,
}: {
  text: string
  tabIndex?: number
  onFocus?: () => void
}) {
  const timer = useRef(0)
  const held = useRef(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  const cancel = () => {
    clearTimeout(timer.current)
    start.current = null
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      class="chip"
      tabIndex={tabIndex}
      title={t(locale.value, 'chip_edit_hint')}
      onFocus={onFocus}
      onPointerDown={(e) => {
        held.current = false
        start.current = { x: e.clientX, y: e.clientY }
        timer.current = window.setTimeout(() => {
          held.current = true
          prefillComposer(text)
        }, LONG_PRESS_MS)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        if (
          Math.abs(e.clientX - start.current.x) > PRESS_MOVE_SLOP_PX ||
          Math.abs(e.clientY - start.current.y) > PRESS_MOVE_SLOP_PX
        )
          cancel()
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (held.current) {
          held.current = false
          return
        }
        if (e.shiftKey) {
          prefillComposer(text)
          return
        }
        void dispatch({ kind: 'chip_tap', text })
      }}
    >
      {text}
    </button>
  )
}

/** Crisp inline paperclip — emoji render differently on every host platform
 * and fight the mono aesthetic; currentColor lets CSS drive the state. */
function ClipSvg() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z" />
    </svg>
  )
}

/** Crisp inline "files" glyph for the header button — a document stack.
 * currentColor lets CSS drive hover/active like the other header controls. */
function FilesSvg() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 2h6l4 4v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm5 1.5V7h3.5L13 3.5zM5 6H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2h-2v0H4V6z" />
    </svg>
  )
}

/** Client-local upload rows — byte progress while the POST runs (the wire has
 * no 'uploading' phase by design), and inline local errors for files that
 * never leave the panel (unsupported / oversized / failed send). Success rows
 * are cleared by the first upload_status frame for their fileId (state.ts). */
function UploadRows() {
  const rows = localUploads.value
  const L = locale.value
  if (rows.length === 0) return null
  return (
    <>
      {rows.map((u) =>
        u.phase === 'sending' ? (
          <div class="uprow" role="status" key={u.id}>
            <span class="upname">{u.name}</span>
            <span class="upsize">{u.sizeDisplay}</span>
            <span class="upbar" aria-hidden="true">
              <span style={{ width: `${u.pct}%` }} />
            </span>
            <span class="uppct">{u.pct}%</span>
          </div>
        ) : (
          <div class="uprow err" role="status" key={u.id}>
            <span class="upname">{u.name}</span>
            <span class="upmsg">{t(L, u.errorKey ?? 'upload_send_failed')}</span>
            {/* Retry re-POSTs the SAME file into the same row (send/network
                failures only — local rejects have no file to retry). */}
            {u.retry && (
              <button type="button" class="upretry" onClick={() => retryUpload(u.id)}>
                ↻ {t(L, 'upload_retry')}
              </button>
            )}
            <button
              type="button"
              class="upx"
              aria-label={t(L, 'dismiss')}
              onClick={() => dismissUpload(u.id)}
            >
              ✕
            </button>
          </div>
        ),
      )}
    </>
  )
}

function Composer() {
  const text = composerDraft.value
  const [failed, setFailed] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const conn = connection.value
  // Terminal/dropped states where typing is pointless — disable the input.
  // `connecting` keeps it enabled so the draft can be composed while we warm up.
  const offline = conn === 'offline' || conn === 'blocked' || conn === 'capacity'
  const blocked = conn !== 'live'
  const autosize = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`
  }
  // Draft survives minimize (it's a signal) — restore the height on remount.
  useEffect(() => autosize(), [])
  // New-order example intents FILL the input — never auto-send (baseline §3:
  // order placement stays conversational; the trader always hits send).
  const pending = composerPrefill.value
  useEffect(() => {
    if (!pending) return
    const v = takeComposerPrefill()
    if (v) {
      composerDraft.value = v
      setFailed(false)
      inputRef.current?.focus()
      requestAnimationFrame(autosize)
    }
  }, [pending])
  const submit = async (e?: Event) => {
    e?.preventDefault()
    const v = text.trim()
    if (!v || blocked) return
    composerDraft.value = ''
    setFailed(false)
    requestAnimationFrame(autosize)
    const ok = await send({ kind: 'user_text', text: v })
    if (!ok) {
      // Edge state №6: nothing the trader wrote is ever lost.
      composerDraft.value = v
      setFailed(true)
    } else {
      inputRef.current?.focus()
    }
  }
  const L = locale.value
  const count = counterLabel(text.length)
  const queued = outbox.value.length
  const placeholder =
    conn === 'blocked'
      ? t(L, 'composer_placeholder_unavailable')
      : conn === 'capacity'
        ? t(L, 'composer_placeholder_capacity')
        : conn === 'offline'
          ? t(L, 'composer_placeholder_offline')
          : blocked
            ? t(L, 'composer_placeholder_connecting')
            : t(L, 'composer_placeholder')
  return (
    <div class="cwrap">
      {failed && (
        <div class="sendfail" role="status">
          {t(L, 'send_failed')}
        </div>
      )}
      {queued > 0 && (
        <div class="qrow" role="status">
          {t(L, 'queued_note', { n: String(queued) })}
        </div>
      )}
      {count && <div class={`ccount${text.length >= 2000 ? ' max' : ''}`}>{count}</div>}
      <UploadRows />
      <form class="composer" onSubmit={submit}>
        {/* Attach — CSV/image analysis. The picker's accept narrows the chooser;
            checkUpload (upload.ts) is the real gate before any byte is sent.
            Needs a live session (the POST carries it), so it disables with send. */}
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(e) => {
            const input = e.target as HTMLInputElement
            // Multi-select: each file gets its own row/chip; the queue runs
            // them one at a time (upload.ts).
            if (input.files && input.files.length > 0) startUploads(input.files)
            input.value = '' // re-picking the same file must fire change again
          }}
        />
        <button
          type="button"
          class="attach"
          disabled={blocked}
          title={t(L, 'upload_attach')}
          aria-label={t(L, 'upload_attach')}
          onClick={() => fileRef.current?.click()}
        >
          <ClipSvg />
        </button>
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          maxLength={2000}
          disabled={offline}
          onInput={(e) => {
            composerDraft.value = (e.target as HTMLTextAreaElement).value
            setFailed(false)
            autosize()
          }}
          onKeyDown={(e) => {
            if (enterAction(e.key, e.shiftKey) === 'send') {
              e.preventDefault()
              void submit()
            }
            // Shift+Enter falls through to the native newline.
          }}
          placeholder={placeholder}
          aria-label={t(L, 'brand_ask')}
        />
        {isStreaming(thread.value) ? (
          // Stop control while a brief streams: signals intent only — the
          // server assembles the stopped answer (thin client, no invention).
          // Time-sensitive, so it goes straight through transport `send`,
          // never the outbox (offline, stopping is moot). Typing stays
          // enabled and the draft is untouched.
          <button
            type="button"
            class="send stop"
            disabled={blocked}
            title={t(L, 'stop_streaming')}
            aria-label={t(L, 'stop_streaming')}
            onClick={() => void runActionSend({ kind: 'stream_stop' }, () => setFailed(true))}
          >
            ⏹
          </button>
        ) : (
          <button
            type="submit"
            class="send"
            disabled={blocked}
            title={failed ? t(L, 'retry_send') : undefined}
            aria-label={failed ? t(L, 'retry_send') : t(L, 'send')}
          >
            {failed ? '↻' : '↑'}
          </button>
        )}
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
        onClick={() => void dispatch({ kind: 'chip_tap', text: `manage:${order.orderId}` })}
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
        <div class={`banner ${b.kind}`} key={b.id} role="status">
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
      <img class="emark" src={HIPPO_MARK} alt="" />
      <h2>{t(locale.value, 'hero_title')}</h2>
      <div class="echips">
        {list.map((q) => (
          <ChipButton text={q} key={q} />
        ))}
      </div>
    </div>
  )
}

function Thread() {
  const ref = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [hasNew, setHasNew] = useState(false)
  const items = thread.value
  // Depend on the array IDENTITY, not length: pushFrame replaces the array
  // on every mutation — including brief_delta merges — so streaming growth
  // autoscrolls too. The trader reading history is never yanked down.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (atBottom.current) {
      el.scrollTo({ top: el.scrollHeight })
      setHasNew(false)
    } else if (items.length > 0) {
      setHasNew(true)
    }
  }, [items])
  const onScroll = () => {
    const el = ref.current
    if (!el) return
    atBottom.current = isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
    if (atBottom.current) setHasNew(false)
  }
  const jump = () => {
    const el = ref.current
    if (!el) return
    atBottom.current = true
    setHasNew(false)
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }
  return (
    <div class="threadwrap">
      <div
        class="thread"
        role="log"
        aria-label={t(locale.value, 'thread_label')}
        ref={ref}
        onScroll={onScroll}
      >
        {items.length === 0 && <EmptyHero />}
        {items.map((item) =>
          item.kind === 'frame' ? (
            // Lifecycle cards key by TICKET, not frame id: the store collapses
            // the journey in place, and a stable key means the update doesn't
            // remount (no re-run of the card-in animation, no strobing on
            // partial ticks, cancel-failed state survives).
            <FrameWrap
              key={
                item.frame.type === 'lifecycle'
                  ? `lc:${item.frame.ticketId}`
                  : // Upload chips collapse in place by fileId (state.ts) — a
                    // stable key means phase changes update, never remount.
                    item.frame.type === 'upload_status'
                    ? `up:${item.frame.fileId}`
                    : // Alert cards collapse in place by alertId (state.ts).
                      item.frame.type === 'alert'
                      ? `al:${item.frame.alertId}`
                      : item.frame.id
              }
            >
              {renderFrame(item.frame)}
            </FrameWrap>
          ) : (
            <FallbackCard key={item.frame.id} frame={item.frame} />
          ),
        )}
        {connection.value === 'offline' && (
          <div class="banner offline" role="status">
            <div>
              <b>{t(locale.value, 'connection_lost')}</b>
              {t(locale.value, 'connection_lost_body')}
            </div>
          </div>
        )}
        {/* Capacity (429) reads as a friendly notice, not a broken connection.
            `blocked` (401) is deliberately silent — the surface just disables. */}
        {connection.value === 'capacity' && (
          <div class="banner degraded" role="status">
            <div>
              <b>{t(locale.value, 'capacity_title')}</b>
              {t(locale.value, 'capacity_body')}
            </div>
          </div>
        )}
      </div>
      {hasNew && (
        <button type="button" class="jump" onClick={jump}>
          ↓ {t(locale.value, 'jump_latest')}
        </button>
      )}
    </div>
  )
}

function FrameWrap({ children }: { children: ComponentChildren }) {
  return <>{children}</>
}

/** Contextual suggestion bar: server-sent followups after each answer,
 * session chips as the floor. Roving tabindex, arrows follow reading order. */
function Chips() {
  const chips = activeChips.value
  const [focusIdx, setFocusIdx] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const chipsKey = chips.join('\u0000')
  // Reset the roving focus whenever the chip set itself changes.
  useEffect(() => setFocusIdx(0), [chipsKey])
  if (chips.length === 0) return null
  const onKeyDown = (e: KeyboardEvent) => {
    const next = roveIndex(focusIdx, chips.length, e.key, dir.value === 'rtl')
    if (next === focusIdx) return
    e.preventDefault()
    setFocusIdx(next)
    const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('.chip')
    buttons?.[next]?.focus()
  }
  return (
    <div
      class="chips"
      role="toolbar"
      aria-label={t(locale.value, 'suggestions_label')}
      ref={ref}
      onKeyDown={onKeyDown}
    >
      {chips.map((q, i) => (
        <ChipButton
          text={q}
          key={q}
          tabIndex={i === focusIdx ? 0 : -1}
          onFocus={() => setFocusIdx(i)}
        />
      ))}
    </div>
  )
}

function Panel({ onMinimize, ob }: { onMinimize: () => void; ob: OnboardingStore }) {
  // `pill` never reaches here (the panel renders null when minimized), so any
  // posture we hold is a concrete on-screen one; drive the class straight off it.
  const p = posture.value
  const L = locale.value
  // Esc folds inward-out: overlay → settings → intro (= "Not now") → minimize.
  // Attached via ref (not JSX) and scoped to the panel root, so the host
  // page never sees a handled Esc.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (shareFrame.value) {
        shareFrame.value = null
        return
      }
      if (filesOpen.value) {
        filesOpen.value = false
        return
      }
      if (settingsOpen.value) {
        settingsOpen.value = false
        return
      }
      if (ob.active.value) {
        ob.dismiss()
        onMinimize()
        return
      }
      onMinimize()
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [ob, onMinimize])

  // ── float drag ──────────────────────────────────────────────────────────
  // The floating (`overlay`) posture is movable: grab the header, drop it
  // anywhere. Desktop-only — mobile `overlay` is full-screen (CSS). Pointer
  // capture routes move/up to the header even when the cursor leaves it, and
  // clampToViewport (posture.ts) keeps the panel from being lost off-screen.
  const draggable = p === 'overlay' && !isMobileViewport()
  const fp = floatPos.value
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{
    px: number
    py: number
    ox: number
    oy: number
    w: number
    h: number
  } | null>(null)
  const startDrag = (e: PointerEvent) => {
    if (!draggable) return
    // Let the ⚙ / ⤢ / — controls click through — only bare header starts a drag.
    if ((e.target as HTMLElement).closest('.ctl')) return
    const el = rootRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    drag.current = { px: e.clientX, py: e.clientY, ox: r.left, oy: r.top, w: r.width, h: r.height }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const moveDrag = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const raw = { x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }
    floatPos.value = clampToViewport(
      raw,
      { w: d.w, h: d.h },
      { w: window.innerWidth, h: window.innerHeight },
    )
  }
  const endDrag = (e: PointerEvent) => {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // capture may already be gone (pointercancel) — nothing to release
    }
    persistFloatPos(floatPos.value) // one write on drop, not per move
  }
  // Keep a dragged panel on-screen when the viewport shrinks under it.
  useEffect(() => {
    if (!draggable) return
    const onResize = () => {
      const cur = floatPos.value
      const el = rootRef.current
      if (!cur || !el) return
      const r = el.getBoundingClientRect()
      floatPos.value = clampToViewport(
        cur,
        { w: r.width, h: r.height },
        { w: window.innerWidth, h: window.innerHeight },
      )
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draggable])

  const positioned = draggable && fp
  const panelStyle = positioned
    ? {
        insetInlineStart: 'auto',
        insetInlineEnd: 'auto',
        insetBlockStart: 'auto',
        insetBlockEnd: 'auto',
        left: `${fp.x}px`,
        top: `${fp.y}px`,
      }
    : undefined
  return (
    <div
      class={`panel ${p}${glass.value ? ' glass' : ''}${dragging ? ' dragging' : ''}`}
      style={panelStyle}
      dir={dir.value}
      ref={rootRef}
    >
      <div
        class="hd"
        onPointerDown={draggable ? startDrag : undefined}
        onPointerMove={draggable ? moveDrag : undefined}
        onPointerUp={draggable ? endDrag : undefined}
        onPointerCancel={draggable ? endDrag : undefined}
      >
        <img class="mark" src={HIPPO_MARK} alt="" />
        <div class="name">
          {t(L, 'brand_ask')}
          <small>{t(L, 'header_subtitle')}</small>
        </div>
        <div class="ctl">
          <button
            type="button"
            title={t(L, 'files_title')}
            aria-label={t(L, 'files_open')}
            onClick={openFiles}
          >
            <FilesSvg />
          </button>
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
      <IdentityFirstRunCard />
      <OrdersStrip />
      <Thread />
      <Chips />
      <Composer />
      {ob.active.value && <OnboardingOverlay store={ob} onNotNow={onMinimize} />}
      {!ob.active.value && shareFrame.value && <ShareOverlay frame={shareFrame.value} />}
      {!ob.active.value && !shareFrame.value && filesOpen.value && <FilesSheet />}
      {!ob.active.value && !shareFrame.value && !filesOpen.value && settingsOpen.value && (
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
  // Chrome locale: the trader's persisted choice (settings) wins over the
  // embed config. Content language stays server-decided either way.
  const localeKey = `hippo:${config.key}:locale`
  let storedLocale: string | null = null
  try {
    storedLocale = localStorage.getItem(localeKey)
  } catch {
    // Storage may be unavailable (private mode) — config locale applies.
  }
  locale.value = resolveLocale(storedLocale ?? config.locale)
  setLocalePersistence((l) => {
    try {
      localStorage.setItem(localeKey, l)
    } catch {
      // Non-persistent environments simply reset to the config locale.
    }
  })

  // Float position + frosted-glass preference — same key-namespaced,
  // fail-silent storage pattern as locale above.
  const floatKey = `hippo:${config.key}:floatpos`
  const glassKey = `hippo:${config.key}:glass`
  try {
    const raw = localStorage.getItem(floatKey)
    if (raw) {
      const parsed = JSON.parse(raw) as { x: number; y: number }
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') floatPos.value = parsed
    }
    glass.value = localStorage.getItem(glassKey) === '1'
  } catch {
    // Unreadable/absent storage — defaults (bottom-right anchor, opaque) apply.
  }
  setFloatPosPersistence((p) => {
    try {
      if (p) localStorage.setItem(floatKey, JSON.stringify(p))
      else localStorage.removeItem(floatKey)
    } catch {}
  })
  setGlassPersistence((on) => {
    try {
      localStorage.setItem(glassKey, on ? '1' : '0')
    } catch {}
  })

  const sheet = new CSSStyleSheet()
  sheet.replaceSync(panelCss)
  shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet]

  const root = document.createElement('div')
  shadow.appendChild(root)

  // Onboarding completion is the only other thing the SDK persists here —
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
    // Keyboard users land in the composer; mobile skips it (no surprise
    // virtual keyboard over the fresh panel).
    if (!isMobileViewport() && !ob.active.value) {
      requestAnimationFrame(() => root.querySelector('textarea')?.focus())
    }
  }
  const minimize = () => {
    posture.value = 'pill'
    pill.style.display = ''
    rerender()
    pill.focus()
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

  // Page context: the host may declare the market under the trader's eyes
  // (data-hippo-symbol) — validated with the same rule as the bridge, then
  // carried on the session mint. The bridge listens in EVERY mode (an
  // explicit host price is the most authoritative "same number as the
  // host"); priceSource only decides who else feeds livePrice.
  if (config.symbol && SYMBOL_RE.test(config.symbol)) {
    pageSymbol.value = config.symbol.toUpperCase()
  }
  installHostBridge()
  initPriceSource(normalizePriceSource(config.priceSource))

  // Host page-control opt-in: the embed sets data-hippo-page-control when the
  // host page accepts chart-control actions over the postMessage bridge. Read
  // it straight from the embed script (the zero-dep loader stays untouched /
  // under its size gate) and advertise it once the session is live, so the
  // gateway is willing to emit host_action frames.
  setPageControl(readPageControl())
  // Ask the host which host_action verbs it supports. Our bridge listener is
  // already installed (installHostBridge above), so the answer can't race us;
  // hosts that also announce proactively on load are deduped in the bridge.
  // No answer = the gateway's legacy chart-trio fallback.
  requestHostCapabilities()

  // Connect eagerly (hover-preload warms the session too) — but only a click opens.
  void connect({
    gateway: config.gateway,
    key: config.key,
    tokenUrl: config.tokenUrl || undefined,
    symbol: pageSymbol.value ?? undefined,
  }).then(advertisePageControl)
}

/** Whether the embed opted into host page-control (data-hippo-page-control).
 * Present-and-truthy = on; read from the embed script so the loader needn't
 * carry the flag through config. Untrusted DOM — never throws. */
function readPageControl(): boolean {
  try {
    const el = document.querySelector('script[data-hippo-page-control]')
    if (!el) return false
    const v = el.getAttribute('data-hippo-page-control')
    return v !== '0' && v !== 'false'
  } catch {
    return false
  }
}
