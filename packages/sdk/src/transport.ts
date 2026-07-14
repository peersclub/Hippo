import { parseFrame, type Uplink } from '@hippo/protocol'
import { connection, pushFrame, sessionId, suggestedQueries, venueName } from './state.js'

export type TransportConfig = { gateway: string; key: string }

let cfg: TransportConfig | null = null
let es: EventSource | null = null

/** POST /v1/session then open the SSE stream. Reconnects with backoff. */
export async function connect(config: TransportConfig): Promise<void> {
  cfg = config
  connection.value = 'connecting'
  try {
    const res = await fetch(`${config.gateway}/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ partnerKey: config.key }),
    })
    if (!res.ok) throw new Error(`session ${res.status}`)
    const data = (await res.json()) as {
      sessionId: string
      config?: { venueName?: string; suggestedQueries?: string[] }
    }
    sessionId.value = data.sessionId
    if (data.config?.venueName) venueName.value = data.config.venueName
    if (data.config?.suggestedQueries) suggestedQueries.value = data.config.suggestedQueries
    openStream()
  } catch {
    connection.value = 'offline'
    setTimeout(() => cfg && connect(cfg), 3000)
  }
}

function openStream() {
  if (!cfg || !sessionId.value) return
  es?.close()
  es = new EventSource(`${cfg.gateway}/v1/stream?session=${sessionId.value}`)
  es.onopen = () => {
    connection.value = 'live'
  }
  es.onmessage = (ev) => {
    const parsed = parseFrame(ev.data)
    if (parsed.ok) pushFrame({ kind: 'frame', frame: parsed.frame })
    else if (parsed.unknown) pushFrame({ kind: 'unknown', frame: parsed.unknown })
    // Unparseable bytes are dropped silently — the SDK never throws on wire data.
  }
  es.onerror = () => {
    connection.value = 'offline'
    // EventSource retries automatically; reflect state only.
  }
}

/**
 * Fire an uplink. Envelope fields are stamped here. Returns whether the
 * gateway accepted it — callers holding user text must restore it on false
 * (edge state №6: nothing the trader wrote is ever lost).
 */
export async function send(
  partial: DistributiveOmit<Uplink, 'v' | 'sessionId' | 'ts'>,
): Promise<boolean> {
  if (!cfg || !sessionId.value) return false
  const uplink = { v: 1, sessionId: sessionId.value, ts: Date.now(), ...partial }
  try {
    const res = await fetch(`${cfg.gateway}/v1/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(uplink),
    })
    return res.ok
  } catch {
    connection.value = 'offline'
    return false
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
