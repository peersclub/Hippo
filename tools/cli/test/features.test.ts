import { describe, expect, it } from 'vitest'
import type { OpenApiDoc } from '../src/scan/cti.js'
import { detectTradeFeatures } from '../src/scan/features.js'
import { exchangeSpec, futuresSpec, optionsSpec } from './fixtures/exchange-openapi.js'

describe('detectTradeFeatures — spot-only exchange spec', () => {
  const caps = detectTradeFeatures(exchangeSpec)

  it('enables only spot', () => {
    expect(Object.keys(caps)).toEqual(['spot'])
    expect(caps.futures_perp).toBeUndefined()
    expect(caps.options).toBeUndefined()
  })

  it('cites the order-placement endpoint as spot evidence', () => {
    expect(caps.spot?.endpoints).toEqual(['POST /api/v3/order'])
    expect(caps.spot?.paramsIncomplete).toBeUndefined()
  })
})

describe('detectTradeFeatures — futures-flavored spec', () => {
  const caps = detectTradeFeatures(futuresSpec)

  it('enables spot and futures_perp, not options', () => {
    expect(caps.spot).toBeDefined()
    expect(caps.futures_perp).toBeDefined()
    expect(caps.options).toBeUndefined()
  })

  it('keeps spot evidence off the derivatives-scoped placements', () => {
    expect(caps.spot?.endpoints).toEqual(['POST /api/v3/order'])
  })

  it('collects futures evidence endpoints', () => {
    expect(caps.futures_perp?.endpoints).toContain('POST /futures/v1/order')
    expect(caps.futures_perp?.endpoints).toContain('POST /futures/v1/leverage')
    expect(caps.futures_perp?.endpoints).toContain('GET /futures/v1/fundingRate')
    expect(caps.futures_perp?.endpoints).toContain('GET /futures/v1/positionRisk')
  })

  it('extracts maxLeverage from the documented leverage param maximum', () => {
    expect(caps.futures_perp?.maxLeverage).toBe(125)
  })

  it('extracts and normalizes margin modes from the marginType enum', () => {
    expect(caps.futures_perp?.marginModes?.sort()).toEqual(['cross', 'isolated'])
  })

  it('does not flag paramsIncomplete when both params were extracted', () => {
    expect(caps.futures_perp?.paramsIncomplete).toBeUndefined()
  })
})

describe('detectTradeFeatures — futures with undocumented params', () => {
  const doc: OpenApiDoc = {
    openapi: '3.0.0',
    paths: {
      '/derivatives/orders': {
        post: { summary: 'Place a derivatives order' },
      },
      '/derivatives/leverage': {
        post: {
          summary: 'Set leverage',
          // no documented maximum, no margin-mode enum anywhere
          parameters: [{ name: 'leverage', in: 'query', schema: { type: 'integer' } }],
        },
      },
    },
  }
  const caps = detectTradeFeatures(doc)

  it('enables futures_perp as a candidate but omits the unextractable params', () => {
    expect(caps.futures_perp).toBeDefined()
    expect(caps.futures_perp?.maxLeverage).toBeUndefined()
    expect(caps.futures_perp?.marginModes).toBeUndefined()
  })

  it('is honest about the heuristic limit: paramsIncomplete is set', () => {
    expect(caps.futures_perp?.paramsIncomplete).toBe(true)
  })

  it('does not enable spot when every placement is derivatives-scoped', () => {
    expect(caps.spot).toBeUndefined()
  })
})

describe('detectTradeFeatures — futures params in v2 inline / request-body shapes', () => {
  it('reads a swagger-v2 inline maximum and a requestBody marginMode enum', () => {
    const doc: OpenApiDoc = {
      swagger: '2.0',
      paths: {
        '/futures/leverage': {
          post: {
            summary: 'Set leverage',
            parameters: [{ name: 'leverage', in: 'formData', type: 'integer', maximum: 50 }],
          },
        },
        '/futures/margin-mode': {
          post: {
            summary: 'Set position margin mode',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    properties: { marginMode: { type: 'string', enum: ['isolated', 'cross'] } },
                  },
                },
              },
            },
          },
        },
      },
    }
    const caps = detectTradeFeatures(doc)
    expect(caps.futures_perp?.maxLeverage).toBe(50)
    expect(caps.futures_perp?.marginModes?.sort()).toEqual(['cross', 'isolated'])
    expect(caps.futures_perp?.paramsIncomplete).toBeUndefined()
  })
})

describe('detectTradeFeatures — options-flavored spec', () => {
  const caps = detectTradeFeatures(optionsSpec)

  it('enables only options for an options-only venue', () => {
    expect(Object.keys(caps)).toEqual(['options'])
  })

  it('cites chain/strike/order endpoints as evidence', () => {
    expect(caps.options?.endpoints).toContain('GET /api/v1/options/chain')
    expect(caps.options?.endpoints).toContain('GET /api/v1/options/instruments')
    expect(caps.options?.endpoints).toContain('POST /api/v1/options/order')
  })
})

describe('detectTradeFeatures — edge cases', () => {
  it('detects nothing from an empty doc (the no-spec-found path)', () => {
    expect(detectTradeFeatures({})).toEqual({})
  })

  it('treats call/put as an options signal only alongside an expiry co-signal', () => {
    const bare: OpenApiDoc = {
      openapi: '3.0.0',
      paths: { '/api/v1/settings': { put: { summary: 'Update account settings' } } },
    }
    expect(detectTradeFeatures(bare).options).toBeUndefined()

    const paired: OpenApiDoc = {
      openapi: '3.0.0',
      paths: { '/api/v1/expiries': { get: { summary: 'List call and put expiries' } } },
    }
    expect(detectTradeFeatures(paired).options).toBeDefined()
  })

  it('caps evidence endpoints like the CTI table', () => {
    const paths: Record<string, Record<string, unknown>> = {}
    for (let i = 0; i < 9; i++) {
      paths[`/futures/v1/endpoint${i}`] = { get: { summary: `Futures endpoint ${i}` } }
    }
    const caps = detectTradeFeatures({ openapi: '3.0.0', paths })
    expect(caps.futures_perp?.endpoints).toHaveLength(7)
    expect(caps.futures_perp?.endpoints?.at(-1)).toBe('… +3 more')
  })
})
