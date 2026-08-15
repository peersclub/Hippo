/**
 * Share cards — the resolving half of baseline §6 ("sharing produces a live,
 * co-branded card, not a screenshot").
 *
 * POST /v1/shares turns a research_brief the session already received into a
 * short id; GET /s/:id renders that brief as a co-branded HTML/OG card page.
 * The page RE-GROUNDS on open: the live price strip is fetched from
 * market-data at request time, so a link opened tomorrow shows tomorrow's
 * price next to the brief's own (honestly timestamped) prose — never a stale
 * snapshot dressed up as current.
 *
 * Tenancy is structural, not filtered: a ShareRecord carries ONLY the brief's
 * market-level content (headline, paragraphs, symbol) plus the partner's
 * venue name for co-branding. No sessionId, no userKey, no identity — briefs
 * are fleet-cacheable by design (the cache law), so the shareable surface is
 * exactly the cacheable surface. A leaked share id can therefore never leak
 * a person.
 *
 * The advice line is printed IN the card body (screenshot-proof), never just
 * a meta tag: "MARKET INFORMATION · NOT INVESTMENT ADVICE" — counsel-owned,
 * deliberately English (same rule as the SDK overlay's printed line).
 *
 * Shares are TTL'd (SHARE_TTL_MS, default 7 days) and the store is in-memory
 * for the pilot — an expired or restart-lost id renders an honest "link
 * expired" page, never a broken one. The ShareStore interface is the seam a
 * Postgres store slots into when share links must survive restarts.
 */
import { randomUUID } from 'node:crypto'
import type { ResearchBrief } from '@hippo/protocol'
import type { FastifyInstance } from 'fastify'
import type { MarketClient, MarketSnapshot } from './orchestrator/market.js'
import { asOfDisplay, symbolFromText } from './orchestrator/market.js'
import type { SessionStore } from './plugins/auth.js'

export const DEFAULT_SHARE_TTL_MS = 7 * 24 * 60 * 60_000

/** Bound on retained shares — oldest evicted first (in-memory pilot store). */
export const SHARE_STORE_CAP = 10_000

/** The printed advice line. Must appear in the rendered card BODY. */
export const SHARE_DISCLAIMER = 'MARKET INFORMATION · NOT INVESTMENT ADVICE'

/** Fallback market when neither the headline nor the session names one. */
const DEFAULT_SYMBOL = 'BTC/USDT'

const SHARE_ID_RE = /^[a-f0-9]{12}$/

/**
 * Market-level content only — see the tenancy note in the module header.
 * Adding a session/user field here is a design violation, not an oversight.
 */
export type ShareRecord = {
  id: string
  partnerId: string
  venueName: string
  /** The market the brief is about — re-grounded live at every page open. */
  symbol: string
  headline: string
  paragraphs: string[]
  /** The brief's own as-of stamp (display + ISO), when it carried one. */
  asOf?: string
  createdAt: number
  expiresAt: number
}

export interface ShareStore {
  create(record: ShareRecord): void
  /** Live record or null — expiry is checked here, so a hit is never stale. */
  get(id: string, now?: number): ShareRecord | null
}

export class InMemoryShareStore implements ShareStore {
  private readonly rows = new Map<string, ShareRecord>()

  create(record: ShareRecord): void {
    // Sweep expired rows opportunistically, then cap FIFO (Map preserves
    // insertion order) so a create-happy client can't grow memory unbounded.
    const now = Date.now()
    for (const [id, row] of this.rows) {
      if (row.expiresAt <= now) this.rows.delete(id)
    }
    while (this.rows.size >= SHARE_STORE_CAP) {
      const oldest = this.rows.keys().next().value
      if (oldest === undefined) break
      this.rows.delete(oldest)
    }
    this.rows.set(record.id, record)
  }

  get(id: string, now: number = Date.now()): ShareRecord | null {
    const row = this.rows.get(id)
    if (!row) return null
    if (row.expiresAt <= now) {
      this.rows.delete(id)
      return null
    }
    return row
  }
}

export function newShareId(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12)
}

