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
    return 'queued'
  }
  const ok = await send(partial)
  if (ok) return 'sent'
  if (isQueueable(kind)) {
    outbox.value = enqueue(outbox.value, { id: nextId++, partial, queuedAt: Date.now() })
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

connection.subscribe((v) => {
  if (v === 'live') void drainOutbox()
})
