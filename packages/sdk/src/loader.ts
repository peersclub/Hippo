/**
 * Stage-1 loader. Zero dependencies — no Preact here. Jobs:
 *   1. Read config from its own <script> tag.
 *   2. Mount the floating "Ask Hippo" pill in a closed Shadow DOM after host load.
 *   3. On first interaction, dynamic-import the panel chunk and hand over the shadow root.
 *
 * Host-safety contract: nothing on the host page is touched, no globals are
 * created, a failure here disappears silently rather than erroring the host.
 */

type LoaderConfig = {
  key: string
  gateway: string
  panelUrl: string
}

;(() => {
  try {
    const script = document.currentScript as HTMLScriptElement | null
    if (!script) return
    const config: LoaderConfig = {
      key: script.dataset.hippoKey ?? '',
      gateway: script.dataset.hippoGateway ?? 'https://gw.hippo.app',
      panelUrl: script.dataset.hippoPanel ?? new URL('panel.js', script.src).href,
    }
    if (!config.key) return

    const mount = () => {
      const host = document.createElement('hippo-root')
      // Fixed stacking context of our own; the host's layout never shifts.
      host.style.cssText = 'position:fixed;z-index:2147483000;inset:auto 0 0 auto;'
      const shadow = host.attachShadow({ mode: 'closed' })

      const style = document.createElement('style')
      style.textContent = `
        .pill{position:fixed;right:26px;bottom:26px;display:flex;align-items:center;gap:9px;
          border:1px solid rgba(240,185,74,.45);background:linear-gradient(135deg,#1E212A,#171A21);
          color:#E9EBF0;font:600 13.5px system-ui,sans-serif;padding:12px 20px;border-radius:999px;
          cursor:pointer;box-shadow:0 12px 32px rgba(0,0,0,.55),0 0 0 4px rgba(240,185,74,.06);
          transition:transform .15s ease}
        .pill:hover{transform:translateY(-2px)}
        .pill:focus-visible{outline:2px solid #F0B94A;outline-offset:2px}
        .mark{width:22px;height:22px;border-radius:8px;background:#F0B94A;color:#15171D;
          display:grid;place-items:center;font-size:11px;font-weight:700}
        .evt{display:none;font:500 9.5px ui-monospace,monospace;letter-spacing:.06em;color:#F0B94A}
        .pill.alert .evt{display:inline}
        .pill.alert{animation:hglow 1.7s ease infinite;border-color:rgba(240,185,74,.75)}
        @keyframes hglow{0%,100%{box-shadow:0 12px 32px rgba(0,0,0,.55),0 0 0 0 rgba(240,185,74,.4)}
          50%{box-shadow:0 12px 32px rgba(0,0,0,.55),0 0 0 10px rgba(240,185,74,0)}}
      `
      shadow.appendChild(style)

      const pill = document.createElement('button')
      pill.className = 'pill'
      pill.setAttribute('aria-label', 'Ask Hippo')
      pill.innerHTML = '<span class="mark">H</span>Ask Hippo<span class="evt"></span>'
      shadow.appendChild(pill)
      document.body.appendChild(host)

      let panelPromise: Promise<unknown> | null = null
      const loadPanel = () =>
        (panelPromise ??= import(/* @vite-ignore */ config.panelUrl).then((mod) => {
          const m = mod as { mountPanel: (o: object) => void }
          m.mountPanel({ shadow, pill, config })
        }))

      pill.addEventListener('mouseenter', () => void loadPanel().catch(() => {}), { once: true })
      pill.addEventListener(
        'click',
        () =>
          void loadPanel()
            .then(() => pill.dispatchEvent(new CustomEvent('hippo:open')))
            .catch(() => (pill.style.display = 'none')),
      )
    }

    if (document.readyState === 'complete') {
      setTimeout(mount, 0)
    } else {
      window.addEventListener('load', () => setTimeout(mount, 0), { once: true })
    }
  } catch {
    // A loader failure must never surface on the host page.
  }
})()
