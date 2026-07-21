import type { Banner, Frame, OrdersSnapshot, ResearchBrief, UnknownFrame } from '@hippo/protocol'
import { computed, signal } from '@preact/signals'
import { resolveChips } from './chips.js'
import type { FeedbackState } from './feedback.js'
import { isRtl, type Locale } from './i18n.js'
import type { Posture } from './posture.js'
import {
  armStreamWatchdog,
  clearStreamWatchdog,
  interruptedStreamIds,
  isStreaming,
} from './streaming.js'

/** A thread entry: a known frame, or an unknown one destined for FallbackCard. */
export type ThreadItem = { kind: 'frame'; frame: Frame } | { kind: 'unknown'; frame: UnknownFrame }

export const sessionId = signal<string | null>(null)
export const venueName = signal('your exchange')
export const suggestedQueries = signal<string[]>([])

/** Active chrome locale (embed config or server). Content language is separate
 * — that's decided server-side. `dir` follows the locale for RTL layout. */
export const locale = signal<Locale>('en')
export const dir = computed<'ltr' | 'rtl'>(() => (isRtl(locale.value) ? 'rtl' : 'ltr'))

export const thread = signal<ThreadItem[]>([])
export const orders = signal<OrdersSnapshot | null>(null)
/** Where the panel sits on the page. `pill` = minimized launcher (panel
 * renders null). Full matrix + transitions live in posture.ts. */
export const posture = signal<Posture>('pill')
/**
 * Connection lifecycle. `connecting`/`live`/`offline` are the transient stream
 * states; `blocked` (invalid key / blocked user — 401) and `capacity` (MAU
 * quota — 429) are terminal-for-this-user mint outcomes the composer renders
 * distinctly. `blocked` disables the surface quietly (no error); `capacity`
 * shows a friendly "busy this month" state while a long-backoff retry runs.
 */
export const connection = signal<'connecting' | 'live' | 'offline' | 'blocked' | 'capacity'>(
  'connecting',
)
export const pulseTag = signal<string | null>(null)

/** Pinned banners (degraded/offline/info) — rendered above the orders strip,
 * never in-thread, so they can't scroll away. Latest frame per kind wins. */
export const banners = signal<Banner[]>([])

/** Consent/settings memory opt-in — set by onboarding, toggled in settings. */
export const memoryOptIn = signal(true)
export const settingsOpen = signal(false)

/** Brief being shared — non-null opens the full-surface share overlay (§6). */
export const shareFrame = signal<ResearchBrief | null>(null)

/**
 * One-shot composer prefill — set by the new-order hint chips, consumed by
 * the Composer. FILLS the input only; the trader always hits send.
 */
export const composerPrefill = signal<string | null>(null)

export function prefillComposer(text: string) {
  composerPrefill.value = text
}

/** Consume the pending prefill (returns it once, then clears). */
export function takeComposerPrefill(): string | null {
  const v = composerPrefill.value
  composerPrefill.value = null
  return v
}

/** Composer draft — a signal (not component state) so minimizing to the
 * pill never destroys typed text. Edge state №6 applied to the panel
 * lifecycle, not just failed sends. */
export const composerDraft = signal('')

/** The chip bar's contents: the latest server-sent followups win; the
 * session's suggested queries are the floor. Server-authored either way. */
export const activeChips = computed(() => resolveChips(thread.value, suggestedQueries.value))

/** Feedback state per brief, keyed by frame id — lives here (not in card
 * component state) so "already gave feedback" survives minimize/reopen.
 * The reducer is one-shot on terminal states, so replays can't double-send. */
export const feedbackMap = signal<Record<string, FeedbackState>>({})

/** Locale persistence — installed by mountPanel (storage is namespaced by
 * partner key there); the settings sheet calls persistLocale on selection. */
let localePersister: (l: Locale) => void = () => {}
export function setLocalePersistence(fn: (l: Locale) => void) {
  localePersister = fn
}
export function persistLocale(l: Locale) {
  localePersister(l)
}

export const openOrderCount = computed(() => orders.value?.open.length ?? 0)

const EPHEMERAL = new Set(['thinking', 'skeleton', 'brief_delta'])

/** Commit a new thread array AND reconcile the stalled-stream watchdog: arm
 * (reset) it whenever the thread is mid-stream, clear it the instant it isn't
 * (the authoritative brief landed, or content replaced the stream). Routing
 * frames (orders/pulse/banner) never reach here, so ambient traffic can't
 * disarm a genuinely stalled stream. */
function commitThread(next: ThreadItem[]) {
  thread.value = next
  if (isStreaming(next)) armStreamWatchdog(finalizeStalledStream)
  else clearStreamWatchdog()
}

