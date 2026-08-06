/**
 * Prompt ↔ parser taxonomy parity.
 *
 * Hippo's understanding stage is split across four codebases that each keep
 * their own copy of the same vocabulary:
 *
 *   1. the intent PROMPT          services/intelligence/prompts.py
 *   2. the intent PARSER          services/intelligence/intent.py
 *   3. the gateway's TYPES        services/gateway/src/orchestrator/intelligence.ts
 *   4. the eval HARNESS           evals/runner/intent_scoring.py
 *      (+ the wire contract in packages/protocol/src/frames.ts)
 *
 * When they drift, nothing throws — the turn just silently degrades. Three
 * real bugs this file exists to catch, all shipped and all invisible:
 *
 *   • `alert` was emitted by the parser's fast path, typed in the gateway, and
 *     framed in the protocol, but was in NEITHER the prompt's enum nor the
 *     parser's INTENTS allowlist — so the model could never return one and any
 *     phrasing outside the alert regex became research. Nothing armed.
 *   • the prompt's `order` schema listed only the seven SPOT fields, so the
 *     validator rebuilt orders from those seven and dropped capability /
 *     direction / leverage / marginMode / action / reduceOnly — a perp order
 *     reached the gateway shaped like a spot market buy.
 *   • the prompt's `hostAction.action` enum listed three chart verbs while the
 *     parser had been emitting six for a month.
 *
 * So: read the enum sites as TEXT and assert SET EQUALITY. Deliberately
 * vitest, not pytest — this gate must run even where the Python venv doesn't.
 * A future wave that teaches one side a new intent, verb or order field and
 * forgets the others turns this red instead of shipping a silent drop.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultInterpretation } from '../src/orchestrator/index.js'
import { HOST_ACTION_VERBS } from '../src/orchestrator/intelligence.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8')

const INTENT_PY = read('services/intelligence/intent.py')
const PROMPTS_PY = read('services/intelligence/prompts.py')
const INTELLIGENCE_TS = read('services/gateway/src/orchestrator/intelligence.ts')
const SCORING_PY = read('evals/runner/intent_scoring.py')
const FRAMES_TS = read('packages/protocol/src/frames.ts')

// ── source slicing ──────────────────────────────────────────────────────────

/** Source between two markers (exclusive). Throws loudly rather than silently
 * matching nothing — a test that stops finding its enum must FAIL, not pass. */
function between(src: string, start: string, end: string, label: string): string {
  const a = src.indexOf(start)
  if (a < 0) throw new Error(`${label}: start marker not found: ${start}`)
  const b = src.indexOf(end, a + start.length)
  if (b < 0) throw new Error(`${label}: end marker not found: ${end}`)
  return src.slice(a + start.length, b)
}

/** Balanced-brace block starting at the first `{` after `marker`. */
function braceBlock(src: string, marker: string, label: string): string {
  const at = src.indexOf(marker)
  if (at < 0) throw new Error(`${label}: marker not found: ${marker}`)
  const open = src.indexOf('{', at + marker.length)
  if (open < 0) throw new Error(`${label}: no opening brace after ${marker}`)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`${label}: unbalanced braces after ${marker}`)
}

