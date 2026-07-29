/**
 * Stage-4 model-driven mapping synthesis — hermetic tests. Every model here is
 * a FAKE injected completion client (no network, no env), and retry-loop tests
 * inject a fake typecheck so the only real `ts.createProgram` runs are the two
 * explicitly budgeted ones.
 */
import { describe, expect, it } from 'vitest'
import type { LlmClient } from '../src/init/llm.js'
import {
  buildMappingPrompt,
  draftMapping,
  extractBody,
  renderMappingTs,
  synthesizeMappingModule,
} from '../src/init/mapping.js'
import type { AdapterConfig } from '../src/init/types.js'

const QUOTE_SHAPE = '{ symbol: string; price: string }'

/** Minimal single-op config: keeps real-typecheck tests inside the budget. */
function quoteOnlyConfig(responseShape?: string): AdapterConfig {
  return {
    venue: 'acme.exchange',
    baseUrl: 'https://api.acme.exchange',
    auth: { schemes: [], strategy: 'unknown' },
    tradeFeatures: null,
    operations: [
      {
        capability: 'quote',
        label: 'Quote / ticker',
        status: 'mapped',
        endpoint: 'GET /api/v3/ticker/price',
        alternates: [],
        needsMappingCode: true,
        note: 'confirm request/response shape against the CTI',
        ...(responseShape !== undefined ? { responseShape } : {}),
      },
    ],
    gaps: [],
    needsMappingCode: ['quote'],
  }
}

/** Fake completion client: scripted responses, captured prompts. */
function fakeClient(responses: Array<string | null>): { client: LlmClient; prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    client: {
      describe: () => 'fake-model @ nowhere',
      complete: async (prompt: string) => {
        prompts.push(prompt)
        return responses[prompts.length - 1] ?? null
      },
    },
  }
}

/** A typecheck that must never run (e.g. when the model is unconfigured). */
const forbiddenTypecheck = (): string[] => {
  throw new Error('typecheck must not be called on this path')
}

const GOOD_BODY = `const r = raw as { symbol?: unknown; price?: unknown }
if (typeof r.symbol !== 'string' || typeof r.price !== 'string') {
  throw new Error('mapQuote: missing symbol/price in venue response')
}
return { instrument: r.symbol, last: r.price, asOf: new Date().toISOString() }`

const BAD_BODY = 'return 42'
const FAKE_DIAGNOSTIC = "Type 'number' is not assignable to type 'Quote'."

/** Fake typecheck: flags any module that embeds the bad body. */
const fakeTypecheck = (source: string): string[] =>
  source.includes(BAD_BODY) ? [FAKE_DIAGNOSTIC] : []

describe('synthesizeMappingModule — unconfigured model', () => {
  it('emits byte-identical deterministic stubs and never typechecks', async () => {
    const config = quoteOnlyConfig(QUOTE_SHAPE)
    const result = await synthesizeMappingModule(config, null, forbiddenTypecheck)
    expect(result.source).toBe(renderMappingTs(draftMapping(config)))
    expect(result.outcomes).toEqual([
      {
        fn: 'mapQuote',
        capability: 'quote',
        outcome: 'stubbed',
        detail: 'model not configured (set LLM_BASE_URL and LLM_MODEL)',
      },
    ])
  })
})

describe('synthesizeMappingModule — accepted synthesis (real typecheck)', () => {
  // Real ts.createProgram run — same generous budget as the stub typecheck test.
  it('embeds a good model body after it typechecks', { timeout: 30_000 }, async () => {
    const { client, prompts } = fakeClient([GOOD_BODY])
    const result = await synthesizeMappingModule(quoteOnlyConfig(QUOTE_SHAPE), client)
    expect(result.outcomes).toEqual([
      {
        fn: 'mapQuote',
        capability: 'quote',
        outcome: 'synthesized',
        detail: 'typechecked on first attempt',
      },
    ])
    expect(prompts).toHaveLength(1)
    expect(result.source).toContain('return { instrument: r.symbol, last: r.price')
    expect(result.source).toContain('Body synthesized by `hippo init` stage 4')
    expect(result.source).not.toContain('venue→CTI mapping not implemented yet')
  })
})

