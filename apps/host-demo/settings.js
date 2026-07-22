// Host Settings — full operator control center. Drives host-venue (venue
// behaviour, capabilities, orders, wallet, AI proxy) and the SDK embed prefs
// (localStorage, read by the exchange on load). Every lever's effect shows up
// in the embedded Hippo chat.

const qs = new URLSearchParams(location.search)
const envHost = '%VITE_HOST_VENUE_URL%'
const HOST = qs.get('host') || (envHost.startsWith('http') ? envHost : 'http://localhost:8796')

const $ = (id) => document.getElementById(id)
const fmt = (n, d = 2) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const flash = (id) => {
  const el = $(id)
  if (!el) return
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 1400)
}

// ══ Embed & appearance (localStorage → exchange reads on load) ═══════════════
const EMBED = [
  ['theme', 'dark'],
  ['locale', 'en'],
  ['label', ''],
  ['open', ''],
  ['key', 'pk_assetworks'],
]
const getPref = (k, d) => {
  try {
    return localStorage.getItem('hippo_embed_' + k) ?? d
  } catch {
    return d
  }
}
const setPref = (k, v) => {
  try {
    v === '' || v == null
      ? localStorage.removeItem('hippo_embed_' + k)
      : localStorage.setItem('hippo_embed_' + k, v)
  } catch {}
}
function loadEmbed() {
  const theme = getPref('theme', 'dark')
  for (const b of $('e-theme').children) b.classList.toggle('on', b.dataset.v === theme)
  $('e-locale').value = getPref('locale', 'en')
  $('e-label').value = getPref('label', '')
  $('e-open').checked = getPref('open', '') === '1'
  $('e-key').value = getPref('key', 'pk_assetworks')
}
for (const b of $('e-theme').children)
  b.onclick = () => {
    setPref('theme', b.dataset.v)
    loadEmbed()
  }
$('e-locale').onchange = (e) => setPref('locale', e.target.value)
$('e-label').onchange = (e) => setPref('label', e.target.value.trim())
$('e-open').onchange = (e) => setPref('open', e.target.checked ? '1' : '')
$('e-key').onchange = (e) => setPref('key', e.target.value.trim() || 'pk_assetworks')
$('e-reset').onclick = () => {
  for (const [k] of EMBED) setPref(k, '')
  loadEmbed()
}
loadEmbed()

// ══ Venue config (venue behaviour + capabilities → /admin/config) ════════════
const NUMS = [
  'workingWindowMs',
  'feeRate',
  'makerFee',
  'slippagePct',
  'latencyMs',
  'rejectRate',
  'maxLeverage',
  'minOrderSize',
  'maxOrderSize',
]
const BOOLS = ['partialFills', 'maintenance', 'capsSpot', 'capsPerp', 'capsOptions']
const SEGS = ['confirmSurface', 'fillMode']
let allInstruments = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT']

