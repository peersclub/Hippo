// Assetworks Exchange — host front end.
//
// Two live sources, deliberately separate:
//   • MARKET DATA streams straight from Binance PUBLIC WebSockets (no keys) —
//     candles, depth book, and the trade tape. This is the "real open-source
//     financial data" flowing through the host.
//   • THE VENUE STATE (our orders / positions / balances) streams from the
//     host-venue backend over SSE. Orders placed here by the human ticket AND
//     orders placed by the Hippo parasite (via the seam) both land in the same
//     backend, so both show up in this blotter — the whole point of the test.

const qs = new URLSearchParams(location.search)
// Vite inlines import.meta.env.* into JS at build time; a `%VITE_*%` placeholder
// is only replaced inside index.html, so in this module it stayed literal on
// Vercel and always fell back to localhost. import.meta.env is the real bake.
const envHost = import.meta.env.VITE_HOST_VENUE_URL || ''
const HOST = qs.get('host') || (envHost.startsWith('http') ? envHost : 'http://localhost:8796')

const PAIRS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']
let pair = qs.get('pair') || PAIRS[0]

const $ = (id) => document.getElementById(id)
const bsym = (p) => p.replace('/', '').toLowerCase()
const fmt = (n, d = 2) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const fmtPx = (n) => (n >= 1000 ? fmt(n, 2) : fmt(n, 4))

// ── ticket state ────────────────────────────────────────────────────────────
const ticket = { market: 'spot', side: 'buy', kind: 'market', leverage: 10, margin: 'isolated' }
let lastPrice = 0

// ── pair selector ─────────────────────────────────────────────────────────
// setPair is THE pair-switch mechanism (it keys the same state ?pair= seeds):
// a human header click and a hippo:action set_symbol land on this exact path,
// so chart, ticker, ticket estimate and the embed's context all stay in sync.
function setPair(p) {
  if (!PAIRS.includes(p)) return false
  pair = p
  for (const c of pairsel.children) c.classList.toggle('on', c.textContent === p)
  startMarket()
  tellHippo({ symbol: pair }) // embed follows the host's pair switch
  return true
}
const pairsel = $('pairsel')
for (const p of PAIRS) {
  const b = document.createElement('button')
  b.textContent = p
  if (p === pair) b.classList.add('on')
  b.onclick = () => setPair(p)
  pairsel.appendChild(b)
}

// ── segmented controls ────────────────────────────────────────────────────
function seg(id, key, after) {
  const el = $(id)
  for (const b of el.querySelectorAll('button')) {
    b.onclick = () => {
      for (const c of el.children) c.classList.toggle('on', c === b)
      ticket[key] = b.dataset.v
      after?.()
    }
  }
}
seg('market', 'market', syncTicket)
seg('side', 'side', syncTicket)
seg('kind', 'kind', syncTicket)
$('lev').oninput = (e) => {
  ticket.leverage = +e.target.value
  $('levval').textContent = `${e.target.value}x`
}
$('margin').onchange = (e) => {
  ticket.margin = e.target.value
}
$('qty').oninput = syncEst
$('limit').oninput = syncEst

function syncTicket() {
  const perp = ticket.market === 'perp'
  const limit = ticket.kind === 'limit'
  $('levfld').classList.toggle('hidden', !perp)
  $('marginfld').classList.toggle('hidden', !perp)
  $('limitfld').classList.toggle('hidden', !limit)
  const buy = ticket.side === 'buy'
  const place = $('place')
  place.className = `place ${buy ? 'buy' : 'sell'}`
  place.textContent = `Place ${buy ? (perp ? 'Long' : 'Buy') : perp ? 'Short' : 'Sell'} Order`
  syncEst()
}
function syncEst() {
  const qty = +$('qty').value || 0
  const px = ticket.kind === 'limit' ? +$('limit').value || lastPrice : lastPrice
  $('estval').textContent = px ? `${fmt(qty * px)} USDT` : '—'
}

