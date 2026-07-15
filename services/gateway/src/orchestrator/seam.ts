/**
 * Client for services/seam — the Canonical Trading Interface. The gateway
 * never quotes, prices or executes anything itself: it forwards prepared
 * tickets as frames and venue lifecycle events back into the thread.
 * Lifecycle events arrive on POST /internal/venue-events (the callbackUrl
 * given at confirm time).
 */

const SEAM_URL = process.env.SEAM_URL ?? 'http://localhost:8793'
/** Where the seam delivers venue events — this gateway's internal route. */
const GATEWAY_CALLBACK_URL =
  process.env.GATEWAY_CALLBACK_URL ?? 'http://localhost:8788/internal/venue-events'
const SEAM_TIMEOUT_MS = 5_000

export type PreparedTicket = {
  ticketId: string
  side: 'buy' | 'sell'
  instrument: string
  orderType: 'market' | 'limit'
  sideLabel: string
  rows: Array<{ label: string; value: string }>
}

export type VenueEvent = {
  ticketId: string
  phase: 'awaiting_confirm' | 'filled' | 'partial' | 'cancelled' | 'expired'
  statusLine: string
  venueOrderId?: string
  fillPct?: number
  rows?: Array<{ label: string; value: string }>
}

export type SeamPortfolio = {
  positions: Array<{
    instrument: string
    size: string
    entry: string
    mark: string
    pnl: string
    tone: 'pos' | 'neg' | 'neutral'
  }>
  openOrders: Array<{
    orderId: string
    side: 'buy' | 'sell'
    summary: string
    status: string
  }>
}

export interface SeamClient {
  /** Rejects on validation/venue/network failure — caller emits a rejection. */
  prepare(req: {
    partnerId: string
    userId: string
    side: 'buy' | 'sell'
    size: string
    instrument: string
    orderType: 'market' | 'limit'
    limitPrice?: string
  }): Promise<PreparedTicket>
  confirm(ticketId: string): Promise<void>
  cancel(ticketId: string): Promise<void>
  /** Rejects when the seam is down — portfolio is never served stale. */
  portfolio(partnerId: string, userId: string): Promise<SeamPortfolio>
}

async function json<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(SEAM_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`seam ${res.status} for ${url}`)
  return (await res.json()) as T
}

export function createSeamClient(
  baseUrl = SEAM_URL,
  callbackUrl = GATEWAY_CALLBACK_URL,
): SeamClient {
  return {
    prepare: (req) =>
      json<PreparedTicket>(`${baseUrl}/v1/prepare`, {
        method: 'POST',
        body: JSON.stringify(req),
      }),
    confirm: async (ticketId) => {
      await json(`${baseUrl}/v1/tickets/${ticketId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ callbackUrl }),
      })
    },
    cancel: async (ticketId) => {
      await json(`${baseUrl}/v1/tickets/${ticketId}/cancel`, {
        method: 'POST',
        body: '{}',
      })
    },
    portfolio: (partnerId, userId) =>
      json<SeamPortfolio>(
        `${baseUrl}/v1/portfolio/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`,
        { method: 'GET' },
      ),
  }
}
