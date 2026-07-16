/**
 * Theme controller — manual persisted toggle, NOT a media query.
 * Dark is the locked hero (default); light is the secondary lean,
 * a pure token swap on :root[data-theme="light"].
 *
 * The same choice is pushed onto the SDK's <hippo-root> host, whose
 * tokenized panel (PR #12) does its own pure token swap on
 * [data-theme="light"] — one toggle themes the page AND the product.
 */
const KEY = 'hippo_theme'

function current() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function apply(theme) {
  if (theme === 'light') document.documentElement.dataset.theme = 'light'
  else delete document.documentElement.dataset.theme

  // Keep the embedded SDK in step (mounts async — see observer below).
  const host = document.querySelector('hippo-root')
  if (host) {
    if (theme === 'light') host.dataset.theme = 'light'
    else delete host.dataset.theme
  }

  for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
    btn.textContent = theme === 'light' ? '☾' : '☀'
    btn.title = theme === 'light' ? 'Dark lean (hero)' : 'Light lean'
  }
}

// Boot: honour the persisted choice (the <head> pre-paint script already set
// the attribute to avoid a flash; this pass syncs buttons + SDK host).
let theme = 'dark'
try {
  if (localStorage.getItem(KEY) === 'light') theme = 'light'
} catch {}
apply(theme)

for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
  btn.addEventListener('click', () => {
    theme = current() === 'light' ? 'dark' : 'light'
    try {
      localStorage.setItem(KEY, theme)
    } catch {}
    apply(theme)
  })
}

// The SDK pill mounts after the loader boots — catch it and apply the theme.
new MutationObserver((_, obs) => {
  const host = document.querySelector('hippo-root')
  if (host) {
    if (current() === 'light') host.dataset.theme = 'light'
    obs.disconnect()
  }
}).observe(document.body, { childList: true })
