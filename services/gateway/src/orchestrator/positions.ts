/**
 * In-memory demo portfolio — open orders and positions.
 *
 * SEAM STUB: in Phase 3 the seam service (Canonical Trading Interface, per-
 * venue adapter — Build Plan/04) serves `seam.positions()` / `seam.orders()`
 * from the real venue; this table exists so the gateway's routing, frames and
 * telemetry are exercised end-to-end before that adapter lands. Portfolio
 * data is NEVER cached (BE doc §2).
 */

export type OpenOrder = {
  orderId: string
  side: 'buy' | 'sell'
  summary: string
  status: string
}

export type PositionRow = {
  instrument: string
  size: string
  entry: string
  mark: string
  pnl: string
  tone: 'pos' | 'neg' | 'neutral'
}

export const demoOpenOrders: OpenOrder[] = [
  { orderId: 'o_btc', side: 'buy', summary: 'BUY 0.05 BTC · MKT', status: 'FILLING 40%' },
  { orderId: 'o_sol', side: 'sell', summary: 'SELL 12 SOL @ 168.00', status: 'OPEN' },
  { orderId: 'o_ada', side: 'buy', summary: 'BUY 2,500 ADA @ 0.5210', status: 'OPEN' },
]

export const demoPositions: PositionRow[] = [
  {
    instrument: 'BTC/USDT',
    size: '0.31 BTC',
    entry: '58,420',
    mark: '61,240',
    pnl: '+874.20 USDT',
    tone: 'pos',
  },
  {
    instrument: 'SOL/USDT',
    size: '42 SOL',
    entry: '171.10',
    mark: '166.40',
    pnl: '−197.40 USDT',
    tone: 'neg',
  },
  {
    instrument: 'ADA/USDT',
    size: '5,000 ADA',
    entry: '0.4980',
    mark: '0.5210',
    pnl: '+115.00 USDT',
    tone: 'pos',
  },
]