/** Every record/market string lands in HTML — escape all five metacharacters. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Shared card-page chrome (dark, amber accent — the SDK's own palette). */
const PAGE_CSS = `
  :root{color-scheme:dark}
  *{margin:0;box-sizing:border-box}
  body{background:#0F1116;color:#E9EBF0;font:15px/1.6 system-ui,sans-serif;
    display:flex;justify-content:center;padding:40px 16px}
  .card{width:100%;max-width:460px;background:#171A21;border:1px solid rgba(240,185,74,.35);
    border-radius:18px;padding:26px;display:flex;flex-direction:column;gap:14px;height:fit-content}
  .brand{display:flex;align-items:center;gap:8px}
  .mark{width:22px;height:22px;border-radius:7px;background:#F0B94A;color:#171A21;
    display:grid;place-items:center;font-weight:700;font-size:11px}
  .brand b{font-size:14px}
  .brand .on{color:#8A8F9C;font-size:12px}
  h1{font-size:19px;line-height:1.35;font-weight:650}
  .prose p{font-size:13.5px;color:#B9BEC9}
  .prose{display:flex;flex-direction:column;gap:10px}
  .live{display:flex;flex-wrap:wrap;gap:14px;border:1px solid rgba(255,255,255,.08);
    border-radius:12px;padding:12px 14px;font-family:ui-monospace,monospace}
  .live .k{display:block;font-size:8.5px;letter-spacing:.14em;color:#8A8F9C}
  .live .v{font-size:14px}
  .live .neg{color:#FF8585}
  .live .pos{color:#2EC48D}
  .stamp{font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.1em;color:#5C6270}
  .disc{font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.16em;color:#8A8F9C;
    text-align:center;border-top:1px dashed rgba(255,255,255,.1);padding-top:12px}
`