// ── place order (human ticket → same backend the parasite hits) ─────────────
$('place').onclick = async () => {
  const qty = +$('qty').value
  const rate = ticket.kind === 'limit' ? +$('limit').value : lastPrice
  if (!qty || !rate) return
  const body = {
    pairName: pair.replace('/', '-'),
    market: ticket.market,
    orderType: ticket.side === 'sell' ? 1 : 0,
    tradeType: ticket.kind === 'market' ? 20 : 10,
    qty,
    rate,
  }
  if (ticket.market === 'perp') {
    body.direction = ticket.side === 'buy' ? 'long' : 'short'
    body.leverage = ticket.leverage
    body.marginMode = ticket.margin
  }
  const btn = $('place')
  btn.disabled = true
  try {
    const res = await fetch(`${HOST}/ui/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json()
    if (!res.ok) alert(`Rejected: ${j.error || res.status}`)
  } catch (e) {
    alert(`Host unreachable: ${e.message}`)
  } finally {
    btn.disabled = false
  }
}

// ── venue state via SSE ─────────────────────────────────────────────────────
let state = { balances: [], orders: [], positions: [], config: null }
let blotterTab = 'orders'
for (const b of document.querySelectorAll('.blotter .tabs button')) {
  b.onclick = () => {
    blotterTab = b.dataset.t
    for (const c of b.parentElement.children) c.classList.toggle('on', c === b)
    renderBlotter()
  }
}

function connectSSE() {
  const es = new EventSource(`${HOST}/stream`)
  es.onopen = () => {
    $('conn').className = 'conn up'
    $('conn').textContent = 'HOST ●'
  }
  es.onerror = () => {
    $('conn').className = 'conn down'
    $('conn').textContent = 'HOST ●'
  }
  es.onmessage = (m) => {
    let e
    try {
      e = JSON.parse(m.data)
    } catch {
      return
    }
    if (e.type === 'snapshot') {
      state = { balances: e.balances, orders: e.orders, positions: e.positions, config: e.config }
      applyConfig(e.config)
      renderBlotter()
    } else if (e.type === 'order' || e.type === 'fill') {
      upsertOrder(e.order)
      renderBlotter()
    } else if (e.type === 'balances') {
      state.balances = e.balances
      renderBlotter()
    } else if (e.type === 'positions') {
      state.positions = e.positions
      renderBlotter()
    } else if (e.type === 'config') {
      applyConfig(e.config)
    } else if (e.type === 'handoff') {
      onHandoff(e.handoff)
    }
  }
}
function upsertOrder(o) {
  const i = state.orders.findIndex((x) => x.id === o.id)
  if (i >= 0) state.orders[i] = o
  else state.orders.unshift(o)
}

const STATUS = {
  10: ['ACTIVE', 'active'],
  20: ['FILLED', 'settled'],
  30: ['PARTIAL', 'partial'],
  40: ['PART-CXL', 'canceled'],
  50: ['CANCELED', 'canceled'],
}
function renderBlotter() {
  const el = $('blotter')
  if (blotterTab === 'orders') {
    const open = state.orders.filter((o) => o.status === 10 || o.status === 30)
    if (!open.length) {
      el.innerHTML =
        '<div class="empty">No <b>working</b> orders right now. Market orders fill instantly — a filled buy shows in <b>Positions</b> / <b>Balances</b>, not here. Only a resting <b>limit</b> order (or a partially-filled one) waits in this tab. Place a limit order from the ticket — or ask Hippo — to see one here.</div>'
      return
    }
    el.innerHTML = `<table><thead><tr><th>ID</th><th>Pair</th><th>Type</th><th>Side</th><th>Qty</th><th>Price</th><th>Status</th><th></th></tr></thead><tbody>${open
      .map((o) => {
        const [lbl, cls] = STATUS[o.status] || ['?', '']
        const sell = o.side === 'sell'
        return `<tr><td>${o.id}</td><td>${o.pairName}${o.market === 'perp' ? ` ·${o.leverage || ''}x` : ''}</td><td>${o.kind.toUpperCase()}</td><td class="${sell ? 'down' : 'up'}">${sell ? 'SELL' : 'BUY'}</td><td>${o.qty}</td><td>${fmtPx(o.rate)}</td><td><span class="badge ${cls}">${lbl}</span></td><td><button class="cancelx" data-cx="${o.id}">Cancel</button></td></tr>`
      })
      .join('')}</tbody></table>`
    for (const b of el.querySelectorAll('[data-cx]'))
      b.onclick = () => fetch(`${HOST}/ui/orders/${b.dataset.cx}/cancel`, { method: 'POST' })
  } else if (blotterTab === 'positions') {
    if (!state.positions.length) {
      el.innerHTML = '<div class="empty">No open positions.</div>'
      return
    }
    el.innerHTML = `<table><thead><tr><th>Pair</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Lev</th><th>Liq.</th><th>uPnL</th></tr></thead><tbody>${state.positions
      .map((p) => {
        const long = p.direction === 'long'
        const pnl = lastPrice ? (long ? lastPrice - p.entry : p.entry - lastPrice) * p.size : 0
        return `<tr><td>${p.pairName}</td><td class="${long ? 'up' : 'down'}">${p.direction.toUpperCase()}</td><td>${p.size}</td><td>${fmtPx(p.entry)}</td><td>${lastPrice ? fmtPx(lastPrice) : '—'}</td><td>${p.leverage}x</td><td>${fmtPx(p.liquidation)}</td><td class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : '−'}${fmt(Math.abs(pnl))}</td></tr>`
      })
      .join('')}</tbody></table>`
  } else {
    if (!state.balances.length) {
      el.innerHTML = '<div class="empty">No balances.</div>'
      return
    }
    el.innerHTML = `<table><thead><tr><th>Asset</th><th>Amount</th></tr></thead><tbody>${state.balances.map((b) => `<tr><td>${b.currencyName}</td><td>${fmt(b.amount, b.currencyName === 'USDT' ? 2 : 6)}</td></tr>`).join('')}</tbody></table>`
  }
}

// ── admin drawer ────────────────────────────────────────────────────────────
$('gear').onclick = () => {
  $('drawer').classList.add('open')
  $('scrim').classList.add('open')
}
const closeAdmin = () => {
  $('drawer').classList.remove('open')
  $('scrim').classList.remove('open')
}
$('closeAdmin').onclick = closeAdmin
$('scrim').onclick = closeAdmin
for (const lbl of document.querySelectorAll('#surface label')) {
  lbl.onclick = () => patchConfig({ confirmSurface: lbl.dataset.v })
}
$('partial').onchange = (e) => patchConfig({ partialFills: e.target.checked })
$('window').onchange = (e) => patchConfig({ workingWindowMs: +e.target.value })
$('fee').onchange = (e) => patchConfig({ feeRate: +e.target.value })
async function patchConfig(patch) {
  await fetch(`${HOST}/admin/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}
function applyConfig(cfg) {
  if (!cfg) return
  state.config = cfg
  for (const lbl of document.querySelectorAll('#surface label')) {
    const on = lbl.dataset.v === cfg.confirmSurface
    lbl.classList.toggle('on', on)
    lbl.querySelector('input').checked = on
  }
  $('partial').checked = !!cfg.partialFills
  $('window').value = cfg.workingWindowMs
  $('fee').value = cfg.feeRate
}

// ── js_callback confirm modal (the HOST asks the trader to approve) ──────────
let pendingHandoff = null
function onHandoff(h) {
  if (h.state !== 'pending') {
    if (pendingHandoff && pendingHandoff.clientOrderId === h.clientOrderId) hideModal()
    return
  }
  pendingHandoff = h
  $('cmTitle').textContent =
    `${h.place.side === 'sell' ? 'Sell' : 'Buy'} ${h.place.qty} ${h.place.pairName}`
  $('cmRows').innerHTML = (
    h.displayRows?.length
      ? h.displayRows
      : [
          { label: 'Pair', value: h.place.pairName },
          { label: 'Side', value: h.place.side.toUpperCase() },
          { label: 'Qty', value: String(h.place.qty) },
        ]
  )
    .map((r) => `<div class="r"><span>${r.label}</span><span>${r.value}</span></div>`)
    .join('')
  $('confirmModal').classList.remove('hidden')
}
function hideModal() {
  $('confirmModal').classList.add('hidden')
  pendingHandoff = null
}
$('cmApprove').onclick = async () => {
  if (pendingHandoff)
    await fetch(`${HOST}/ui/handoff/${pendingHandoff.clientOrderId}/approve`, { method: 'POST' })
  hideModal()
}
$('cmReject').onclick = async () => {
  if (pendingHandoff)
    await fetch(`${HOST}/ui/handoff/${pendingHandoff.clientOrderId}/reject`, { method: 'POST' })
  hideModal()
}

// ── Binance public market data ──────────────────────────────────────────────
let ws = null
let candles = [] // {t,o,h,l,c}
const canvas = $('candles')
const ctx = canvas.getContext('2d')

async function startMarket() {
  $('chartsym').textContent = pair
  const sym = pair.replace('/', '').toUpperCase()
  // Seed history via REST at the active timeframe, then stream live. The candle
  // series is genuinely bucketed to `timeframe` — Binance klines carry the real
  // per-bucket OHLCV, so switching timeframe re-fetches candles of the selected
  // duration rather than resampling 1m bars on the client.
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${timeframe}&limit=120`,
    )
    const raw = await r.json()
    candles = raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
    lastPrice = candles[candles.length - 1]?.c || 0
    redraw()
    syncEst()
  } catch {
    /* offline — chart stays empty, venue still works */
  }

  if (ws) {
    try {
      ws.close()
    } catch {}
  }
  const s = bsym(pair)
  // The live kline stream tracks the active timeframe, so the last candle keeps
  // filling at the right bucket duration (5m, 1h, …) — Hippo and the human see
  // the same thing whichever set the timeframe.
  ws = new WebSocket(
    `wss://stream.binance.com:9443/stream?streams=${s}@kline_${timeframe}/${s}@depth20@100ms/${s}@trade/${s}@ticker`,
  )
  ws.onmessage = (m) => {
    const { stream, data } = JSON.parse(m.data)
    if (stream.includes('@kline_')) onKline(data.k)
    else if (stream.includes('@depth')) onDepth(data)
    else if (stream.endsWith('@trade')) onTrade(data)
    else if (stream.endsWith('@ticker')) onTicker(data)
  }
}

function onKline(k) {
  const c = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }
  const last = candles[candles.length - 1]
  if (last && last.t === c.t) candles[candles.length - 1] = c
  else {
    candles.push(c)
    if (candles.length > 120) candles.shift()
  }
  lastPrice = c.c
  redraw()
  syncEst()
}
function onTicker(d) {
  lastPrice = +d.c
  $('lastpx').textContent = fmtPx(+d.c)
  const chg = +d.P
  const el = $('chg')
  el.textContent = `${(chg >= 0 ? '+' : '') + chg.toFixed(2)}%`
  el.style.color = chg >= 0 ? 'var(--up)' : 'var(--down)'
  el.style.background = chg >= 0 ? '#d1fae5' : '#fee2e2'
  document.title = `${fmtPx(+d.c)} ${pair} — Assetworks Exchange`
  // Host→embed bridge: hand Hippo the exact number the host header shows, so
  // the parasite's price is literally in sync with the page (its own server
  // ticks keep flowing as a fallback; an explicit host price wins).
  tellHippo({ symbol: pair, price: { last: +d.c, lastDisplay: fmtPx(+d.c) } })
}

