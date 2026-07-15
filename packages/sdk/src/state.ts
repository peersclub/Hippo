import type { Banner, Frame, OrdersSnapshot, ResearchBrief, UnknownFrame } from '@hippo/protocol'
import { computed, signal } from '@preact/signals'
import type { Posture } from './posture.js'

/** A thread entry: a known frame, or an unknown one destined for FallbackCard. */
export type ThreadItem = { kind: 'frame'; frame: Frame } | { kind: 'unknown'; frame: UnknownFrame }

export const sessionId = signal<string | null>(null)
export const venueName = signal('your exchange')
export const suggestedQueries = signal<string[]>([])

export const thread = signal<ThreadItem[]>([])
export const orders = signal<OrdersSnapshot | null>(null)
/** Where the panel sits on the page. `pill` = minimized launcher (panel
 * renders null). Full matrix + transitions live in posture.ts. */
export const posture = signal<Posture>('pill')
export const connection = signal<'connecting' | 'live' | 'offline'>('connecting')
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

export const openOrderCount = computed(() => orders.value?.open.length ?? 0)

const EPHEMERAL = new Set(['thinking', 'skeleton', 'brief_delta'])

/** Append a frame to the thread. Thinking/skeleton frames replace their predecessor. */
export function pushFrame(item: ThreadItem) {
  const t = item.kind === 'frame' ? item.frame.type : null

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
      thread.value = [...prev.slice(0, -1), merged]
      return
    }
    if (last?.kind === 'frame' && EPHEMERAL.has(last.frame.type)) {
      thread.value = [...prev.slice(0, -1), item]
      return
    }
    thread.value = [...prev, item]
    return
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
  if (lastType && EPHEMERAL.has(lastType) && t !== null && !EPHEMERAL.has(t)) {
    thread.value = [...prev.slice(0, -1), item]
    return
  }
  // A skeleton replaces a thinking card.
  if (lastType === 'thinking' && t === 'skeleton') {
    thread.value = [...prev.slice(0, -1), item]
    return
  }
  thread.value = [...prev, item]
}

export function clearPulse() {
  pulseTag.value = null
}
