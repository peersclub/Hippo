import type {
  Banner,
  Frame,
  Identity,
  LearnedMemory,
  OrdersSnapshot,
  PriceTick,
  ResearchBrief,
  UnknownFrame,
} from '@hippo/protocol'
import { computed, signal } from '@preact/signals'
import { resolveChips } from './chips.js'
import type { FeedbackState } from './feedback.js'
import { isRtl, type Locale, type MessageKey } from './i18n.js'
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

/**
 * The latest live market price. TRANSIENT by protocol contract: `price_tick`
 * frames (and the 'client'/'host' price sources) land here and NEVER in the
 * thread — the price surface updates in place, the conversation doesn't grow.
 * One symbol at a time (the page's market); consumers must check `symbol`
 * before showing the number against a different instrument.
 */
export type LivePrice = {
  symbol: string
  last: number
  lastDisplay: string
  changePct?: number
  asOfIso: string
}
export const livePrice = signal<LivePrice | null>(null)

/**
 * The market the HOST page is showing (data-hippo-symbol at mount, then
 * hippo:context bridge messages). Null = the host declared nothing; the
 * server falls back to its own default. Always the validated, uppercased
 * "BASE/QUOTE" form — bridge.ts is the only writer besides mountPanel.
 */
export const pageSymbol = signal<string | null>(null)
/** Where the panel sits on the page. `pill` = minimized launcher (panel
 * renders null). Full matrix + transitions live in posture.ts. */
export const posture = signal<Posture>('pill')

/** Custom drag position for the floating (`overlay`) posture — top-left in
 * viewport px, or null for the default bottom-right anchor. Client-only
 * presentation state; persisted per embed key (installed by mountPanel). */
export const floatPos = signal<{ x: number; y: number } | null>(null)

/** Frosted-glass panel — a settings toggle so the host's own data stays
 * visible through/around the panel. Persisted like locale. */
export const glass = signal(false)
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

/** A single auto-learned trading fact the server has surfaced for this trader. */
export type LearnedFact = LearnedMemory['facts'][number]

/**
 * Plan entitlements resolved at session mint (e.g. `{ memoryLab: true }`),
 * carried on the mint `config`. Purely a feature gate — the SDK renders the
 * learned-memory section only when the server both grants the entitlement AND
 * pushes facts. Absent/empty = the feature stays invisible (older plans).
 */
export const entitlements = signal<Record<string, unknown>>({})

/**
 * "What Hippo remembers about you" — the latest server-pushed set of learned
 * facts (durable `user` + this-chat `session`). Server is authoritative: the
 * SDK only ever mirrors the newest `learned_memory` frame, never invents or
 * persists facts client-side. A post-clear empty frame empties this.
 */
export const learnedFacts = signal<LearnedFact[]>([])

/**
 * Phase C "Remember my preferences" — whether auto-learning is currently ON
 * for this trader, per the latest `learned_memory` frame's `optIn`. Server is
 * authoritative (opt-OUT model, default true): the toggle only signals intent
 * via a settings uplink and then reflects the next frame. Latest frame wins.
 */
export const learnedMemoryOptIn = signal(true)

/**
 * Panel identity — the latest `identity` frame verbatim (server-authoritative,
 * like learned_memory: the SDK only mirrors, never invents). NEVER a thread
 * card — the identity card/settings section render it in place.
 */
export const identityStatus = signal<Identity | null>(null)

/**
 * The signed-in username, STICKY across non-terminal statuses: only an `ok`
 * frame sets it and only a `signed_out` frame clears it — a failed re-claim
 * (`taken`/`wrong_pin`) must not un-sign the trader mid-session.
 */
export const identityUsername = signal<string | null>(null)

/** First-run "claim a username" card dismissal — session-scoped by design
 * (a module signal, never storage): the nudge re-offers on the next visit. */
export const identityFirstRunDismissed = signal(false)

/**
 * Client-local upload rows — the byte-progress phase of the upload
 * affordance. Purely presentation (the wire has no 'uploading' phase): a row
 * lives from file-pick to either a local error (dismissible) or the first
 * `upload_status` frame for its fileId, which clears it (the server's frames
 * take over in-thread from there).
 */