// ── host→embed context bridge ───────────────────────────────────────────────
// The embed listens for strictly-validated `hippo:context` messages on this
// window. We tell it which pair the trader is looking at (so drafts/research
// default to it) and forward the live ticker so panel price === header price.
function tellHippo(msg) {
  try {
    window.postMessage({ type: 'hippo:context', ...msg }, location.origin)
  } catch {
    /* embed absent or origin quirk — the host never breaks over the parasite */
  }
}
function onDepth(d) {
  const asks = d.asks.slice(0, 11).reverse()
  const bids = d.bids.slice(0, 11)
  const max = Math.max(...asks.concat(bids).map((r) => +r[1]), 1)
  const row = (r, cls) =>
    `<div class="brow ${cls}"><span class="bar" style="width:${(+r[1] / max) * 100}%"></span><span class="px">${fmtPx(+r[0])}</span><span class="qty">${(+r[1]).toFixed(4)}</span></div>`
  $('asks').innerHTML = asks.map((r) => row(r, 'ask')).join('')
  $('bids').innerHTML = bids.map((r) => row(r, 'bid')).join('')
  const spread = +asks[asks.length - 1]?.[0] - +bids[0]?.[0]
  $('spread').textContent = Number.isFinite(spread) ? `spread ${fmtPx(Math.abs(spread))}` : '—'
}
const tape = []
function onTrade(d) {
  tape.unshift({ p: +d.p, q: +d.q, sell: d.m, t: d.T })
  if (tape.length > 40) tape.pop()
  $('tape').innerHTML = tape
    .map(
      (t) =>
        `<div class="trow ${t.sell ? 'sell' : 'buy'}"><span class="px">${fmtPx(t.p)}</span><span class="qty">${t.q.toFixed(4)}</span><span class="tm">${new Date(t.t).toLocaleTimeString('en-US', { hour12: false })}</span></div>`,
    )
    .join('')
}

