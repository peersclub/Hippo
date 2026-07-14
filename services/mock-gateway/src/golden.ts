/**
 * Golden conversation — frame scripts extracted from the prototype
 * (Reference/prototype-index.html). Content decisions live server-side;
 * the SDK only draws. Every draft is validated against @hippo/protocol
 * at send time — a drifted fixture fails loudly, not silently.
 */

export type FrameDraft = { type: string } & Record<string, unknown>
export type ScriptStep = { afterMs: number; frame: FrameDraft }

export const VENUE = 'KoinBX'

export const ordersSnapshot: FrameDraft = {
  type: 'orders_snapshot',
  open: [
    { orderId: 'o_btc', side: 'buy', summary: 'BUY 0.05 BTC · MKT', status: 'FILLING 40%' },
    { orderId: 'o_sol', side: 'sell', summary: 'SELL 12 SOL @ 168.00', status: 'OPEN' },
    { orderId: 'o_ada', side: 'buy', summary: 'BUY 2,500 ADA @ 0.5210', status: 'OPEN' },
  ],
  positionsCount: 3,
}

const btcBrief: FrameDraft = {
  type: 'research_brief',
  eyebrow: 'MARKET BRIEF',
  live: true,
  headline: 'BTC is down 4.2% over 12 hours',
  paragraphs: [
    'US inflation came in hotter than expected at 18:00 IST, pushing rate-cut expectations later into the year. Risk assets sold off broadly — BTC led the move down.',
    'Around $310M in leveraged longs unwound in the past hour, and funding has flipped mildly negative.',
  ],
  stats: [
    { k: 'LAST', v: '61,240', tone: 'neutral' },
    { k: '12H', v: '−4.2%', tone: 'neg' },
    { k: 'FUNDING', v: '−0.008%', tone: 'neg' },
  ],
  spark: {
    points: [11, 8, 15, 13, 11, 22, 26, 29, 26, 35, 43, 39, 41],
    captionLeft: 'BTC/USDT · 12H',
    captionRight: '$61,240',
  },
  sources: ['PRICE FEED', 'FUNDING', 'NEWS ×2'],
  liveBar: {
    asOf: 'AS OF 14:32:05 IST',
    asOfIso: '2026-07-14T09:02:05.000Z',
    refreshable: true,
    shareable: true,
    feedback: true,
    cached: false,
  },
  followups: ["What's driving SOL volume?", 'Explain liquidations'],
}

const btcTicket: FrameDraft = {
  type: 'order_ticket',
  ticketId: 't_btc_1',
  title: 'Order prepared',
  side: 'buy',
  sideLabel: 'BUY · MKT',
  rows: [
    { label: 'Instrument', value: 'BTC / USDT' },
    { label: 'Size', value: '0.05000 BTC' },
    { label: 'Est. price', value: '61,240.00' },
    { label: 'Est. cost incl. fees', value: '3,068.30 USDT' },
  ],
  cta: `Review & confirm in ${VENUE} →`,
  footnote: `Hippo prepared this order. ${VENUE} will ask you to confirm before anything executes.`,
}

const dipDecline: FrameDraft = {
  type: 'advice_decline',
  badge: '◇ NO ADVICE — BY DESIGN',
  message:
    "I can't tell you whether to buy — not because I'm hedging, but because an assistant that gives trading calls isn't on your side. What I can do is show you the picture:",
  pivotTitle: "What's true about BTC right now",
  facts: [
    { icon: '▾', text: 'Down 4.2% in 12h on the US inflation surprise — a macro move, not a BTC-specific one.' },
    { icon: '◎', text: 'Funding is −0.008% — shorts now pay longs; positioning has flipped cautious.' },
    { icon: '≋', text: '$310M in longs liquidated in an hour — forced selling, most of which has now cleared.' },
  ],
  followups: ['How do dips usually resolve?', 'What would change this picture?'],
}