describe('synthesizeMappingModule — validate → retry → fallback loop', () => {
  it('retries once with the diagnostics, then falls back to the stub', async () => {
    const { client, prompts } = fakeClient([BAD_BODY, BAD_BODY])
    const result = await synthesizeMappingModule(
      quoteOnlyConfig(QUOTE_SHAPE),
      client,
      fakeTypecheck,
    )

    // Exactly one retry, with the failure evidence in the second prompt.
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('A previous attempt failed the strict typecheck.')
    expect(prompts[1]).toContain(BAD_BODY)
    expect(prompts[1]).toContain(FAKE_DIAGNOSTIC)

    // Fallback: the throwing stub with the failure note, no bad body shipped.
    expect(result.outcomes[0]).toEqual({
      fn: 'mapQuote',
      capability: 'quote',
      outcome: 'stubbed',
      detail: 'model synthesis failed typecheck twice — throwing stub kept',
    })
    expect(result.source).toContain('// stage4: model synthesis failed typecheck — stub kept')
    expect(result.source).toContain(
      "throw new Error('mapQuote: venue→CTI mapping not implemented yet (hippo init stage 4)')",
    )
    expect(result.source).not.toContain(BAD_BODY)
  })

  it('accepts a corrected body on the retry', async () => {
    const { client, prompts } = fakeClient([BAD_BODY, GOOD_BODY])
    const result = await synthesizeMappingModule(
      quoteOnlyConfig(QUOTE_SHAPE),
      client,
      fakeTypecheck,
    )
    expect(prompts).toHaveLength(2)
    expect(result.outcomes[0]?.outcome).toBe('synthesized')
    expect(result.outcomes[0]?.detail).toBe('typechecked after one retry')
    expect(result.source).toContain('return { instrument: r.symbol, last: r.price')
  })

  it('keeps the plain stub when the client returns null', async () => {
    const { client } = fakeClient([null])
    const config = quoteOnlyConfig(QUOTE_SHAPE)
    const result = await synthesizeMappingModule(config, client, forbiddenTypecheck)
    expect(result.outcomes[0]?.outcome).toBe('stubbed')
    expect(result.outcomes[0]?.detail).toBe('model returned no usable body')
    expect(result.source).toBe(renderMappingTs(draftMapping(config)))
  })
})

describe('buildMappingPrompt', () => {
  const op = draftMapping(quoteOnlyConfig(QUOTE_SHAPE)).ops[0]
  if (!op) throw new Error('fixture op missing')

  it('carries the endpoint, venue response shape, CTI decl and fixed signature', () => {
    const prompt = buildMappingPrompt(op)
    expect(prompt).toContain('GET /api/v3/ticker/price')
    expect(prompt).toContain(QUOTE_SHAPE)
    expect(prompt).toContain('export interface Quote {')
    expect(prompt).toContain('export function mapQuote(raw: VenueResponse): Quote {')
    expect(prompt).toContain('Return ONLY the statements of the function body')
    expect(prompt).toContain('never fabricate placeholder values')
  })

  it('says so and asks for a defensive mapping when no schema is documented', () => {
    const bare = draftMapping(quoteOnlyConfig()).ops[0]
    if (!bare) throw new Error('fixture op missing')
    const prompt = buildMappingPrompt(bare)
    expect(prompt).toContain('The venue documents NO response schema for this endpoint.')
    expect(prompt).toContain('defensive')
  })
})

describe('extractBody — completion normalization', () => {
  it('unwraps markdown fences and re-indents to the two-space base', () => {
    expect(extractBody('```ts\nreturn x\n```')).toBe('  return x')
  })

  it('unwraps a full function down to its statements', () => {
    const body = extractBody('export function mapQuote(raw: VenueResponse): Quote {\n  return q\n}')
    expect(body).toBe('  return q')
  })

  it('strips control bytes so they can never reach generated source', () => {
    expect(extractBody('return x\u0000\u0007')).toBe('  return x')
  })

  it('returns null when nothing usable remains', () => {
    expect(extractBody('')).toBeNull()
    expect(extractBody('```ts\n\n```')).toBeNull()
    expect(extractBody('function broken(')).toBeNull()
  })
})