// ── timeframe + indicators (chart controls, shared by human + Hippo) ─────────
// The chart now has a real notion of candle duration and a small set of
// demo-grade-but-real indicators. Every mutation flows through setTimeframe /
// applyIndicator / removeIndicator so a human click and a hippo:action land on
// the exact same code path and leave chart, header and chips consistent.
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d']
const INDICATORS = ['sma20', 'sma50', 'ema20', 'rsi', 'vol']
const IND_META = {
  sma20: { label: 'SMA 20', color: '#3b82f6' },
  sma50: { label: 'SMA 50', color: '#8b5cf6' },
  ema20: { label: 'EMA 20', color: '#f59e0b' },
  rsi: { label: 'RSI 14', color: '#0ea5e9' },
  vol: { label: 'Volume', color: '#94a3b8' },
}
let timeframe = '1m'
let indicators = [] // active slugs, unique, insertion-ordered

const rsiCanvas = $('rsipane')
const rsiCtx = rsiCanvas.getContext('2d')

// Timeframe segmented control — a human can switch by hand; Hippo drives the
// SAME setTimeframe path.
const tfseg = $('tfseg')
for (const tf of TIMEFRAMES) {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = tf
  b.dataset.v = tf
  if (tf === timeframe) b.classList.add('on')
  b.onclick = () => setTimeframe(tf)
  tfseg.appendChild(b)
}
// "＋ Indicator" picker — a human can add one; Hippo uses applyIndicator too.
$('indadd').onchange = (e) => {
  const slug = e.target.value
  e.target.value = ''
  if (slug) applyIndicator(slug)
}

