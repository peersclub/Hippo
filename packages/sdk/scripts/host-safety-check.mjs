/* Host-safety gate (PRD gate 3). Proves, in a real browser, that the built
 * SDK holds its isolation contract on a hostile page:
 *
 *   1. Pill renders BYTE-IDENTICAL under aggressive host CSS + strict CSP
 *      (no unsafe-inline) vs a clean baseline page.
 *   2. Zero new window globals on either page.
 *   3. Zero host layout shift from mounting (element rects + CLS entries).
 *   4. Zero CSP violations attributed to the SDK.
 *   5. Opening the panel (dynamic import) keeps 2-4 true.
 *
 * `--self-test` serves a deliberately sabotaged loader (global leak + a
 * <style>-only injection path) and MUST exit non-zero — a gate that has
 * never been seen red is not a gate. CI runs both directions.
 *
 * Requires a Playwright chromium (CI: `npx playwright@<ver> install chromium`).
 */

import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(SDK_ROOT, 'dist')
const FIXTURES = join(SDK_ROOT, 'test', 'host-safety')
const SELF_TEST = process.argv.includes('--self-test')
const VIEWPORT = { width: 1280, height: 720 }
// Bottom-right clip fully inside the fixtures' #hs-patch (340x130 anchored
// right/bottom), so both pages share every background pixel of the clip.
const CLIP = { x: VIEWPORT.width - 336, y: VIEWPORT.height - 126, width: 332, height: 122 }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.map': 'application/json',
}

function sabotage(loaderSrc) {
  // Two deliberate contract violations the checker must catch:
  // a global leak, and styling via a <style> element only (which the
  // hostile page's CSP strips, so the pill renders unstyled there).
  return (
    'window.__hippoLeak = 1;\n' +
    loaderSrc.replaceAll(
      'new CSSStyleSheet()',
      '(() => { throw new Error("force <style> path") })()',
    )
  )
}

function serve() {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    let file = null
    if (url.startsWith('/dist/')) file = join(DIST, url.slice('/dist/'.length))
    else if (url.startsWith('/fixtures/')) file = join(FIXTURES, url.slice('/fixtures/'.length))
    else if (url === '/clean' || url === '/hostile')
      file = join(FIXTURES, `${url.slice(1)}-host.html`)
    if (!file || !existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    let body = readFileSync(file)
    if (SELF_TEST && file === join(DIST, 'loader.js'))
      body = Buffer.from(sabotage(body.toString('utf-8')))
    res
      .writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      .end(body)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function importChromium() {
  for (const pkg of ['playwright-core', 'playwright', '@playwright/test']) {
    try {
      return (await import(pkg)).chromium
    } catch {
      /* next */
    }
  }
  throw new Error(
    'no playwright package found — `npx playwright install chromium` and add playwright-core',
  )
}

async function inspect(page, base, path) {
  await page.goto(`${base}${path}`, { waitUntil: 'load' })
  // The loader mounts on load + setTimeout(0); give it a beat, then settle.
  await page.waitForSelector('hippo-root', { state: 'attached', timeout: 5000 })
  await page.waitForTimeout(400)
  const pre = await page.evaluate(() => ({
    newGlobals: window.__hsProbe.newGlobals(),
    rectsBefore: window.__hsProbe.rectsBefore,
    rectsNow: window.__hsProbe.rectsNow(),
    violations: window.__hsProbe.violations,
    shifts: window.__hsProbe.shifts,
  }))
  const shot = await page.screenshot({ clip: CLIP })
  // Open the panel through the pill's own click path (closed shadow — real
  // coordinates, not selectors), then re-assert the invariants.
  await page.mouse.click(VIEWPORT.width - 100, VIEWPORT.height - 49)
  await page.waitForTimeout(1500)
  const post = await page.evaluate(() => ({
    newGlobals: window.__hsProbe.newGlobals(),
    violations: window.__hsProbe.violations,
    rootAlive: document.querySelector('hippo-root') !== null,
  }))
  return { pre, post, shot }
}

/* Allowlists — every entry carries its reason, same discipline as the SDK's
 * i18n exemptions (PR #110). Anything not named here still fails the gate. */
// Zod 4 stores its config + schema registry on globalThis BY DESIGN so
// separately-bundled zod copies interoperate. Namespaced, non-executable
// data. Revisit if the panel ever drops zod from the browser bundle.
const ALLOWED_GLOBALS = new Set(['__zod_globalConfig', '__zod_globalRegistry'])
// The fixtures point the SDK at a dead gateway and block it via
// connect-src 'self' to force the offline path — those violations are the
// fixture's doing. A real partner allowlists their gateway origin in
// connect-src; the SDK must produce no OTHER violation class.
const violationAllowed = (v) =>
  v.directive === 'connect-src' && String(v.blocked).startsWith('http://127.0.0.1:9')

const failures = []
const check = (ok, label, detail) => {
  console.log(
    `${ok ? '  ok ' : 'FAIL '} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`,
  )
  if (!ok) failures.push(label)
}

const rectsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const server = await serve()
const base = `http://127.0.0.1:${server.address().port}`
const chromium = await importChromium()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  const clean = await inspect(await ctx.newPage(), base, '/clean')
  const hostile = await inspect(await ctx.newPage(), base, '/hostile')

  for (const [name, r] of [
    ['clean', clean],
    ['hostile', hostile],
  ]) {
    const leakedPre = r.pre.newGlobals.filter((g) => !ALLOWED_GLOBALS.has(g))
    const leakedPost = r.post.newGlobals.filter((g) => !ALLOWED_GLOBALS.has(g))
    check(leakedPre.length === 0, `${name}: zero globals after mount`, leakedPre.join(','))
    check(leakedPost.length === 0, `${name}: zero globals after panel open`, leakedPost.join(','))
    check(
      rectsEqual(r.pre.rectsBefore, r.pre.rectsNow),
      `${name}: host element rects unmoved by mount`,
    )
    check(
      r.pre.shifts.length === 0,
      `${name}: zero layout-shift entries`,
      JSON.stringify(r.pre.shifts),
    )
    check(r.post.rootAlive, `${name}: hippo-root alive after panel open`)
  }
  // The hostile page's CSP must stay clean: the SDK triggers no violations
  // beyond the fixture-induced gateway block. (probe.js listens on document;
  // the fixture itself is authored to comply with its own CSP.)
  const cspDirty = [...hostile.pre.violations, ...hostile.post.violations].filter(
    (v) => !violationAllowed(v),
  )
  check(cspDirty.length === 0, 'hostile: CSP report clean', JSON.stringify(cspDirty))
  check(
    clean.shot.equals(hostile.shot),
    'pill byte-identical: hostile vs clean baseline',
    `clean ${clean.shot.length}B vs hostile ${hostile.shot.length}B`,
  )
} finally {
  await browser.close()
  server.close()
}

if (SELF_TEST) {
  // Sabotaged run: the gate must have caught the planted violations.
  if (failures.length === 0) {
    console.error('SELF-TEST FAILED: sabotaged loader passed the gate — the gate cannot fail')
    process.exit(1)
  }
  console.log(`self-test ok: sabotage caught (${failures.length} failing checks, as intended)`)
  process.exit(0)
}
if (failures.length > 0) {
  console.error(`HOST-SAFETY GATE FAILED: ${failures.length} check(s): ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('host-safety gate: all checks green')
