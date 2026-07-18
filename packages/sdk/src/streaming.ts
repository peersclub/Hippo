/**
 * Streaming state — pure, UI-free.
 *
 * A research brief is mid-stream exactly when the thread's last item is the
 * accumulating brief_delta card (state.ts merges consecutive deltas into
 * one). The authoritative research_brief replaces that card, so the moment
 * it lands — or anything else arrives — the thread is no longer streaming.
 *
 * While streaming, the composer's send button becomes a stop control that
 * fires a `stream_stop` uplink. Thin client: the SDK only signals intent;
 * the SERVER decides what the stopped answer looks like.
 */
import type { ThreadItem } from './state.js'

export function isStreaming(items: ThreadItem[]): boolean {
  const last = items[items.length - 1]
  return last?.kind === 'frame' && last.frame.type === 'brief_delta'
}