function setTimeframe(tf) {
  if (!TIMEFRAMES.includes(tf)) return false
  timeframe = tf
  for (const b of tfseg.children) b.classList.toggle('on', b.dataset.v === tf)
  startMarket() // re-seed + reconnect the live kline stream at the new duration
  return true
}
function applyIndicator(slug) {
  if (!INDICATORS.includes(slug)) return false
  if (!indicators.includes(slug)) indicators.push(slug)
  syncIndicators()
  return true
}
function removeIndicator(slug) {
  // No slug → clear all; a slug → drop just that one (idempotent).
  if (!slug) indicators = []
  else indicators = indicators.filter((s) => s !== slug)
  syncIndicators()
  return true
}
function syncIndicators() {
  renderChips()
  rsiCanvas.classList.toggle('hidden', !indicators.includes('rsi'))
  redraw()
}
function renderChips() {
  const el = $('indchips')
  el.innerHTML = indicators
    .map((s) => {
      const m = IND_META[s]
      return `<span class="chip"><span class="dot" style="background:${m.color}"></span>${m.label}<button type="button" data-rm="${s}" title="Remove ${m.label}">×</button></span>`
    })
    .join('')
  for (const b of el.querySelectorAll('[data-rm]')) b.onclick = () => removeIndicator(b.dataset.rm)
}