/** Watchdog fired: the deltas stopped and no authoritative brief arrived.
 * Mark the trailing streaming card interrupted — stops its cursor and flips
 * isStreaming false — instead of leaving it blinking forever. */
function finalizeStalledStream() {
  const items = thread.value
  const last = items[items.length - 1]
  if (last?.kind === 'frame' && last.frame.type === 'brief_delta') {
    interruptedStreamIds.value = new Set(interruptedStreamIds.value).add(last.frame.id)
  }
}

/** Append a frame to the thread. Thinking/skeleton frames replace their predecessor. */
export function pushFrame(item: ThreadItem) {
  const t = item.kind === 'frame' ? item.frame.type : null

  // Refresh-in-place: a research_brief may carry `replaces` (the id of an
  // earlier brief it supersedes — the REFRESH re-run). Swap that card where
  // it sits so the refreshed answer updates in place instead of stacking
  // below the stale one (and a same-id re-send can't collide keys). Fall
  // through to normal handling if the referenced card isn't present —
  // older-SDK-safe by construction.
  const replaces =
    item.kind === 'frame' && item.frame.type === 'research_brief' ? item.frame.replaces : undefined
  if (replaces) {
    const prev = thread.value
    const idx = prev.findIndex((x) => x.frame.id === replaces)
    if (idx !== -1) {
      const next = [...prev]
      next[idx] = item
      commitThread(next)
      return
    }
  }

  // Streaming prose: consecutive brief_delta frames accumulate into ONE
  // growing card (replacing the skeleton they fill). The eventual
  // research_brief is authoritative — the generic ephemeral rule below
  // replaces the accumulated card with it.
  if (t === 'brief_delta' && item.kind === 'frame' && item.frame.type === 'brief_delta') {
    const prev = thread.value
    const last = prev[prev.length - 1]
    if (last?.kind === 'frame' && last.frame.type === 'brief_delta') {
      const merged: ThreadItem = {
        kind: 'frame',
        frame: { ...item.frame, text: last.frame.text + item.frame.text },
      }
      commitThread([...prev.slice(0, -1), merged])
      return
    }
    if (last?.kind === 'frame' && EPHEMERAL.has(last.frame.type)) {
      commitThread([...prev.slice(0, -1), item])
      return
    }
    commitThread([...prev, item])
    return
  }

  // Lifecycle frames collapse IN PLACE by ticketId — one card tells the whole
  // order journey (placing → working → partial ticks → terminal). Without
  // this every stage event and every partial stacks a new card. Journal
  // replay after a reconnect replays events in order, so the collapse leaves
  // exactly the latest state per ticket — correct by construction.
  if (t === 'lifecycle' && item.kind === 'frame' && item.frame.type === 'lifecycle') {
    const ticketId = item.frame.ticketId
    const prev = thread.value
    for (let i = prev.length - 1; i >= 0; i--) {
      const x = prev[i]
      if (x?.kind === 'frame' && x.frame.type === 'lifecycle' && x.frame.ticketId === ticketId) {
        const next = [...prev]
        next[i] = item
        commitThread(next)
        return
      }
    }
    // No prior card for this ticket — fall through to normal handling (which
    // also clears a trailing thinking/skeleton via the ephemeral rule).
  }

  if (t === 'orders_snapshot') {
    orders.value = (item as { frame: OrdersSnapshot }).frame
    return
  }
  if (t === 'pulse') {
    if (posture.value === 'pill') pulseTag.value = (item.frame as { tag?: string }).tag ?? null
    return
  }
  if (t === 'banner') {
    const b = (item as { frame: Banner }).frame
    banners.value = [...banners.value.filter((x) => x.kind !== b.kind), b]
    return
  }

  const prev = thread.value
  const last = prev[prev.length - 1]
  const lastType = last?.kind === 'frame' ? last.frame.type : null

  // Content arriving replaces the transient thinking/skeleton card before it.
  // Unknown future frames are content too — they render a FallbackCard, so
  // they must clear the thinking/skeleton card above them the same way known
  // content does (otherwise the spinner pulses forever above the fallback).
  const isContent = item.kind === 'unknown' || (t !== null && !EPHEMERAL.has(t))
  if (lastType && EPHEMERAL.has(lastType) && isContent) {
    commitThread([...prev.slice(0, -1), item])
    return
  }
  // A skeleton replaces a thinking card.
  if (lastType === 'thinking' && t === 'skeleton') {
    commitThread([...prev.slice(0, -1), item])
    return
  }
  commitThread([...prev, item])
}

export function clearPulse() {
  pulseTag.value = null
}
