import { describe, expect, it } from 'vitest'
import {
  buildEmbedTag,
  buildShellUrl,
  DEFAULT_GATEWAY,
  draftEmbed,
  hasEmbedTag,
  injectEmbedTag,
  renderEmbedMd,
  renderEmbedSummary,
} from '../src/init/embed.js'

const inputs = {
  venue: 'acme.exchange',
  key: 'pk_acme',
  gateway: 'https://gw-staging.hippo.app',
  theme: 'light' as const,
  locale: 'hi',
}

describe('buildEmbedTag — mirrors the loader dataset contract', () => {
  it('emits the minimal one-line tag when everything is default', () => {
    const tag = buildEmbedTag({ venue: 'acme.exchange', key: 'pk_acme' })
    expect(tag).toBe(
      '<script src="https://cdn.hippo.app/loader.js" async data-hippo-key="pk_acme"></script>',
    )
  })

  it('emits data-hippo-gateway / -theme / -locale only when they diverge from loader defaults', () => {
    const tag = buildEmbedTag(inputs)
    expect(tag).toContain('data-hippo-gateway="https://gw-staging.hippo.app"')
    expect(tag).toContain('data-hippo-theme="light"')
    expect(tag).toContain('data-hippo-locale="hi"')
    // still a single line
    expect(tag).not.toContain('\n')
  })

  it('omits attrs that match the loader defaults (gateway, en locale, dark theme)', () => {
    const tag = buildEmbedTag({
      venue: 'acme.exchange',
      key: 'pk_acme',
      gateway: DEFAULT_GATEWAY,
      theme: 'dark',
      locale: 'en',
    })
    expect(tag).not.toContain('data-hippo-gateway')
    expect(tag).not.toContain('data-hippo-theme')
    expect(tag).not.toContain('data-hippo-locale')
  })

  it('escapes attribute values and rejects a non-URL gateway loudly', () => {
    const tag = buildEmbedTag({ venue: 'v', key: 'pk_"quote"' })
    expect(tag).toContain('data-hippo-key="pk_&quot;quote&quot;"')
    expect(() => buildEmbedTag({ venue: 'v', key: 'pk', gateway: 'not a url' })).toThrow(
      /gateway is not a valid URL/,
    )
  })
})

describe('buildShellUrl — the mobile WebView shell', () => {
  it('points at embed/mobile.html with query-string config', () => {
    const url = new URL(buildShellUrl(inputs))
    expect(url.origin + url.pathname).toBe('https://cdn.hippo.app/embed/mobile.html')
    expect(url.searchParams.get('key')).toBe('pk_acme')
    expect(url.searchParams.get('gateway')).toBe('https://gw-staging.hippo.app')
    expect(url.searchParams.get('theme')).toBe('light')
    expect(url.searchParams.get('locale')).toBe('hi')
  })

  it('carries only the key in the default case (shell defaults match the loader)', () => {
    const url = new URL(buildShellUrl({ venue: 'acme.exchange', key: 'pk_acme' }))
    expect([...url.searchParams.keys()]).toEqual(['key'])
  })

  it('normalizes a trailing slash on the cdn origin', () => {
    const url = buildShellUrl({ venue: 'v', key: 'pk', cdn: 'https://cdn.example.com/' })
    expect(url.startsWith('https://cdn.example.com/embed/mobile.html?')).toBe(true)
  })
})

describe('draftEmbed', () => {
  const a = draftEmbed(inputs)

  it('assembles tag, loader URL, and one shell URL shared by all four containers', () => {
    expect(a.loaderUrl).toBe('https://cdn.hippo.app/loader.js')
    expect(a.tag).toBe(buildEmbedTag(inputs))
    expect(a.webviews.map((w) => w.platform)).toEqual(['iOS', 'Android', 'React Native', 'Flutter'])
    for (const w of a.webviews) expect(w.url).toBe(a.shellUrl)
  })

  it('defaults theme to dark and locale to null', () => {
    const d = draftEmbed({ venue: 'v', key: 'pk' })
    expect(d.theme).toBe('dark')
    expect(d.locale).toBeNull()
    expect(d.gateway).toBe(DEFAULT_GATEWAY)
  })
})

describe('injectEmbedTag — idempotent HTML injection', () => {
  const tag = buildEmbedTag({ venue: 'acme.exchange', key: 'pk_acme' })

  it('inserts the tag before </body>, matching its indentation', () => {
    const html = '<html>\n  <body>\n    <p>hi</p>\n  </body>\n</html>\n'
    const out = injectEmbedTag(html, tag)
    expect(out.changed).toBe(true)
    expect(out.html).toBe(`<html>\n  <body>\n    <p>hi</p>\n    ${tag}\n  </body>\n</html>\n`)
  })

  it('injects before the LAST </body> when the document nests one in an example', () => {
    const html = '<pre>&lt;/body&gt;</pre>\n<body>x</body>\n<body>y</body>\n'
    const out = injectEmbedTag(html, tag)
    expect(out.html.indexOf(tag)).toBeGreaterThan(out.html.indexOf('<body>y'))
  })

  it('appends when the document has no </body>', () => {
    const out = injectEmbedTag('<h1>fragment</h1>', tag)
    expect(out.changed).toBe(true)
    expect(out.html).toBe(`<h1>fragment</h1>\n${tag}\n`)
  })

  it('is idempotent: injecting twice changes nothing the second time', () => {
    const first = injectEmbedTag('<body></body>', tag)
    const second = injectEmbedTag(first.html, tag)
    expect(second.changed).toBe(false)
    expect(second.html).toBe(first.html)
    expect(second.html.split('data-hippo-key').length - 1).toBe(1)
  })

  it('never duplicates an existing loader tag, even one it did not write', () => {
    const byKey = `<body><script data-hippo-key="pk_other" src="/x.js"></script></body>`
    const bySrc = `<body><script src='https://other.cdn/sdk/loader.js'></script></body>`
    expect(hasEmbedTag(byKey)).toBe(true)
    expect(hasEmbedTag(bySrc)).toBe(true)
    expect(injectEmbedTag(byKey, tag).changed).toBe(false)
    expect(injectEmbedTag(bySrc, tag).changed).toBe(false)
    // an unrelated script must not trip the detector
    expect(hasEmbedTag('<script src="/analytics.js"></script>')).toBe(false)
  })
})

describe('renderEmbedMd / renderEmbedSummary', () => {
  const a = draftEmbed(inputs)
  const md = renderEmbedMd(a)

  it('carries the tag, the shell URL, and the four bridge channels', () => {
    expect(md).toContain(`# Hippo Embed — ${inputs.venue}`)
    expect(md).toContain(a.tag)
    expect(md).toContain(a.shellUrl)
    expect(md).toContain('webkit.messageHandlers.hippo.postMessage')
    expect(md).toContain('HippoAndroid.postMessage')
    expect(md).toContain('window.ReactNativeWebView.postMessage')
    expect(md).toContain('HippoFlutter.postMessage')
  })

  it('flags the CSP allow-list and sandbox-gateway checklist items', () => {
    expect(md).toContain('allow-list')
    expect(md).toContain('sandbox')
  })

  it('summary carries venue, tag and shell on stdout', () => {
    const s = renderEmbedSummary(a)
    expect(s).toContain('hippo embed — acme.exchange')
    expect(s).toContain(a.tag)
    expect(s).toContain(a.shellUrl)
  })
})
