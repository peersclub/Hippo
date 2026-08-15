/* Host-side probe, loaded BEFORE the SDK loader. Records the baselines the
 * checker asserts against after mount. External file because the hostile
 * fixture's CSP (script-src 'self', no unsafe-inline) forbids inline scripts. */
;(() => {
  const globalsBefore = new Set(Object.getOwnPropertyNames(window))

  const rectOf = (id) => {
    const el = document.getElementById(id)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }

  const violations = []
  document.addEventListener('securitypolicyviolation', (e) => {
    violations.push({
      directive: e.violatedDirective,
      blocked: e.blockedURI,
      source: e.sourceFile,
      line: e.lineNumber,
      col: e.columnNumber,
      sample: e.sample,
    })
  })

  const shifts = []
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) shifts.push(entry.value)
        }
      }).observe({ type: 'layout-shift', buffered: true })
    } catch {
      /* layout-shift unsupported — checker treats missing observer as skip */
    }
  }

  window.__hsProbe = {
    globalsBefore: [...globalsBefore],
    // Captured at load, before the loader's deferred mount (setTimeout 0).
    rectsBefore: null,
    captureRects() {
      this.rectsBefore = { h1: rectOf('hs-h1'), p: rectOf('hs-p'), btn: rectOf('hs-btn') }
    },
    rectsNow() {
      return { h1: rectOf('hs-h1'), p: rectOf('hs-p'), btn: rectOf('hs-btn') }
    },
    newGlobals() {
      const before = new Set(this.globalsBefore)
      // __hsProbe is ours; everything else new is a leak.
      return Object.getOwnPropertyNames(window).filter((k) => !before.has(k) && k !== '__hsProbe')
    },
    violations,
    shifts,
  }

  window.addEventListener('load', () => window.__hsProbe.captureRects())
})()
