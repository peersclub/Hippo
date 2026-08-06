/**
 * Recurrence guard for SDK chrome localization.
 *
 * The drift this exists to stop: a button, badge or section heading ships with
 * its English words typed straight into the JSX, so it never enters the i18n
 * catalog and a Hindi/Arabic panel silently renders English. The worst variant
 * pairs a LOCALIZED `aria-label` with a hardcoded visible label — a screen
 * reader saying one language while the eye reads another.
 *
 * The check reads the SOURCE of the three rendering files, extracts everything
 * that reaches a human (JSX text nodes, string literals in child position, and
 * the handful of attributes that are read aloud), and fails on any run of ≥3
 * Latin letters that is not inside a `t(...)` call. Three letters is the
 * threshold that clears glyphs (✓ ⧉ ↻ ⚠ ● ⌫), mono punctuation and the
 * single-letter brand mark while catching the shortest real word.
 *
 * Anything legitimately un-catalogued goes in ALLOWLIST **with a reason**. The
 * suite also fails on a stale allowlist entry, so the list can't rot into a
 * dumping ground.
 *
 * NOT covered on purpose: server-authored content. The SDK renders `rows[]`,
 * `statusLine`, `question`, option labels and brief prose verbatim by product
 * law (docs/vault/Reference/SDK Stop-Line Review.md) — those arrive as
 * expressions, never literals, so they never reach this scanner.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCES = ['cards.tsx', 'panel.tsx', 'overlays.tsx'] as const

/** Attributes a human actually reads or hears. Everything else — class, role,
 * key, style, viewBox, d … — is machine-facing and must never be localized. */
const VISIBLE_ATTRS = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'label',
  'placeholder',
  'title',
])

const LATIN_RUN = /[A-Za-z]{3,}/

/**
 * Rendered strings that are deliberately NOT in the catalog. One line of why
 * per entry — if the reason doesn't survive reading, the string belongs in
 * i18n.ts instead.
 */
const ALLOWLIST: ReadonlyArray<{ text: string; why: string }> = [
  {
    text: 'Hippo',
    why: 'Product name. A brand mark is the same word in every locale — translating it would make the share card look like a different product.',
  },
  // ── Counsel-owned copy ──────────────────────────────────────────────────
  // These are claims about what the product will and will not do, not chrome.
  // They are the wording a regulator would read back to us, so a first-pass
  // machine translation is worse than English: it changes the promise. They
  // enter the catalog when reviewed copy exists per locale, not before.
  {
    text: 'Ground rules',
    why: 'Heading of the counsel-owned consent step; moves into the catalog with the claims it introduces, not before them.',
  },
  {
    text: 'Hippo explains, never advises',
    why: 'The advice-line claim (baseline §6). Reworded by an unreviewed translation, it stops being the promise counsel signed off.',
  },
  {
    text: "Anyone who gives trading calls inside a chat isn't on your side.",
    why: 'Body of the advice-line claim — same review requirement as the heading it sits under.',
  },
  {
    text: 'You stay in control',
    why: 'The explicit-confirm claim. Localizing it un-reviewed risks softening a guarantee about order execution.',
  },
  {
    text: 'Nothing executes without your explicit confirm on',
    why: 'Body of the explicit-confirm claim; the venue name that completes the sentence is the partner value, drawn verbatim.',
  },
  {
    text: 'MARKET INFORMATION · NOT INVESTMENT ADVICE',
    why: 'Printed disclaimer on the exported share card (baseline §6, marked non-negotiable). Deliberately still English pending per-locale counsel review — see the note in i18n.ts; an un-reviewed disclaimer is a compliance risk, not a translation gap.',
  },
  // ── Pending product decision ────────────────────────────────────────────
  {
    text: 'BUY',
    why: 'Trading term. Whether BUY/SELL localize or stay English on every venue is an open product decision — traders often read the English on the venue itself. Allowlisted so the choice is made deliberately, not by omission.',
  },
  {
    text: 'SELL',
    why: 'Trading term — same open decision as BUY.',
  },
]

type Hit = { file: string; line: number; text: string; kind: string }

/** Minimal JSX/TS scanner. Tracks three contexts — JS code, an opening tag,
 * and element children — and only harvests strings from positions that render:
 * text nodes, literals inside a child `{…}` expression, and visible attributes.
 * `t(…)` calls are skipped whole, so a localized string never registers. */