// ── indicator math (real, over the candle closes / volume) ───────────────────
function sma(vals, n) {
  const out = new Array(vals.length).fill(null)
  let sum = 0
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i]
    if (i >= n) sum -= vals[i - n]
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}
function ema(vals, n) {
  const out = new Array(vals.length).fill(null)
  const k = 2 / (n + 1)
  let prev = null
  for (let i = 0; i < vals.length; i++) {
    if (i < n - 1) continue
    if (prev == null) {
      let s = 0
      for (let j = i - n + 1; j <= i; j++) s += vals[j]
      prev = s / n // seed with the SMA of the first window
    } else {
      prev = vals[i] * k + prev * (1 - k)
    }
    out[i] = prev
  }
  return out
}
function rsiSeries(vals, n = 14) {
  const out = new Array(vals.length).fill(null)
  if (vals.length <= n) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= n; i++) {
    const d = vals[i] - vals[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  gain /= n
  loss /= n
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let i = n + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1]
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n // Wilder smoothing
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

function drawChart() {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth,
    h = canvas.clientHeight
  canvas.width = w * dpr
  canvas.height = h * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (candles.length < 2) return
  const pad = 8
  // Reserve a bottom band for volume bars only when the vol indicator is on, so
  // the default chart is pixel-identical to before.
  const volOn = indicators.includes('vol')
  const volH = volOn ? Math.round(h * 0.18) : 0
  const priceH = h - volH
  const his = candles.map((c) => c.h),
    los = candles.map((c) => c.l)
  const hi = Math.max(...his),
    lo = Math.min(...los)
  const y = (p) => pad + (1 - (p - lo) / (hi - lo || 1)) * (priceH - pad * 2)
  const cw = (w - pad * 2) / candles.length
  const cx = (i) => pad + i * cw + cw / 2

  if (volOn) {
    const maxV = Math.max(...candles.map((c) => c.v || 0), 1)
    const base = h - 2
    const bw = Math.max(1, cw * 0.6)
    candles.forEach((c, i) => {
      const up = c.c >= c.o
      const bh = ((c.v || 0) / maxV) * (volH - 4)
      ctx.fillStyle = up ? 'rgba(16,185,129,.35)' : 'rgba(239,68,68,.35)'
      ctx.fillRect(cx(i) - bw / 2, base - bh, bw, bh)
    })
  }

  candles.forEach((c, i) => {
    const x = cx(i)
    const up = c.c >= c.o
    ctx.strokeStyle = up ? '#10b981' : '#ef4444'
    ctx.fillStyle = up ? '#10b981' : '#ef4444'
    ctx.beginPath()
    ctx.moveTo(x, y(c.h))
    ctx.lineTo(x, y(c.l))
    ctx.stroke()
    const bw = Math.max(1, cw * 0.6)
    const yo = y(c.o),
      yc = y(c.c)
    ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)))
  })

  // moving-average overlays
  const closes = candles.map((c) => c.c)
  const overlays = [
    ['sma20', () => sma(closes, 20)],
    ['sma50', () => sma(closes, 50)],
    ['ema20', () => ema(closes, 20)],
  ]
  for (const [slug, build] of overlays) {
    if (!indicators.includes(slug)) continue
    ctx.strokeStyle = IND_META[slug].color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    let started = false
    build().forEach((v, i) => {
      if (v == null) return
      const px = cx(i),
        py = y(v)
      if (!started) {
        ctx.moveTo(px, py)
        started = true
      } else ctx.lineTo(px, py)
    })
    ctx.stroke()
    ctx.lineWidth = 1
  }
}

