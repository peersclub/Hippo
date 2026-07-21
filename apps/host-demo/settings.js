// Host Settings — operator control center for the Hippo integration.
// Talks to host-venue (same backend the exchange uses): /admin/config (venue
// behaviour), /admin/ai/model (proxied to intelligence), /stream (live orders),
// /ui/orders/:id/cancel. Every control is a test lever whose effect shows up in
// the embedded Hippo chat on the exchange.

const qs = new URLSearchParams(location.search)
const envHost = '%VITE_HOST_VENUE_URL%'
const HOST = qs.get('host') || (envHost.startsWith('http') ? envHost : 'http://localhost:8796')

const $ = (id) => document.getElementById(id)
const fmt = (n, d = 2) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const flash = (id) => {
  const el = $(id)
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 1400)
}

// ── Venue behaviour (/admin/config) ─────────────────────────────────────────
async function patchConfig(patch) {
  const res = await fetch(`${HOST}/admin/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (res.ok) {
    applyConfig(await res.json())
    flash('cfgSaved')
  }
}
function applyConfig(cfg) {
  if (!cfg) return
  for (const lbl of document.querySelectorAll('#surface label')) {
    const on = lbl.dataset.v === cfg.confirmSurface
    lbl.classList.toggle('on', on)
    lbl.querySelector('input').checked = on
  }
  $('partial').checked = !!cfg.partialFills
  $('partialState').textContent = cfg.partialFills ? 'on' : 'off'
  if (document.activeElement !== $('window')) $('window').value = cfg.workingWindowMs
  if (document.activeElement !== $('fee')) $('fee').value = cfg.feeRate
}
for (const lbl of document.querySelectorAll('#surface label'))
  lbl.onclick = () => patchConfig({ confirmSurface: lbl.dataset.v })
$('partial').onchange = (e) => patchConfig({ partialFills: e.target.checked })
$('window').onchange = (e) => patchConfig({ workingWindowMs: +e.target.value })
$('fee').onchange = (e) => patchConfig({ feeRate: +e.target.value })
fetch(`${HOST}/admin/config`)
  .then((r) => r.json())
  .then(applyConfig)
  .catch(() => {})

// ── Hippo AI model (/admin/ai/model → intelligence) ─────────────────────────
async function loadModel() {
  try {
    const m = await (await fetch(`${HOST}/admin/ai/model`)).json()
    if (m.error) throw new Error(m.error)
    $('curModel').textContent = m.current
    const badge = $('modeBadge')
    badge.textContent = m.mode === 'llm' ? 'LLM' : 'MOCK'
    badge.className = `pill ${m.mode === 'llm' ? 'llm' : 'mock'}`
    const sel = $('model')
    sel.innerHTML = ''
    for (const id of m.available || []) {
      const o = document.createElement('option')
      o.value = id
      o.textContent = id
      if (id === m.current) o.selected = true
      sel.appendChild(o)
    }
  } catch {
    $('curModel').textContent = 'intelligence unreachable'
    $('model').innerHTML = '<option>unavailable</option>'
  }
}
$('model').onchange = async (e) => {
  const res = await fetch(`${HOST}/admin/ai/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: e.target.value }),
  })
  if (res.ok) {
    flash('modelSaved')
    loadModel()
  }
}
loadModel()

// ── Order management (SSE live + cancel) ─────────────────────────────────────
const STATUS = { 10: 'ACTIVE', 20: 'FILLED', 30: 'PARTIAL', 40: 'PART-CXL', 50: 'CANCELED' }
let orders = []
function renderOrders() {
  const open = orders.filter((o) => o.status === 10 || o.status === 30)
  const el = $('orders')
  if (!open.length) {
    el.innerHTML =
      '<div class="empty">No resting orders. Place a limit order from Hippo (off-market so it rests), then cancel it here.</div>'
    return
  }
  el.innerHTML = `<table><thead><tr><th>ID</th><th>Pair</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Status</th><th></th></tr></thead><tbody>${open
    .map((o) => {
      const sell = o.side === 'sell'
      return `<tr><td>${o.id}</td><td>${o.pairName}${o.market === 'perp' ? ` ·${o.leverage || ''}x` : ''}</td><td class="side-${o.side}">${sell ? 'SELL' : 'BUY'}</td><td>${(o.kind || '').toUpperCase()}</td><td>${o.qty}</td><td>${fmt(o.rate, o.rate >= 1000 ? 0 : 2)}</td><td>${STATUS[o.status] || o.status}</td><td><button class="cancel" data-cx="${o.id}">Cancel</button></td></tr>`
    })
    .join('')}</tbody></table>`
  for (const b of el.querySelectorAll('[data-cx]'))
    b.onclick = () => fetch(`${HOST}/ui/orders/${b.dataset.cx}/cancel`, { method: 'POST' })
}
function upsert(o) {
  const i = orders.findIndex((x) => x.id === o.id)
  if (i >= 0) orders[i] = o
  else orders.unshift(o)
  renderOrders()
}
function connectSSE() {
  const es = new EventSource(`${HOST}/stream`)
  es.onopen = () => {
    $('conn').className = 'conn up'
  }
  es.onerror = () => {
    $('conn').className = 'conn down'
  }
  es.onmessage = (m) => {
    let e
    try {
      e = JSON.parse(m.data)
    } catch {
      return
    }
    if (e.type === 'snapshot') {
      orders = e.orders || []
      applyConfig(e.config)
      renderOrders()
    } else if (e.type === 'order' || e.type === 'fill') upsert(e.order)
    else if (e.type === 'config') applyConfig(e.config)
  }
}
connectSSE()
