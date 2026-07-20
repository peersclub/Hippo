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
const envHost = '%VITE_HOST_VENUE_URL%'
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
const pairsel = $('pairsel')
for (const p of PAIRS) {
  const b = document.createElement('button')
  b.textContent = p
  if (p === pair) b.classList.add('on')
  b.onclick = () => {
    pair = p
    for (const c of pairsel.children) c.classList.toggle('on', c.textContent === p)
    startMarket()
  }
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
        '<div class="empty">No open orders. Place one from the ticket — or ask Hippo.</div>'
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
  // Seed history via REST, then stream live.
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&limit=120`,
    )
    const raw = await r.json()
    candles = raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }))
    lastPrice = candles[candles.length - 1]?.c || 0
    drawChart()
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
  ws = new WebSocket(
    `wss://stream.binance.com:9443/stream?streams=${s}@kline_1m/${s}@depth20@100ms/${s}@trade/${s}@ticker`,
  )
  ws.onmessage = (m) => {
    const { stream, data } = JSON.parse(m.data)
    if (stream.endsWith('@kline_1m')) onKline(data.k)
    else if (stream.includes('@depth')) onDepth(data)
    else if (stream.endsWith('@trade')) onTrade(data)
    else if (stream.endsWith('@ticker')) onTicker(data)
  }
}

function onKline(k) {
  const c = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c }
  const last = candles[candles.length - 1]
  if (last && last.t === c.t) candles[candles.length - 1] = c
  else {
    candles.push(c)
    if (candles.length > 120) candles.shift()
  }
  lastPrice = c.c
  drawChart()
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
  const his = candles.map((c) => c.h),
    los = candles.map((c) => c.l)
  const hi = Math.max(...his),
    lo = Math.min(...los)
  const y = (p) => pad + (1 - (p - lo) / (hi - lo || 1)) * (h - pad * 2)
  const cw = (w - pad * 2) / candles.length
  candles.forEach((c, i) => {
    const x = pad + i * cw + cw / 2
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
}
window.addEventListener('resize', drawChart)

// ── go ──────────────────────────────────────────────────────────────────────
syncTicket()
connectSSE()
startMarket()
// Load current admin config so the drawer reflects reality on first open.
fetch(`${HOST}/admin/config`)
  .then((r) => r.json())
  .then(applyConfig)
  .catch(() => {})
