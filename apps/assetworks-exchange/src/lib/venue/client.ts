// Client for the host-venue backend. All calls go through the Next `/venue/*`
// rewrite (see next.config.js) so the browser stays same-origin.
import type { AdminConfig, StreamEvent, TicketInput } from "./types"

const V = "/venue"

/** Map the human ticket to the signed wire body host-venue expects. */
function toWire(t: TicketInput) {
  const body: Record<string, unknown> = {
    pairName: t.pair.replace("/", "-"),
    market: t.market,
    orderType: t.side === "sell" ? 1 : 0,
    tradeType: t.kind === "market" ? 20 : 10,
    qty: t.qty,
    rate: t.kind === "limit" ? (t.limitPrice ?? 0) : 0, // rate 0 for market → filled from live price
  }
  if (t.market === "perp") {
    body.direction = t.side === "buy" ? "long" : "short"
    body.leverage = t.leverage
    body.marginMode = t.marginMode
    body.reduceOnly = t.reduceOnly
  }
  return body
}

export async function placeOrder(t: TicketInput, livePrice: number): Promise<{ ok: boolean; error?: string }> {
  const body = toWire(t)
  if (t.kind === "market") body.rate = livePrice // host needs a rate for market notional
  const res = await fetch(`${V}/ui/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.ok) return { ok: true }
  const j = await res.json().catch(() => ({}))
  return { ok: false, error: j.error ?? `HTTP ${res.status}` }
}

export async function cancelOrder(id: number): Promise<void> {
  await fetch(`${V}/ui/orders/${id}/cancel`, { method: "POST" })
}

export async function getConfig(): Promise<AdminConfig | null> {
  try {
    return (await (await fetch(`${V}/admin/config`)).json()) as AdminConfig
  } catch {
    return null
  }
}

export async function setConfig(patch: Partial<AdminConfig>): Promise<void> {
  await fetch(`${V}/admin/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
}

export async function approveHandoff(clientOrderId: string): Promise<void> {
  await fetch(`${V}/ui/handoff/${clientOrderId}/approve`, { method: "POST" })
}
export async function rejectHandoff(clientOrderId: string): Promise<void> {
  await fetch(`${V}/ui/handoff/${clientOrderId}/reject`, { method: "POST" })
}

/** Subscribe to the venue SSE stream. Returns an unsubscribe fn. */
export function subscribeVenue(onEvent: (e: StreamEvent) => void, onStatus: (up: boolean) => void): () => void {
  const es = new EventSource(`${V}/stream`)
  es.onopen = () => onStatus(true)
  es.onerror = () => onStatus(false)
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as StreamEvent)
    } catch {
      /* ignore malformed frame */
    }
  }
  return () => es.close()
}