function drawRSI() {
  if (!indicators.includes('rsi')) return
  const dpr = window.devicePixelRatio || 1
  const w = rsiCanvas.clientWidth,
    h = rsiCanvas.clientHeight
  if (!w || !h) return
  rsiCanvas.width = w * dpr
  rsiCanvas.height = h * dpr
  rsiCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  rsiCtx.clearRect(0, 0, w, h)
  if (candles.length < 2) return
  const pad = 6
  const series = rsiSeries(
    candles.map((c) => c.c),
    14,
  )
  const cw = (w - pad * 2) / candles.length
  const y = (v) => pad + (1 - v / 100) * (h - pad * 2)
  rsiCtx.strokeStyle = 'rgba(148,163,184,.35)'
  rsiCtx.lineWidth = 1
  for (const lvl of [70, 30]) {
    rsiCtx.beginPath()
    rsiCtx.moveTo(pad, y(lvl))
    rsiCtx.lineTo(w - pad, y(lvl))
    rsiCtx.stroke()
  }
  rsiCtx.strokeStyle = IND_META.rsi.color
  rsiCtx.lineWidth = 1.5
  rsiCtx.beginPath()
  let started = false
  series.forEach((v, i) => {
    if (v == null) return
    const px = pad + i * cw + cw / 2,
      py = y(v)
    if (!started) {
      rsiCtx.moveTo(px, py)
      started = true
    } else rsiCtx.lineTo(px, py)
  })
  rsiCtx.stroke()
  rsiCtx.lineWidth = 1
}

function redraw() {
  drawChart()
  drawRSI()
}
window.addEventListener('resize', redraw)

// ── SDK→host page-control bridge (the reverse of the hippo:context bridge) ───
// The SDK forwards VALIDATED chart-control actions to this window. We re-validate
// at the boundary — origin, source, the closed action set, enum/allow-list
// values — mirroring how the embed guards hippo:context, then run the same code
// paths a human click would and ACK every action (ok or not, never throwing).
const pageControlEnabled = (() => {
  try {
    return (localStorage.getItem('hippo_embed_pageControl') ?? '1') === '1'
  } catch {
    return true
  }
})()

// ── host capability declaration ──────────────────────────────────────────────
// The host_action verbs this page supports. Declared to the SDK over
// hippo:capabilities so the gateway only ever sends verbs we can honor —
// announced proactively on load (covers an SDK that mounted before us) AND in
// answer to the SDK's hippo:capabilities:request (covers the usual order: this
// script runs at page load, the embed mounts later and asks). Both directions
// because neither side can know who loaded first. Always announced even when
// the admin localStorage kill-switch is off — actions then ack
// {ok:false, reason:'page control disabled'}, the honest existing behavior,
// instead of silently vanishing from the vocabulary.
const HOST_ACTIONS = [
  'set_timeframe',
  'apply_indicator',
  'remove_indicator',
  'set_symbol',
  'navigate',
  'prefill_ticket',
]
// Where `navigate` may take the trader — the page-defined allowlist, nothing
// else. location.search rides along so ?host= / ?pair= overrides survive.
const NAV_TARGETS = { trade: 'index.html', settings: 'settings.html', how: 'how.html' }
function announceCapabilities() {
  try {
    window.postMessage(
      { source: 'hippo-host', type: 'hippo:capabilities', actions: HOST_ACTIONS },
      location.origin,
    )
  } catch {
    /* embed absent or origin quirk — the host never breaks over the parasite */
  }
}

