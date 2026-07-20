/**
 * Streaming state — the mid-stream predicate plus the stalled-stream watchdog.
 *
 * A research brief is mid-stream exactly when the thread's last item is the
 * accumulating brief_delta card (state.ts merges consecutive deltas into
 * one). The authoritative research_brief replaces that card, so the moment
 * it lands — or anything else arrives — the thread is no longer streaming.
 *
 * While streaming, the composer's send button becomes a stop control that
 * fires a `stream_stop` uplink. Thin client: the SDK only signals intent;
 * the SERVER decides what the stopped answer looks like.
 *
 * Watchdog: if the server crashes mid-stream the deltas simply stop and the
 * authoritative brief never arrives — the card would blink its cursor
 * forever. A client-side timer (armed on every delta by state.ts) finalizes
 * the card honestly once the deadline lapses: the delta's id is recorded in
 * `interruptedStreamIds`, which stops the cursor (cards.tsx) and flips
 * `isStreaming` false (composer reverts from stop → send).
 */
import { signal } from '@preact/signals'
import type { ThreadItem } from './state.js'

/** brief_delta ids whose stream stalled and was finalized client-side. A
 * finalized delta is no longer "streaming" and renders without a cursor. */
export const interruptedStreamIds = signal<Set<string>>(new Set())

export function isStreaming(items: ThreadItem[]): boolean {
  const last = items[items.length - 1]
  return (
    last?.kind === 'frame' &&
    last.frame.type === 'brief_delta' &&
    !interruptedStreamIds.value.has(last.frame.id)
  )
}

/** Deadline after the last delta before a silent stream is declared stalled. */
export const STREAM_WATCHDOG_MS = 20_000

let watchdogTimer: ReturnType<typeof setTimeout> | null = null

/** (Re)arm the stall watchdog — called on every delta, so the deadline is
 * always measured from the most recent delta. */
export function armStreamWatchdog(onStall: () => void, delay = STREAM_WATCHDOG_MS) {
  clearStreamWatchdog()
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null
    onStall()
  }, delay)
}

export function clearStreamWatchdog() {
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
}