/** Drop whole-line `#` comments so prose in them can't be read as vocabulary. */
const stripPyComments = (src: string): string => src.replace(/(^|\n)[^\n'"]*#[^\n]*/g, '$1')

/** Every bare identifier inside single or double quotes (snake_case intents
 * and verbs, camelCase order fields). Multi-word prose never matches. */
function quotedTokens(src: string): Set<string> {
  return new Set([...src.matchAll(/['"]([a-zA-Z][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1] as string))
}

const sorted = (s: Iterable<string>): string[] => [...s].sort()

// ── intent taxonomy ─────────────────────────────────────────────────────────

/** The `{...}` literal after `INTENT_SYSTEM_PROMPT`'s JSON `"intent":` key. */
const INTENT_PROMPT_BODY = between(
  PROMPTS_PY,
  'INTENT_SYSTEM_PROMPT = """',
  '"""',
  'prompts.py INTENT_SYSTEM_PROMPT',
)

function promptIntents(): Set<string> {
  const line = /"intent":\s*([^\n]+)/.exec(INTENT_PROMPT_BODY)
  if (!line) throw new Error('prompt: no "intent" enum line in INTENT_SYSTEM_PROMPT')
  return quotedTokens(line[1] as string)
}

function parserIntents(): Set<string> {
  return quotedTokens(stripPyComments(braceBlock(INTENT_PY, '\nINTENTS = ', 'intent.py INTENTS')))
}

function gatewayIntents(): Set<string> {
  return quotedTokens(
    between(INTELLIGENCE_TS, 'export type IntentKind =', '\n\n', 'intelligence.ts IntentKind'),
  )
}

function evalIntents(): Set<string> {
  return quotedTokens(
    stripPyComments(
      between(SCORING_PY, 'INTENTS: tuple[str, ...] = (', ')', 'intent_scoring.py INTENTS'),
    ),
  )
}

// ── host-action verbs ───────────────────────────────────────────────────────

/** The verbs `parse_host_action` actually RETURNS — scraped from the literal
 * `"action": "<verb>"` payloads in intent.py's host-action section. */
function emittedHostVerbs(): Set<string> {
  const region = between(
    INTENT_PY,
    '# --- host actions (chart control)',
    '# --- consolidated orders query',
    'intent.py parse_host_action section',
  )
  return new Set([...region.matchAll(/"action":\s*"([a-z_]+)"/g)].map((m) => m[1] as string))
}

/** The allowlist `_validate_host_action` gates LLM payloads on. */
function validatorHostVerbs(): Set<string> {
  return quotedTokens(
    stripPyComments(
      braceBlock(INTENT_PY, '_HOST_ACTION_VERBS = frozenset(', 'intent.py _HOST_ACTION_VERBS'),
    ),
  )
}

function promptHostVerbs(): Set<string> {
  const block = braceBlock(INTENT_PROMPT_BODY, '"hostAction":', 'prompt hostAction schema')
  const line = /"action":\s*([^\n]+)/.exec(block)
  if (!line) throw new Error('prompt: no hostAction.action enum line')
  return quotedTokens(line[1] as string)
}

/** The protocol's own "Well-known verbs:" doc list on HostActionFrame. */
function protocolHostVerbs(): Set<string> {
  const doc = between(FRAMES_TS, 'Well-known verbs:', '*/', 'frames.ts HostActionFrame doc')
  return new Set(
    doc
      .replace(/\n\s*\*/g, ' ')
      .replace(/\.\s*$/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

// ── order fields ────────────────────────────────────────────────────────────

function promptOrderFields(): Set<string> {
  const block = braceBlock(INTENT_PROMPT_BODY, '"order":', 'prompt order schema')
  return new Set([...block.matchAll(/"([a-zA-Z][a-zA-Z0-9]*)"\s*:/g)].map((m) => m[1] as string))
}

function validatorOrderFields(): Set<string> {
  return quotedTokens(
    stripPyComments(braceBlock(INTENT_PY, '_ORDER_FIELDS = frozenset(', 'intent.py _ORDER_FIELDS')),
  )
}

function gatewayOrderFields(): Set<string> {
  const block = between(
    INTELLIGENCE_TS,
    'export type OrderIntent = {',
    '\n}',
    'intelligence.ts OrderIntent',
  )
  return new Set([...block.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1] as string))
}

// ── the three assertions ────────────────────────────────────────────────────

describe('intent taxonomy parity', () => {
  it('the prompt, the parser, the gateway and the eval harness name the SAME intents', () => {
    const parser = parserIntents()
    // Sanity: the slicers found something real, so an empty match can never
    // make four empty sets "agree".
    expect(parser.size).toBeGreaterThan(5)
    expect(sorted(promptIntents())).toEqual(sorted(parser))
    expect(sorted(gatewayIntents())).toEqual(sorted(parser))
    expect(sorted(evalIntents())).toEqual(sorted(parser))
    // The bug that started this: `alert` reachable on every path, not just
    // the deterministic one.
    expect(parser.has('alert')).toBe(true)
  })

  it('every intent the parser can return is one the prompt can produce', () => {
    // Restated as a direction so a failure reads plainly: an intent in the
    // parser but not the prompt is UNREACHABLE on the model path.
    for (const intent of parserIntents()) {
      expect(promptIntents(), `prompt cannot return intent=${intent}`).toContain(intent)
    }
  })
})

describe('host-action verb parity', () => {
  it('the prompt, the validator, the parser, the gateway and the protocol agree', () => {
    const emitted = emittedHostVerbs()
    expect(emitted.size).toBeGreaterThan(3)
    const expected = sorted(emitted)
    expect(sorted(validatorHostVerbs())).toEqual(expected)
    expect(sorted(promptHostVerbs())).toEqual(expected)
    expect(sorted(protocolHostVerbs())).toEqual(expected)
    expect(sorted(HOST_ACTION_VERBS)).toEqual(expected)
  })
})

describe('order field parity', () => {
  it('the prompt schema, the validator allowlist and OrderIntent carry the same fields', () => {
    const gateway = gatewayOrderFields()
    expect(gateway.size).toBeGreaterThan(10)
    expect(sorted(promptOrderFields())).toEqual(sorted(gateway))
    expect(sorted(validatorOrderFields())).toEqual(sorted(gateway))
    // The money bug: the perp block must survive the prompt→validator→wire
    // round trip, or "go long 0.5 btc 10x" arrives shaped like a spot buy.
    for (const field of ['capability', 'direction', 'leverage', 'marginMode', 'reduceOnly']) {
      expect(promptOrderFields(), `prompt drops order.${field}`).toContain(field)
      expect(validatorOrderFields(), `validator drops order.${field}`).toContain(field)
    }
  })
})

describe('degraded-mode interpretation copy', () => {
  it('names what each host verb actually does', () => {
    const seen = new Set<string>()
    for (const verb of HOST_ACTION_VERBS) {
      const copy = defaultInterpretation('host_action', verb)
      expect(copy, `no copy for host verb ${verb}`).not.toBe('Adjusting the page for you.')
      expect(seen.has(copy), `duplicate interpretation copy for ${verb}: ${copy}`).toBe(false)
      seen.add(copy)
    }
  })

  it('only the chart verbs claim to touch the chart', () => {
    const chartVerbs = new Set(['set_timeframe', 'apply_indicator', 'remove_indicator'])
    for (const verb of HOST_ACTION_VERBS) {
      const mentionsChart = /chart/i.test(defaultInterpretation('host_action', verb))
      expect(mentionsChart, `${verb} interpretation talks about the chart`).toBe(
        chartVerbs.has(verb),
      )
    }
  })

  it('falls back honestly for an unknown verb', () => {
    expect(defaultInterpretation('host_action', 'teleport')).toBe('Adjusting the page for you.')
    expect(defaultInterpretation('host_action')).toBe('Adjusting the page for you.')
  })
})