// Simulate a human tap on a segmented-control button (side / order-type), so a
// prefill flows through the exact seg() handler a real click uses.
function clickSeg(id, value) {
  const b = document.querySelector(`#${id} button[data-v="${value}"]`)
  if (b) b.click()
}
function ackAction(actionId, ok, reason) {
  try {
    window.postMessage(
      {
        source: 'hippo-host',
        type: 'hippo:action:result',
        actionId,
        ok,
        ...(reason ? { reason } : {}),
      },
      location.origin,
    )
  } catch {
    /* origin quirk — never let an ack failure break the host */
  }
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return
  const d = e.data
  if (d?.source !== 'hippo-sdk') return
  if (d.type === 'hippo:capabilities:request') return announceCapabilities()
  if (d.type !== 'hippo:action') return
  const { actionId, action } = d
  // Verb params: a flat string→string map by contract; anything else is
  // treated as absent and each verb re-validates its own fields below.
  const params = typeof d.params === 'object' && !Array.isArray(d.params) ? (d.params ?? {}) : {}
  try {
    if (!pageControlEnabled) return ackAction(actionId, false, 'page control disabled')
    if (action === 'set_timeframe') {
      if (!TIMEFRAMES.includes(d.timeframe)) return ackAction(actionId, false, 'invalid timeframe')
      setTimeframe(d.timeframe)
      return ackAction(actionId, true)
    }
    if (action === 'apply_indicator') {
      if (!INDICATORS.includes(d.indicator))
        return ackAction(actionId, false, 'unsupported indicator')
      applyIndicator(d.indicator)
      return ackAction(actionId, true)
    }
    if (action === 'remove_indicator') {
      // A slug removes one; no slug clears all. A named-but-unknown slug is an error.
      if (d.indicator && !INDICATORS.includes(d.indicator))
        return ackAction(actionId, false, 'unsupported indicator')
      removeIndicator(d.indicator)
      return ackAction(actionId, true)
    }
    if (action === 'set_symbol') {
      // Same pair-switch mechanism the header ticker buttons use — setPair
      // validates against the page's listed PAIRS and keeps everything synced.
      const sym = typeof params.symbol === 'string' ? params.symbol.toUpperCase() : ''
      if (!setPair(sym)) return ackAction(actionId, false, 'unsupported symbol')
      return ackAction(actionId, true)
    }
    if (action === 'navigate') {
      const target = params.target
      if (typeof target !== 'string' || !Object.hasOwn(NAV_TARGETS, target))
        return ackAction(actionId, false, 'unknown target')
      // Ack FIRST, then leave on the next beat: the ack postMessage is a
      // queued task, and an instant location change could tear this document
      // down before it delivers — stranding the chip on "no response".
      ackAction(actionId, true)
      setTimeout(() => {
        location.href = NAV_TARGETS[target] + location.search
      }, 120)
      return
    }
    if (action === 'prefill_ticket') {
      // Fill the HUMAN order ticket only — never submit. The trader reviews
      // and clicks Place; nothing trades from a prefill.
      const side = params.side
      if (side !== 'buy' && side !== 'sell') return ackAction(actionId, false, 'invalid side')
      const qty = Number(params.qty)
      if (!Number.isFinite(qty) || qty <= 0) return ackAction(actionId, false, 'invalid qty')
      let price
      if (params.price !== undefined) {
        price = Number(params.price)
        if (!Number.isFinite(price) || price <= 0)
          return ackAction(actionId, false, 'invalid price')
      }
      clickSeg('side', side) // same handler a human tap runs
      if (price !== undefined) clickSeg('kind', 'limit') // a price only means anything on a limit ticket
      $('qty').value = String(qty)
      if (price !== undefined) $('limit').value = String(price)
      syncEst()
      return ackAction(actionId, true)
    }
    return ackAction(actionId, false, 'unknown action')
  } catch {
    ackAction(actionId, false, 'error')
  }
})

// ── go ──────────────────────────────────────────────────────────────────────
syncTicket()
connectSSE()
startMarket()
announceCapabilities() // proactive — an SDK already mounted hears it now; a later one asks
// Load current admin config so the drawer reflects reality on first open.
fetch(`${HOST}/admin/config`)
  .then((r) => r.json())
  .then(applyConfig)
  .catch(() => {})
