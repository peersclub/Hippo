/**
 * Stage 5 of `hippo init` (Build Plan/05) — embed integration.
 *
 * Deterministically generates the partner-side embed artifacts from a handful
 * of inputs (venue, partner key, gateway origin, optional theme/locale):
 *
 *   a. the one-line web `<script>` tag — mirroring the REAL loader contract
 *      (packages/sdk/src/loader.ts reads data-hippo-key / -gateway / -theme /
 *      -locale / -open off its own tag; only non-default attrs are emitted so
 *      the tag stays one line),
 *   b. the WebView shell URL for iOS / Android / React Native / Flutter —
 *      all four load the same `…/embed/mobile.html` with query-string config
 *      (packages/sdk/embed/README.md), differing only in bridge channel,
 *   c. a Markdown EMBED.md artifact the partner's engineers can follow.
 *
 * Plus an idempotent HTML injector for in-repo mode: insert the tag before
 * `</body>`, never duplicate an existing Hippo loader tag. No model involved —
 * plain code, mirroring config.ts. Detecting WHERE to inject on an arbitrary
 * site (which template, which page) is the agentic half of stage 5 and is
 * deliberately not here.
 */

/** Loader defaults (packages/sdk/src/loader.ts) — attrs matching these are omitted. */
export const DEFAULT_GATEWAY = 'https://gw.hippo.app'
export const DEFAULT_CDN = 'https://cdn.hippo.app'

export interface EmbedInputs {
  /** Venue name, used in the artifact copy (e.g. "acme.exchange"). */
  venue: string
  /** Partner embed key — data-hippo-key; without it the loader exits silently. */
  key: string
  /** Gateway origin (data-hippo-gateway). Default: the production gateway. */
  gateway?: string
  /** CDN origin serving loader.js and embed/mobile.html. */
  cdn?: string
  /** 'light' is the only non-default theme the loader reads (default: dark hero). */
  theme?: 'dark' | 'light'
  /** en | hi | hi-Latn | ar — the loader normalizes anything else to en. */
  locale?: string
}

export interface WebViewEmbed {
  platform: string
  container: string
  /** JS → native bridge channel the shell posts events on (embed/README.md). */
  bridge: string
  url: string
}

