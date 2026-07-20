/**
 * Offline outbox — edge state №6 / FE architecture §5: uplinks attempted
 * while the stream is down queue in memory and flush on reconnect.
 *
 * Deliberately NOT persisted to storage: the gateway mints a fresh session
 * per page load, so a persisted uplink would replay against dead frame and
 * session ids — the client inventing context. In-memory covers the real
 * case (an SSE blip mid-session), which is what the edge state describes.
 *
 * `ticket_action` is deliberately NOT queueable: confirm/cancel are
 * time-sensitive trading actions — firing them minutes later without the
 * trader present is unacceptable. They fail loudly (disabled CTA) instead.
 * `user_text` keeps its own, better path: restore + retry-in-place.
 */
import { signal } from '@preact/signals'
import { connection } from './state.js'
import { send } from './transport.js'

type UplinkPartial = Parameters<typeof send>[0]

export type OutboxItem = { id: number; partial: UplinkPartial; queuedAt: number }

export const outbox = signal<OutboxItem[]>([])

/** FIFO cap — beyond this the oldest queued uplink is dropped. */
export const OUTBOX_CAP = 20

const QUEUEABLE: ReadonlySet<string> = new Set(['chip_tap', 'feedback', 'settings', 'consent'])

export function isQueueable(kind: string): boolean {
  return QUEUEABLE.has(kind)
}

let nextId = 1

/** Pure: append with the FIFO cap applied. */
export function enqueue(list: OutboxItem[], item: OutboxItem): OutboxItem[] {
  const next = [...list, item]
  return next.length > OUTBOX_CAP ? next.slice(next.length - OUTBOX_CAP) : next
}

/**
 * Send items in order via the injected sender; stop at the first failure
 * and return the remainder (still queued). Injectable = testable offline.
 */
export async function flush(
  items: OutboxItem[],
  sender: (partial: UplinkPartial) => Promise<boolean>,
): Promise<OutboxItem[]> {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item) continue
    const ok = await sender(item.partial).catch(() => false)
    if (!ok) return items.slice(i)
  }
  return []
}

/**
 * The one call sites use: send now if live; queue when the connection is
 * down (or the send fails) and the kind allows it.
 */
export async function dispatch(partial: UplinkPartial): Promise<'sent' | 'queued' | 'failed'> {
  const kind = (partial as { kind: string }).kind
  if (connection.value !== 'live' && isQueueable(kind)) {
    outbox.value = enqueue(outbox.value, { id: nextId++, partial, queuedAt: Date.now() })
    armDrainRetry()
    return 'queued'
  }
  const ok = await send(partial)
  if (ok) {
    // A send that lands proves the stream is actually healthy — flush anything
    // that queued while it merely looked down (gateway 500 / dead session that
    // never flipped connection off 'live').
    void drainOutbox()
    return 'sent'
  }
  if (isQueueable(kind)) {
    outbox.value = enqueue(outbox.value, { id: nextId++, partial, queuedAt: Date.now() })
    // Failed though still 'live' → the 'live' subscription won't fire again, so
    // nothing would ever drain this. Arm the bounded retry ourselves.
    armDrainRetry()
    return 'queued'
  }
  return 'failed'
}

// Reconnect → drain, guarded so overlapping 'live' flips can't double-send.
let draining = false
export async function drainOutbox(): Promise<void> {
  if (draining || outbox.value.length === 0) return
  draining = true
  try {
    outbox.value = await flush(outbox.value, send)
  } finally {
    draining = false
  }
}

/** Retry cadence and the ceiling on consecutive no-progress attempts before we
 * stop spinning (a fresh enqueue or a 'live' transition rearms from zero). */
export const DRAIN_RETRY_MS = 4000
export const DRAIN_MAX_ATTEMPTS = 8

let drainTimer: ReturnType<typeof setTimeout> | null = null
let drainAttempts = 0

/** Cancel the retry loop and reset its budget (outbox drained, or offline). */
export function cancelDrainRetry(): void {
  if (drainTimer) clearTimeout(drainTimer)
  drainTimer = null
  drainAttempts = 0
}

/**
 * Arm the bounded, self-cancelling retry loop. While the connection reads
 * 'live' and items linger, retry the drain every DRAIN_RETRY_MS; give up after
 * DRAIN_MAX_ATTEMPTS consecutive attempts that make no progress. Cancels the
 * moment the outbox empties. Callers rearm on enqueue / reconnect so a stuck
 * item can't sit forever behind a misleading '{n} QUEUED' row.
 */
export function armDrainRetry(): void {
  if (drainTimer) return // already ticking
  if (connection.value !== 'live' || outbox.value.length === 0) return
  if (drainAttempts >= DRAIN_MAX_ATTEMPTS) return
  drainTimer = setTimeout(async () => {
    drainTimer = null
    const before = outbox.value.length
    await drainOutbox()
    // Progress (item(s) sent) earns a fresh budget; a no-op counts against it.
    drainAttempts = outbox.value.length < before ? 0 : drainAttempts + 1
    armDrainRetry()
  }, DRAIN_RETRY_MS)
}

connection.subscribe((v) => {
  if (v === 'live') {
    drainAttempts = 0
    void drainOutbox().then(armDrainRetry)
  } else {
    cancelDrainRetry()
  }
})