async function patchConfig(patch, savedId) {
  const res = await fetch(`${HOST}/admin/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (res.ok) {
    applyConfig(await res.json())
    flash(savedId)
  }
}
function applyConfig(c) {
  if (!c) return
  for (const k of SEGS)
    for (const b of $(`c-${k}`).children) b.classList.toggle('on', b.dataset.v === c[k])
  for (const k of NUMS) {
    const el = $(`c-${k}`)
    if (el && document.activeElement !== el) el.value = c[k]
  }
  for (const k of BOOLS) {
    const el = $(`c-${k}`)
    if (el) el.checked = !!c[k]
  }
  for (const b of $('c-marginModes').children)
    b.classList.toggle('on', (c.marginModes || []).includes(b.dataset.v))
  renderInstruments(c.instruments || [])
}
function renderInstruments(enabled) {
  const set = new Set([...allInstruments, ...enabled])
  allInstruments = [...set]
  const box = $('c-instruments')
  box.innerHTML = allInstruments
    .map((s) => `<span class="chip${enabled.includes(s) ? ' on' : ''}" data-v="${s}">${s}</span>`)
    .join('')
  for (const b of box.children)
    b.onclick = () => {
      const cur = [...box.children]
        .filter((x) => x.classList.contains('on'))
        .map((x) => x.dataset.v)
      const next = b.classList.contains('on')
        ? cur.filter((x) => x !== b.dataset.v)
        : [...cur, b.dataset.v]
      patchConfig({ instruments: next }, 's-caps')
    }
}
for (const k of SEGS)
  for (const b of $(`c-${k}`).children)
    b.onclick = () => patchConfig({ [k]: b.dataset.v }, 's-venue')
for (const k of NUMS)
  $(`c-${k}`).onchange = (e) =>
    patchConfig(
      { [k]: +e.target.value },
      k.startsWith('caps') || k === 'maxLeverage' || k.includes('OrderSize') ? 's-caps' : 's-venue',
    )
for (const k of BOOLS)
  $(`c-${k}`).onchange = (e) =>
    patchConfig({ [k]: e.target.checked }, k.startsWith('caps') ? 's-caps' : 's-venue')
for (const b of $('c-marginModes').children)
  b.onclick = () => {
    const cur = [...$('c-marginModes').children]
      .filter((x) => x.classList.contains('on'))
      .map((x) => x.dataset.v)
    const next = b.classList.contains('on')
      ? cur.filter((x) => x !== b.dataset.v)
      : [...cur, b.dataset.v]
    patchConfig({ marginModes: next.length ? next : ['isolated'] }, 's-caps')
  }
fetch(`${HOST}/admin/config`)
  .then((r) => r.json())
  .then(applyConfig)
  .catch(() => {})

// ══ Hippo AI (host-venue proxy → intelligence) ═══════════════════════════════
async function loadAI() {
  try {
    const m = await (await fetch(`${HOST}/admin/ai`)).json()
    if (m.error) throw new Error(m.error)
    $('ai-cur').textContent = m.current
    const badge = $('ai-mode')
    badge.textContent = m.mode === 'llm' ? 'LLM' : 'MOCK'
    badge.className = `pill ${m.mode === 'llm' ? 'llm' : 'mock'}`
    const sel = $('ai-model')
    sel.innerHTML = ''
    for (const id of m.available || []) {
      const o = document.createElement('option')
      o.value = id
      o.textContent = id
      if (id === m.current) o.selected = true
      sel.appendChild(o)
    }
    $('ai-mock').checked = !!m.forceMock
    $('ai-cache').checked = m.cacheEnabled !== false
    $('ai-persona').value = m.personaLevel || ''
  } catch {
    $('ai-cur').textContent = 'intelligence unreachable'
    $('ai-model').innerHTML = '<option>unavailable</option>'
  }
}
const aiPost = async (path, body) => {
  const r = await fetch(`${HOST}/admin/ai/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (r.ok) {
    flash('s-ai')
    loadAI()
  }
}
$('ai-model').onchange = (e) => aiPost('model', { model: e.target.value })
$('ai-mock').onchange = (e) => aiPost('mode', { forceMock: e.target.checked })
$('ai-cache').onchange = (e) => aiPost('cache', { enabled: e.target.checked })
$('ai-persona').onchange = (e) => aiPost('persona', { level: e.target.value || null })
loadAI()

// ══ Orders + wallet (SSE live) ═══════════════════════════════════════════════
const STATUS = { 10: 'ACTIVE', 20: 'FILLED', 30: 'PARTIAL', 40: 'PART-CXL', 50: 'CANCELED' }
let orders = []
let fillMode = 'working'
function renderOrders() {
  const open = orders.filter((o) => o.status === 10 || o.status === 30)
  const el = $('orderlist')
  if (!open.length) {
    el.innerHTML =
      '<div class="empty">No resting orders. Place a limit order from Hippo (off-market so it rests) to act on it here.</div>'
    return
  }
  const manual = fillMode === 'manual'
  el.innerHTML = `<table><thead><tr><th>ID</th><th>Pair</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Status</th><th></th></tr></thead><tbody>${open.map((o) => `<tr><td>${o.id}</td><td>${o.pairName}${o.market === 'perp' ? ` ·${o.leverage || ''}x` : ''}</td><td class="side-${o.side}">${o.side === 'sell' ? 'SELL' : 'BUY'}</td><td>${(o.kind || '').toUpperCase()}</td><td>${o.qty}</td><td>${fmt(o.rate, o.rate >= 1000 ? 0 : 2)}</td><td>${STATUS[o.status] || o.status}</td><td>${manual ? `<button class="rowbtn fill" data-fl="${o.id}">Fill</button> ` : ''}<button class="rowbtn cancel" data-cx="${o.id}">Cancel</button></td></tr>`).join('')}</tbody></table>`
  for (const b of el.querySelectorAll('[data-cx]'))
    b.onclick = () => fetch(`${HOST}/ui/orders/${b.dataset.cx}/cancel`, { method: 'POST' })
  for (const b of el.querySelectorAll('[data-fl]'))
    b.onclick = () => fetch(`${HOST}/ui/orders/${b.dataset.fl}/fill`, { method: 'POST' })
}
function renderBalances(bals) {
  $('w-bal').textContent =
    (bals || [])
      .map((b) => `${fmt(b.amount, b.currencyName === 'USDT' ? 2 : 4)} ${b.currencyName}`)
      .join(' · ') || '—'
}
$('w-reset').onclick = async () => {
  await fetch(`${HOST}/ui/wallet/reset`, { method: 'POST' })
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
      fillMode = e.config?.fillMode || 'working'
      applyConfig(e.config)
      renderOrders()
      renderBalances(e.balances)
    } else if (e.type === 'order' || e.type === 'fill') upsert(e.order)
    else if (e.type === 'balances') renderBalances(e.balances)
    else if (e.type === 'config') {
      fillMode = e.config?.fillMode || fillMode
      applyConfig(e.config)
      renderOrders()
    }
  }
}
connectSSE()