const thinking = (lines: string[]): FrameDraft => ({ type: 'thinking', lines })
const skeleton = (shape: string): FrameDraft => ({ type: 'skeleton', shape })
const userEcho = (text: string): FrameDraft => ({ type: 'user_echo', text })

/** Played automatically when a stream connects — the prototype's opening thread. */
export const openingScript: ScriptStep[] = [
  { afterMs: 200, frame: userEcho('why is btc down today?') },
  { afterMs: 500, frame: thinking(['Parsing intent…', 'Fetching live market data…', 'Reading funding & liquidations…']) },
  { afterMs: 1400, frame: skeleton('brief') },
  { afterMs: 1200, frame: btcBrief },
  { afterMs: 1600, frame: userEcho('ok. buy 0.05 btc at market') },
  { afterMs: 900, frame: btcTicket },
  { afterMs: 1600, frame: userEcho('actually should i just buy more? is this the dip?') },
  { afterMs: 1000, frame: dipDecline },
]

/** Keyword-routed replies to live user turns. */
export function replyScriptFor(text: string): ScriptStep[] {
  const t = text.toLowerCase()

  if (/\b(buy|sell)\b/.test(t)) {
    return [
      { afterMs: 300, frame: thinking(['Parsing intent…', 'Building your ticket…', 'Fetching live price & fees…']) },
      { afterMs: 1100, frame: { ...btcTicket, ticketId: `t_${Date.now().toString(36)}` } },
    ]
  }

  if (/should i|good idea|what would you|recommend|advice|is this the dip/.test(t)) {
    return [
      { afterMs: 300, frame: thinking(['Parsing intent…']) },
      { afterMs: 800, frame: dipDecline },
    ]
  }

  if (/position|p&l|pnl|portfolio/.test(t)) {
    return [
      { afterMs: 300, frame: thinking(['Fetching your positions…']) },
      {
        afterMs: 900,
        frame: {
          type: 'positions',
          rows: [
            { instrument: 'BTC/USDT', size: '0.31 BTC', entry: '58,420', mark: '61,240', pnl: '+874.20 USDT', tone: 'pos' },
            { instrument: 'SOL/USDT', size: '42 SOL', entry: '171.10', mark: '166.40', pnl: '−197.40 USDT', tone: 'neg' },
            { instrument: 'ADA/USDT', size: '5,000 ADA', entry: '0.4980', mark: '0.5210', pnl: '+115.00 USDT', tone: 'pos' },
          ],
        },
      },
    ]
  }

  return [
    { afterMs: 300, frame: thinking(['Parsing intent…', 'Fetching live market data…']) },
    { afterMs: 1200, frame: skeleton('brief') },
    { afterMs: 1100, frame: { ...btcBrief, headline: 'Here is the live picture', followups: ['My positions & P&L', 'Explain funding rates'] } },
  ]
}

/** Lifecycle continuation after a ticket confirm handoff. */
export function lifecycleScriptFor(ticketId: string): ScriptStep[] {
  return [
    {
      afterMs: 300,
      frame: {
        type: 'lifecycle',
        ticketId,
        phase: 'awaiting_confirm',
        statusLine: `WAITING FOR YOUR CONFIRM ON ${VENUE.toUpperCase()}`,
        cancellable: true,
      },
    },
    {
      afterMs: 3500,
      frame: {
        type: 'lifecycle',
        ticketId,
        phase: 'filled',
        statusLine: 'FILLED',
        venueOrderId: 'KBX-88412039',
        rows: [
          { label: 'Avg fill', value: '61,238.50' },
          { label: 'Fees (actual)', value: '3.07 USDT' },
          { label: 'Venue order ID', value: 'KBX-88412039' },
        ],
      },
    },
  ]
}

/** Ambient pulse for the minimized pill. */
export const marketPulse: FrameDraft = { type: 'pulse', tag: '· BTC −4.2%' }