function scan(src: string, file: string): Hit[] {
  const hits: Hit[] = []
  const n = src.length
  const lineStarts = [0]
  for (let k = 0; k < n; k++) if (src[k] === '\n') lineStarts.push(k + 1)
  const lineOf = (idx: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((lineStarts[mid] as number) <= idx) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  function readQuoted(pos: number): [string, number] {
    const q = src[pos]
    let j = pos + 1
    let buf = ''
    while (j < n) {
      const c = src[j]
      if (c === '\\') {
        buf += src[j + 1] ?? ''
        j += 2
        continue
      }
      if (c === q) {
        j++
        break
      }
      buf += c
      j++
    }
    return [buf, j]
  }

  function readTemplate(pos: number): [string, number] {
    let j = pos + 1
    let buf = ''
    while (j < n) {
      const c = src[j]
      if (c === '\\') {
        buf += src[j + 1] ?? ''
        j += 2
        continue
      }
      if (c === '`') {
        j++
        break
      }
      if (c === '$' && src[j + 1] === '{') {
        j = skipBalanced(j + 1, '{', '}')
        buf += ' '
        continue
      }
      buf += c
      j++
    }
    return [buf, j]
  }

  /** Skip a balanced `(…)` / `{…}` region, staying out of strings + comments. */
  function skipBalanced(pos: number, open: string, close: string): number {
    let depth = 0
    let j = pos
    while (j < n) {
      const c = src[j]
      if (c === "'" || c === '"') {
        j = readQuoted(j)[1]
        continue
      }
      if (c === '`') {
        j = readTemplate(j)[1]
        continue
      }
      if (c === '/' && src[j + 1] === '/') {
        const nl = src.indexOf('\n', j)
        j = nl < 0 ? n : nl
        continue
      }
      if (c === '/' && src[j + 1] === '*') {
        const end = src.indexOf('*/', j)
        j = end < 0 ? n : end + 2
        continue
      }
      if (c === open) {
        depth++
        j++
        continue
      }
      if (c === close) {
        depth--
        j++
        if (depth === 0) return j
        continue
      }
      j++
    }
    return n
  }

  const record = (kind: string, at: number, text: string) => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (LATIN_RUN.test(normalized)) hits.push({ file, line: lineOf(at), text: normalized, kind })
  }

  /** `'buy'` in `side === 'buy'` is a wire enum being compared, not drawn. */
  const isComparand = (start: number, end: number) => {
    const before = src.slice(Math.max(0, start - 12), start).trimEnd()
    if (/[=!]==?$/.test(before) || /\bcase$/.test(before)) return true
    return /^\s*[=!]==?/.test(src.slice(end, end + 6))
  }

  const tagNameEnd = (pos: number) => {
    const m = /^[A-Za-z][\w.:-]*/.exec(src.slice(pos))
    return pos + (m ? m[0].length : 0)
  }

  /** `<` opens an element (rather than a comparison or a type parameter) when
   * the last meaningful character before it can't end an expression. Comments
   * sit between the two constantly — `/* … *\/ <button` — so walk back over
   * them first, or every commented element looks like a comparison. */
  const isJsxStart = (pos: number) => {
    const next = src[pos + 1] ?? ''
    if (!/[A-Za-z>]/.test(next)) return false
    let j = pos - 1
    for (;;) {
      while (j >= 0 && /\s/.test(src[j] as string)) j--
      if (j >= 1 && src[j] === '/' && src[j - 1] === '*') {
        const open = src.lastIndexOf('/*', j - 1)
        if (open < 0) break
        j = open - 1
        continue
      }
      const lineStart = src.lastIndexOf('\n', j) + 1
      const line = src.slice(lineStart, j + 1)
      const cm = line.indexOf('//')
      const quoted = cm > 0 && /['"`]/.test(line.slice(0, cm))
      if (cm >= 0 && !quoted) {
        j = lineStart + cm - 1
        continue
      }
      break
    }
    const prev = j >= 0 ? (src[j] as string) : ''
    if ('({[=>,&|?:;!'.includes(prev) || prev === '') return true
    return /\breturn$/.test(src.slice(Math.max(0, j - 8), j + 1))
  }

  type Frame = { k: 'code'; collect: boolean; depth: number } | { k: 'tag' } | { k: 'children' }
  const stack: Frame[] = [{ k: 'code', collect: false, depth: 0 }]
  let i = 0

  while (i < n) {
    const top = stack[stack.length - 1] as Frame

    if (top.k === 'children') {
      if (src.startsWith('</', i)) {
        const gt = src.indexOf('>', i)
        i = gt < 0 ? n : gt + 1
        stack.pop()
        continue
      }
      if (src[i] === '<' && src[i + 1] === '>') {
        i += 2
        stack.push({ k: 'children' })
        continue
      }
      if (src[i] === '<' && /[A-Za-z]/.test(src[i + 1] ?? '')) {
        i = tagNameEnd(i + 1)
        stack.push({ k: 'tag' })
        continue
      }
      if (src[i] === '{') {
        i++
        stack.push({ k: 'code', collect: true, depth: 0 })
        continue
      }
      let j = i
      while (j < n && src[j] !== '<' && src[j] !== '{') j++
      record('jsx-text', i, src.slice(i, j))
      i = j
      continue
    }

    if (top.k === 'tag') {
      if (/\s/.test(src[i] as string)) {
        i++
        continue
      }
      if (src.startsWith('/>', i)) {
        i += 2
        stack.pop()
        continue
      }
      if (src[i] === '>') {
        i++
        stack.pop()
        stack.push({ k: 'children' })
        continue
      }
      if (src[i] === '{') {
        i = skipBalanced(i, '{', '}') // {...spread}
        continue
      }
      const m = /^[A-Za-z_][\w.:-]*/.exec(src.slice(i))
      if (!m) {
        i++
        continue
      }
      const name = m[0]
      let j = i + name.length
      while (j < n && /\s/.test(src[j] as string)) j++
      if (src[j] !== '=') {
        i = j
        continue
      }
      j++
      while (j < n && /\s/.test(src[j] as string)) j++
      const visible = VISIBLE_ATTRS.has(name)
      if (src[j] === '"' || src[j] === "'") {
        const [text, end] = readQuoted(j)
        if (visible) record(`attr:${name}`, j, text)
        i = end
        continue
      }
      if (src[j] === '{') {
        i = j + 1
        stack.push({ k: 'code', collect: visible, depth: 0 })
        continue
      }
      i = j
      continue
    }

    // code
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? n : nl
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i)
      i = end < 0 ? n : end + 2
      continue
    }
    if (c === "'" || c === '"') {
      const [text, end] = readQuoted(i)
      if (top.collect && !isComparand(i, end)) record('jsx-child', i, text)
      i = end
      continue
    }
    if (c === '`') {
      const [text, end] = readTemplate(i)
      if (top.collect) record('jsx-child', i, text)
      i = end
      continue
    }
    if (c === 't' && !/[\w$.]/.test(src[i - 1] ?? '')) {
      let j = i + 1
      while (j < n && /\s/.test(src[j] as string)) j++
      if (src[j] === '(') {
        i = skipBalanced(j, '(', ')')
        continue
      }
    }
    if (c === '<' && isJsxStart(i)) {
      if (src[i + 1] === '>') {
        i += 2
        stack.push({ k: 'children' })
      } else {
        i = tagNameEnd(i + 1)
        stack.push({ k: 'tag' })
      }
      continue
    }
    if (c === '{') {
      top.depth++
      i++
      continue
    }
    if (c === '}') {
      if (top.depth > 0) top.depth--
      else if (stack.length > 1) stack.pop()
      i++
      continue
    }
    i++
  }
  return hits
}

const hits = SOURCES.flatMap((f) =>
  scan(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), f),
)

describe('SDK chrome i18n coverage', () => {
  it('finds rendered strings at all (the scanner is not silently broken)', () => {
    // Sanity floor: the allowlist alone guarantees a handful of hits. A scanner
    // that returns nothing would make every other assertion here vacuous.
    expect(hits.length).toBeGreaterThanOrEqual(ALLOWLIST.length)
  })

  it('routes every rendered English string through the i18n catalog', () => {
    const allowed = new Set(ALLOWLIST.map((a) => a.text))
    const offenders = hits
      .filter((h) => !allowed.has(h.text))
      .map((h) => `${h.file}:${h.line} [${h.kind}] ${JSON.stringify(h.text)}`)
    expect(offenders).toEqual([])
  })

  it('carries a reason for every allowlisted string', () => {
    for (const entry of ALLOWLIST) expect(entry.why.trim().length).toBeGreaterThan(10)
  })

  it('has no stale allowlist entries', () => {
    const seen = new Set(hits.map((h) => h.text))
    expect(ALLOWLIST.filter((a) => !seen.has(a.text)).map((a) => a.text)).toEqual([])
  })
})