export type LocalUpload = {
  id: number
  name: string
  sizeDisplay: string
  pct: number
  phase: 'sending' | 'error'
  errorKey?: MessageKey
  /** Set once the POST is accepted (202) — the join key to upload_status. */
  fileId?: string
  /** The originating File, held so a failed send can re-POST the same bytes
   * (network/send failures only; local rejects have no file to retry). */
  file?: File
  /** A retryable error offers a "Retry" affordance (re-POST); local rejects
   * (oversize/unsupported) don't — re-sending would fail identically. */
  retry?: boolean
}
export const localUploads = signal<LocalUpload[]>([])

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

/** Float-position + glass persistence — same install pattern as locale
 * (mountPanel owns the key-namespaced storage). The settings toggle and the
 * drag handler call the persist* helpers; a no-op default keeps tests and
 * storage-less environments happy. */
let floatPosPersister: (p: { x: number; y: number } | null) => void = () => {}
export function setFloatPosPersistence(fn: (p: { x: number; y: number } | null) => void) {
  floatPosPersister = fn
}
export function persistFloatPos(p: { x: number; y: number } | null) {
  floatPos.value = p
  floatPosPersister(p)
}
let glassPersister: (on: boolean) => void = () => {}
export function setGlassPersistence(fn: (on: boolean) => void) {
  glassPersister = fn
}
export function persistGlass(on: boolean) {
  glass.value = on
  glassPersister(on)
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
        // Keep the FIRST delta's id so the growing card holds ONE identity
        // across the stream. Spreading item.frame's id (the newest delta)
        // changed the render key every ~150ms chunk → Preact remounted the
        // card and re-fired the msgIn entrance animation → visible flicker.
        // Stable id = text grows in place, animation runs once.
        frame: { ...item.frame, id: last.frame.id, text: last.frame.text + item.frame.text },
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

  // Upload lifecycle collapses IN PLACE by fileId, exactly like lifecycle by
  // ticketId — one chip tells the file's journey (received → analyzing →
  // failed). The frame also retires the client-local progress row for its
  // fileId: once the server speaks, the byte-progress phase is over.
  if (t === 'upload_status' && item.kind === 'frame' && item.frame.type === 'upload_status') {
    const fileId = item.frame.fileId
    if (localUploads.value.some((u) => u.fileId === fileId)) {
      localUploads.value = localUploads.value.filter((u) => u.fileId !== fileId)
    }
    const prev = thread.value
    for (let i = prev.length - 1; i >= 0; i--) {
      const x = prev[i]
      if (x?.kind === 'frame' && x.frame.type === 'upload_status' && x.frame.fileId === fileId) {
        const next = [...prev]
        next[i] = item
        commitThread(next)
        return
      }
    }
    // First frame for this file — fall through (clears a trailing
    // thinking/skeleton via the ephemeral rule, like any content).
  }

  if (t === 'orders_snapshot') {
    orders.value = (item as { frame: OrdersSnapshot }).frame
    return
  }
  // Live price ticks are transient by contract — they feed the livePrice
  // surface (order-draft price row, header pulse) and NEVER the thread. The
  // gateway already keeps them out of the resume journal; keeping them out of
  // the thread here means a tick can also never clear a thinking/skeleton
  // card or bloat the conversation.
  if (t === 'price_tick') {
    const f = (item as { frame: PriceTick }).frame
    livePrice.value = {
      symbol: f.symbol,
      last: f.last,
      lastDisplay: f.lastDisplay,
      changePct: f.changePct,
      asOfIso: f.asOfIso,
    }
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
  // Learned-memory frames never enter the thread — they replace the current
  // "what Hippo remembers" set wholesale (latest wins). An empty frame (sent
  // after a clear) empties the set, so the settings section empties itself.
  if (t === 'learned_memory') {
    const f = (item as { frame: LearnedMemory }).frame
    learnedFacts.value = f.facts
    learnedMemoryOptIn.value = f.optIn
    return
  }
  // Identity frames never enter the thread — the identity card and the
  // settings section render the latest one in place. Only `ok` binds a
  // username and only `signed_out` unbinds it; failure statuses (taken /
  // wrong_pin / invalid / rate_limited) report without touching a live
  // sign-in. Like price_tick, this early return also means an identity frame
  // can never clear a thinking/skeleton card.
  if (t === 'identity') {
    const f = (item as { frame: Identity }).frame
    identityStatus.value = f
    if (f.status === 'ok') identityUsername.value = f.username ?? null
    else if (f.status === 'signed_out') identityUsername.value = null
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