export interface EmbedArtifacts {
  venue: string
  key: string
  gateway: string
  cdn: string
  theme: 'dark' | 'light'
  locale: string | null
  loaderUrl: string
  /** The one-line web tag. */
  tag: string
  /** The shared mobile shell URL (auto-opens the panel by default). */
  shellUrl: string
  webviews: WebViewEmbed[]
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Origin with no trailing slash; throws on a non-URL so bad input fails loudly. */
function normalizeOrigin(raw: string, what: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${what} is not a valid URL: "${raw}"`)
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * The one-line web `<script>` tag. Mirrors the loader's dataset contract:
 * only attributes that diverge from the loader's own defaults are emitted, so
 * the common case stays exactly the "one line" the pitch promises.
 */
export function buildEmbedTag(inputs: EmbedInputs): string {
  const cdn = normalizeOrigin(inputs.cdn ?? DEFAULT_CDN, 'cdn')
  const gateway = normalizeOrigin(inputs.gateway ?? DEFAULT_GATEWAY, 'gateway')
  const attrs = [`src="${escapeAttr(`${cdn}/loader.js`)}"`, 'async']
  attrs.push(`data-hippo-key="${escapeAttr(inputs.key)}"`)
  if (gateway !== DEFAULT_GATEWAY) attrs.push(`data-hippo-gateway="${escapeAttr(gateway)}"`)
  if (inputs.theme === 'light') attrs.push('data-hippo-theme="light"')
  if (inputs.locale && inputs.locale !== 'en')
    attrs.push(`data-hippo-locale="${escapeAttr(inputs.locale)}"`)
  return `<script ${attrs.join(' ')}></script>`
}

/**
 * The WebView shell URL — `…/embed/mobile.html` beside the bundles, configured
 * entirely by query string (embed/README.md). The shell auto-opens the panel
 * unless `open=pill` is passed, which is what a native container wants.
 */
export function buildShellUrl(inputs: EmbedInputs): string {
  const cdn = normalizeOrigin(inputs.cdn ?? DEFAULT_CDN, 'cdn')
  const gateway = normalizeOrigin(inputs.gateway ?? DEFAULT_GATEWAY, 'gateway')
  const url = new URL(`${cdn}/embed/mobile.html`)
  url.searchParams.set('key', inputs.key)
  if (gateway !== DEFAULT_GATEWAY) url.searchParams.set('gateway', gateway)
  if (inputs.theme === 'light') url.searchParams.set('theme', 'light')
  if (inputs.locale && inputs.locale !== 'en') url.searchParams.set('locale', inputs.locale)
  return url.toString()
}

/** One shell, four containers — same URL, different JS→native bridge channel. */
const WEBVIEW_CONTAINERS: ReadonlyArray<Omit<WebViewEmbed, 'url'>> = [
  {
    platform: 'iOS',
    container: 'WKWebView',
    bridge: '`webkit.messageHandlers.hippo.postMessage(obj)`',
  },
  {
    platform: 'Android',
    container: 'WebView',
    bridge: '`HippoAndroid.postMessage(json)` via `@JavascriptInterface`',
  },
  {
    platform: 'React Native',
    container: 'react-native-webview',
    bridge: '`window.ReactNativeWebView.postMessage(json)`',
  },
  {
    platform: 'Flutter',
    container: 'webview_flutter',
    bridge: '`HippoFlutter.postMessage(json)` JavascriptChannel',
  },
]

/** Deterministically assemble every embed artifact from the inputs. Pure. */
export function draftEmbed(inputs: EmbedInputs): EmbedArtifacts {
  const cdn = normalizeOrigin(inputs.cdn ?? DEFAULT_CDN, 'cdn')
  const gateway = normalizeOrigin(inputs.gateway ?? DEFAULT_GATEWAY, 'gateway')
  const shellUrl = buildShellUrl(inputs)
  return {
    venue: inputs.venue,
    key: inputs.key,
    gateway,
    cdn,
    theme: inputs.theme === 'light' ? 'light' : 'dark',
    locale: inputs.locale ?? null,
    loaderUrl: `${cdn}/loader.js`,
    tag: buildEmbedTag(inputs),
    shellUrl,
    webviews: WEBVIEW_CONTAINERS.map((c) => ({ ...c, url: shellUrl })),
  }
}

// ── Idempotent HTML injection ─────────────────────────────────────────────

/**
 * A script tag that is already a Hippo loader: either it carries the
 * data-hippo-key attribute or its src points at a loader.js bundle.
 */
const EXISTING_LOADER = /<script\b[^>]*(?:\bdata-hippo-key\b|\bsrc\s*=\s*["'][^"']*loader\.js)/i

export function hasEmbedTag(html: string): boolean {
  return EXISTING_LOADER.test(html)
}

export interface InjectResult {
  html: string
  /** False when the document already carries a Hippo loader tag. */
  changed: boolean
}

/**
 * Insert the embed tag before `</body>` (matching its indentation), or append
 * it when the document has no `</body>`. Idempotent: a document that already
 * carries a Hippo loader tag — this one or any other — is returned unchanged,
 * so re-running `hippo init` never duplicates the embed.
 */
export function injectEmbedTag(html: string, tag: string): InjectResult {
  if (hasEmbedTag(html)) return { html, changed: false }

  // Inject before the LAST </body> — nested/example bodies earlier in the
  // document must not attract the tag.
  const bodyClose = /<\/body\s*>/gi
  let last: RegExpExecArray | null = null
  for (let m = bodyClose.exec(html); m !== null; m = bodyClose.exec(html)) last = m

  if (!last) {
    const sep = html.length === 0 || html.endsWith('\n') ? '' : '\n'
    return { html: `${html}${sep}${tag}\n`, changed: true }
  }

  // Reuse the indentation of the </body> line so the injected line sits flush.
  const lineStart = html.lastIndexOf('\n', last.index) + 1
  const indent = /^[ \t]*/.exec(html.slice(lineStart, last.index))?.[0] ?? ''
  const injected = `${indent}  ${tag}\n${indent}`
  const before = html.slice(0, last.index).replace(/[ \t]*$/, '')
  return { html: `${before}${injected}${html.slice(last.index)}`, changed: true }
}

// ── Markdown rendering ────────────────────────────────────────────────────

/** EMBED.md — the artifact the partner's engineers follow. */
export function renderEmbedMd(a: EmbedArtifacts): string {
  const lines: string[] = []
  const push = (...ls: string[]) => lines.push(...ls)

  push(
    `# Hippo Embed — ${a.venue}`,
    '',
    '_Generated by `hippo init` (stage 5, embed integration) · hippo-embed/0.1 — same loader, same panel, same server-driven cards on every surface._',
    '',
    '## Web — the one-line tag',
    '',
    'Add this before `</body>` on every page where traders should see the "Ask Hippo" pill:',
    '',
    '```html',
    a.tag,
    '```',
    '',
    '| Setting | Value | Notes |',
    '| --- | --- | --- |',
    `| Embed key | \`${a.key}\` | Required — without it the loader exits silently. |`,
    `| Gateway | \`${a.gateway}\` | ${a.gateway === DEFAULT_GATEWAY ? 'Default — omitted from the tag.' : 'Non-default — emitted as `data-hippo-gateway`.'} |`,
    `| Theme | ${a.theme} | ${a.theme === 'light' ? 'Emitted as `data-hippo-theme="light"` — a pure token swap.' : 'Default dark hero — no attribute needed.'} |`,
    `| Locale | ${a.locale ?? 'en (default)'} | ${a.locale && a.locale !== 'en' ? 'Emitted as `data-hippo-locale`; RTL locales flip the panel automatically.' : 'Default — no attribute needed.'} |`,
    '',
    'The loader mounts in a closed Shadow DOM, creates no globals, never shifts',
    'the host layout, and a failure disappears silently rather than erroring the',
    'host page.',
    '',
    '## Mobile — WebView shell',
    '',
    'Native apps load one shell URL; a WebView is just a browser, so the entire',
    'thin-client contract holds. The shell auto-opens the panel (pass `&open=pill`',
    'to keep the pill instead):',
    '',
    '```',
    a.shellUrl,
    '```',
    '',
    '| Platform | Container | JS → native bridge |',
    '| --- | --- | --- |',
  )
  for (const w of a.webviews) {
    push(`| ${w.platform} | ${w.container} | ${w.bridge} |`)
  }
  push(
    '',
    "Native → JS: `HippoShell.setTheme('light')` (live token swap) and",
    '`HippoShell.open()` (open the panel on demand).',
    '',
    '## Checklist',
    '',
    `- [ ] If the site enforces a CSP that restricts scripts, allow-list \`${a.cdn}\` (script-src) and \`${a.gateway}\` (connect-src) — \`hippo scan\` reports the current posture.`,
    '- [ ] Serve the tag on the trading screens first; it is safe everywhere.',
    '- [ ] Point `data-hippo-gateway` at the sandbox gateway until the venue flips the production switch (sandbox-only is the default safety rail).',
    '- [ ] Run `hippo verify` to compose the final Integration Verification Report.',
    '',
  )
  return lines.join('\n')
}

/** Short stdout summary, matching scan/conform conventions. */
export function renderEmbedSummary(a: EmbedArtifacts): string {
  return [
    `hippo embed — ${a.venue}`,
    `  Tag       ${a.tag}`,
    `  Shell     ${a.shellUrl}`,
    `  Gateway   ${a.gateway}${a.gateway === DEFAULT_GATEWAY ? ' (default)' : ''}`,
    `  Theme     ${a.theme} · locale: ${a.locale ?? 'en (default)'}`,
  ].join('\n')
}
