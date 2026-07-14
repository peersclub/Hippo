import { describe, expect, it } from 'vitest'
import { summarizeCsp } from '../src/scan/csp.js'
import { detectFramework, extractLocales, extractTitle } from '../src/scan/detect.js'
import { parseRobots } from '../src/scan/robots.js'

const page = (body: string, attrs = '') =>
  `<!doctype html><html${attrs}><head><title>Acme Exchange — Trade Crypto</title></head><body>${body}</body></html>`

describe('framework detection', () => {
  it('detects next.js via __NEXT_DATA__', () => {
    const html = page('<script id="__NEXT_DATA__" type="application/json">{}</script>')
    expect(detectFramework(html)).toEqual({
      name: 'next.js',
      evidence: '__NEXT_DATA__ bootstrap script',
    })
  })

  it('detects next.js via /_next/ asset paths, beating the react markers it also ships', () => {
    const html = page('<script src="/_next/static/chunks/main.js"></script><div data-reactroot>')
    expect(detectFramework(html).name).toBe('next.js')
  })

  it('detects nuxt via __NUXT__', () => {
    expect(detectFramework(page('<script>window.__NUXT__={}</script>')).name).toBe('nuxt')
  })

  it('detects angular via ng-version', () => {
    expect(detectFramework(page('<app-root ng-version="17.3.0"></app-root>')).name).toBe('angular')
  })

  it('detects wordpress via wp-content', () => {
    const html = page('<link rel="stylesheet" href="/wp-content/themes/acme/style.css">')
    expect(detectFramework(html).name).toBe('wordpress')
  })

  it('detects vue via scoped-style data-v- attributes', () => {
    expect(detectFramework(page('<div data-v-7ba5bd90 class="hero"></div>')).name).toBe('vue')
  })

  it('detects plain react via data-reactroot', () => {
    expect(detectFramework(page('<div id="root" data-reactroot></div>')).name).toBe('react')
  })

  it('falls back to unknown for a plain server-rendered page', () => {
    expect(detectFramework(page('<h1>Welcome</h1>'))).toEqual({ name: 'unknown', evidence: null })
  })
})

describe('title & locales', () => {
  it('extracts and trims the title', () => {
    expect(extractTitle(page(''))).toBe('Acme Exchange — Trade Crypto')
    expect(extractTitle('<title>\n  Spaced   out\n</title>')).toBe('Spaced out')
    expect(extractTitle('<body>no title</body>')).toBeNull()
  })

  it('collects html lang and hreflang alternates, dropping x-default', () => {
    const html = page(
      '<link rel="alternate" hreflang="de-DE" href="/de"><link rel="alternate" hreflang="x-default" href="/">',
      ' lang="en"',
    )
    expect(extractLocales(html)).toEqual(['en', 'de-de'])
  })
})

describe('CSP summarization', () => {
  it('summarizes a restrictive script-src with allowed hosts', () => {
    const csp = summarizeCsp(
      "default-src 'self'; script-src 'self' 'nonce-abc123' https://cdn.acme.com *.trusted.io; img-src *",
    )
    expect(csp.scriptDirective).toBe('script-src')
    expect(csp.restrictsScripts).toBe(true)
    expect(csp.allowsUnsafeInline).toBe(false)
    expect(csp.scriptHosts).toEqual(['https://cdn.acme.com', '*.trusted.io'])
  })

  it('falls back to default-src when script-src is absent', () => {
    const csp = summarizeCsp("default-src 'self' 'unsafe-inline'")
    expect(csp.scriptDirective).toBe('default-src')
    expect(csp.restrictsScripts).toBe(true)
    expect(csp.allowsUnsafeInline).toBe(true)
    expect(csp.scriptHosts).toEqual([])
  })

  it('treats a bare wildcard as non-restrictive', () => {
    const csp = summarizeCsp('script-src *')
    expect(csp.restrictsScripts).toBe(false)
  })

  it('reports no script governance when neither directive exists', () => {
    const csp = summarizeCsp("frame-ancestors 'none'")
    expect(csp.scriptDirective).toBeNull()
    expect(csp.restrictsScripts).toBe(false)
  })
})

describe('robots.txt parsing', () => {
  it('extracts sitemaps and API-looking disallows', () => {
    const robots = parseRobots(
      [
        'User-agent: *',
        'Disallow: /admin/',
        'Disallow: /api/internal/ # keep bots out',
        'Disallow: /graphql',
        'Sitemap: https://acme.com/sitemap.xml',
      ].join('\n'),
    )
    expect(robots.sitemaps).toEqual(['https://acme.com/sitemap.xml'])
    expect(robots.disallowCount).toBe(3)
    expect(robots.apiDisallows).toEqual(['/api/internal/', '/graphql'])
  })
})