function page(title: string, description: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta name="twitter:card" content="summary">
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="card">
${body}
</main>
</body>
</html>`
}

/**
 * The co-branded card. `live` is the snapshot fetched AT OPEN TIME (null when
 * market-data was unreachable — the card renders honestly without a current
 * price rather than resurrecting the brief-time one as if it were live).
 */
export function renderShareCard(record: ShareRecord, live: MarketSnapshot | null): string {
  const venue = escapeHtml(record.venueName)
  const headline = escapeHtml(record.headline)
  const prose = record.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')
  const liveStrip = live
    ? `<div class="live">
  <span><span class="k">${escapeHtml(live.symbol)} · NOW</span><span class="v">${escapeHtml(live.lastDisplay)}</span></span>
  <span><span class="k">12H</span><span class="v ${live.change12hPct < 0 ? 'neg' : 'pos'}">${escapeHtml(live.change12hDisplay)}</span></span>
  <span><span class="k">CHECKED</span><span class="v">${escapeHtml(asOfDisplay(live.asOfIso))}</span></span>
</div>`
    : `<div class="stamp">LIVE PRICE UNAVAILABLE RIGHT NOW — THE BRIEF BELOW KEEPS ITS OWN TIMESTAMP</div>`
  const stamp = record.asOf ? `<div class="stamp">BRIEF ${escapeHtml(record.asOf)}</div>` : ''
  // og:description carries the first paragraph + the advice line, so even the
  // unfurl preview never crosses it; the printed .disc line is the real one.
  const description = escapeHtml(
    `${record.paragraphs[0] ?? record.headline} — ${SHARE_DISCLAIMER}`.slice(0, 300),
  )
  return page(
    `${headline} — Hippo on ${venue}`,
    description,
    `<div class="brand"><span class="mark">H</span><b>Hippo</b><span class="on">on ${venue}</span></div>
<h1>${headline}</h1>
<div class="prose">${prose}</div>
${liveStrip}
${stamp}
<div class="disc">${SHARE_DISCLAIMER}</div>`,
  )
}

/** Unknown/expired id — an honest page, never a bare 404 body. */
export function renderShareMissing(): string {
  return page(
    'This shared brief has expired — Hippo',
    'Shared market briefs are time-limited by design.',
    `<div class="brand"><span class="mark">H</span><b>Hippo</b></div>
<h1>This shared brief has expired</h1>
<div class="prose"><p>Shared market briefs are time-limited by design — market commentary goes stale. Ask Hippo on your exchange for the current picture.</p></div>
<div class="disc">${SHARE_DISCLAIMER}</div>`,
  )
}

type Log = {
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
}

export type ShareRoutesDeps = {
  sessions: SessionStore
  market: MarketClient
  store: ShareStore
  log: Log
  /** Per-IP limiter (shared with mint/turns) — creation AND the public page. */
  rateLimit?: import('./plugins/rate-limit.js').RateLimitHandler
  /** Public origin for minted URLs (GATEWAY_PUBLIC_URL). Unset: the request's
   * own host — correct behind the same ingress the SDK already talks to. */
  publicUrl?: string
  /** Share lifetime override (tests). Defaults to SHARE_TTL_MS ?? 7 days. */
  ttlMs?: number
}

export function registerShareRoutes(app: FastifyInstance, deps: ShareRoutesDeps): void {
  const { sessions, market, store, log } = deps
  const ttlMs = deps.ttlMs ?? Number(process.env.SHARE_TTL_MS ?? DEFAULT_SHARE_TTL_MS)
  const publicUrl = deps.publicUrl ?? process.env.GATEWAY_PUBLIC_URL
  const limited = deps.rateLimit ? { preHandler: deps.rateLimit } : {}

  // ── create: brief the session already holds → short id + resolving URL ──
  // Session-possession auth, exactly like /v1/turns: 400 malformed, 404
  // unknown session. The frame must BE a research_brief in this session's
  // journal — you can only share what the server actually sent you.
  app.post('/v1/shares', limited, async (req, reply) => {
    const body = (req.body ?? {}) as { sessionId?: unknown; frameId?: unknown }
    if (
      typeof body.sessionId !== 'string' ||
      body.sessionId.length === 0 ||
      typeof body.frameId !== 'string' ||
      body.frameId.length === 0 ||
      body.frameId.length > 128
    ) {
      reply.code(400)
      return { error: 'invalid share: sessionId and frameId are required' }
    }
    const session = sessions.get(body.sessionId)
    if (!session) {
      reply.code(404)
      return { error: 'unknown session' }
    }
    const entry = session.journal
      .after(0)
      .find((e) => e.frame.id === body.frameId && e.frame.type === 'research_brief')
    if (!entry) {
      reply.code(404)
      return { error: 'unknown brief' }
    }
    const brief = entry.frame as ResearchBrief
    const now = Date.now()
    const record: ShareRecord = {
      id: newShareId(),
      partnerId: session.partner.partnerId,
      venueName: session.partner.venueName,
      // The brief frame carries no symbol field; resolve it the same way the
      // orchestrator grounds research — the headline names the asset, the
      // session's page market is the fallback.
      symbol: symbolFromText(brief.headline, session.symbol ?? DEFAULT_SYMBOL),
      headline: brief.headline,
      paragraphs: brief.paragraphs,
      ...(brief.liveBar?.asOf ? { asOf: brief.liveBar.asOf } : {}),
      createdAt: now,
      expiresAt: now + ttlMs,
    }
    store.create(record)
    const base = publicUrl ?? `${req.protocol}://${req.headers.host}`
    return { id: record.id, url: `${base.replace(/\/$/, '')}/s/${record.id}` }
  })

  // ── resolve: the public, co-branded card page ────────────────────────────
  // No auth by design (a share link IS a bearer of market-level content —
  // see the tenancy note). Re-grounds on every open; a dead market feed
  // degrades to the brief's own timestamp, never a fake "current" number.
  app.get<{ Params: { id: string } }>('/s/:id', limited, async (req, reply) => {
    const { id } = req.params
    const record = SHARE_ID_RE.test(id) ? store.get(id) : null
    if (!record) {
      reply.code(404)
      return reply.type('text/html; charset=utf-8').send(renderShareMissing())
    }
    let live: MarketSnapshot | null = null
    try {
      live = await market.snapshot(record.symbol)
    } catch (err) {
      log.warn({ err, symbol: record.symbol }, 'share page: live re-ground unavailable')
    }
    return reply.type('text/html; charset=utf-8').send(renderShareCard(record, live))
  })
}
