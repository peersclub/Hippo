import { parseFrame, type Uplink } from '@hippo/protocol'
import { connection, pushFrame, sessionId, suggestedQueries, venueName } from './state.js'

export type TransportConfig = { gateway: string; key: string }

let cfg: TransportConfig | null = null
let es: EventSource | null = null

// Reconnect backoff. Transient failures (5xx / network / a dead stream) climb
// an exponential ladder capped at BACKOFF_MAX; a genuinely live stream resets
// it. Capacity (429) is recoverable but not soon, so it waits far longer.
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000
const CAPACITY_RETRY_MS = 5 * 60_000
let backoff = BACKOFF_BASE_MS
let retryTimer: ReturnType<typeof setTimeout> | null = null

function scheduleReconnect(delay: number) {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (cfg) void connect(cfg)
  }, delay)
}

/** Read the current step, then climb the ladder for the next failure. */
function nextBackoff(): number {
  const delay = backoff
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
  return delay
}

type MintResult = 'ok' | 'blocked' | 'capacity' | 'retry'

/**
 * POST /v1/session and, on success, stamp the session state. Classifies the
 * status so callers can branch: 401 is terminal (blocked), 429 is terminal for
 * now (capacity), everything else non-ok — 5xx and network — is retryable.
 */
async function mint(config: TransportConfig): Promise<MintResult> {
  let res: Response
  try {
    res = await fetch(`${config.gateway}/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ partnerKey: config.key }),
    })
  } catch {
    return 'retry'
  }
  if (res.status === 401) return 'blocked'
  if (res.status === 429) return 'capacity'
  if (!res.ok) return 'retry'
  try {
    const data = (await res.json()) as {
      sessionId: string
      config?: { venueName?: string; suggestedQueries?: string[] }
    }
    sessionId.value = data.sessionId
    if (data.config?.venueName) venueName.value = data.config.venueName
    if (data.config?.suggestedQueries) suggestedQueries.value = data.config.suggestedQueries
    return 'ok'
  } catch {
    return 'retry'
  }
}

/** Reflect a non-ok mint result as a connection state + retry policy. */
function applyMintFailure(r: Exclude<MintResult, 'ok'>) {
  if (r === 'blocked') {
    // Invalid key or blocked user — nothing the trader can do. Disable the
    // surface quietly (no error banner) and never retry.
    connection.value = 'blocked'
    return
  }
  if (r === 'capacity') {
    // MAU quota is spent this month — recoverable, but not soon. Friendly
    // capacity state, long backoff (the quota could reset / be raised).
    connection.value = 'capacity'
    scheduleReconnect(CAPACITY_RETRY_MS)
    return
  }
  // 5xx / network — transient. Exponential backoff, never give up.
  connection.value = 'offline'
  scheduleReconnect(nextBackoff())
}

/** POST /v1/session then open the SSE stream. Reconnects with backoff. */
export async function connect(config: TransportConfig): Promise<void> {
  cfg = config
  connection.value = 'connecting'
  const r = await mint(config)
  if (r === 'ok') openStream()
  else applyMintFailure(r)
}

function openStream() {
  if (!cfg || !sessionId.value) return
  es?.close()
  es = new EventSource(`${cfg.gateway}/v1/stream?session=${sessionId.value}`)
  es.onopen = () => {
    connection.value = 'live'
    backoff = BACKOFF_BASE_MS // a genuinely live stream earns a fresh ladder
  }
  es.onmessage = (ev) => {
    const parsed = parseFrame(ev.data)
    if (parsed.ok) pushFrame({ kind: 'frame', frame: parsed.frame })
    else if (parsed.unknown) pushFrame({ kind: 'unknown', frame: parsed.unknown })
    // Unparseable bytes are dropped silently — the SDK never throws on wire data.
  }
  es.onerror = () => {
    connection.value = 'offline'
    // When the browser's own reconnect gets a non-200 (session expired,
    // revoked, or gateway restarted) readyState goes CLOSED and it stops
    // retrying forever. Mint a FRESH session with backoff rather than sit on
    // 'Reconnecting'. A CONNECTING readyState means it's still retrying the
    // same session on its own — let it recover, just reflect the drop.
    if (es?.readyState === EventSource.CLOSED) {
      es = null
      scheduleReconnect(nextBackoff())
    }
  }
}

type TurnResult = 'ok' | 'unknown_session' | 'fail'

async function postTurn(uplink: Uplink): Promise<TurnResult> {
  try {
    const res = await fetch(`${cfg?.gateway}/v1/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(uplink),
    })
    if (res.ok) return 'ok'
    if (res.status === 404) return 'unknown_session' // gateway forgot our session
    return 'fail'
  } catch {
    connection.value = 'offline'
    return 'fail'
  }
}

/**
 * Fire an uplink. Envelope fields are stamped here. Returns whether the
 * gateway accepted it — callers holding user text must restore it on false
 * (edge state №6: nothing the trader wrote is ever lost).
 *
 * A 404 'unknown session' means the gateway dropped our session out from under
 * us. We mint a fresh one and replay this uplink ONCE (re-stamped with the new
 * session id) before reporting failure.
 */
export async function send(
  partial: DistributiveOmit<Uplink, 'v' | 'sessionId' | 'ts'>,
): Promise<boolean> {
  if (!cfg || !sessionId.value) return false
  const stamp = (): Uplink =>
    ({ v: 1, sessionId: sessionId.value, ts: Date.now(), ...partial }) as Uplink
  const first = await postTurn(stamp())
  if (first === 'ok') return true
  if (first !== 'unknown_session') return false
  const r = await mint(cfg)
  if (r !== 'ok') {
    applyMintFailure(r)
    return false
  }
  openStream()
  return (await postTurn(stamp())) === 'ok'
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
