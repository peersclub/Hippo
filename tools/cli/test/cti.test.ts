import { describe, expect, it } from 'vitest'
import { extractAuthSchemes, isOpenApiDoc, mapToCti, specVersion } from '../src/scan/cti.js'
import type { CapabilityId } from '../src/scan/types.js'
import { exchangeSpec } from './fixtures/exchange-openapi.js'

const byId = (caps: ReturnType<typeof mapToCti>) =>
  new Map(caps.map((c) => [c.id, c])) as Map<CapabilityId, (typeof caps)[number]>

describe('CTI mapping — exchange-like OpenAPI fixture', () => {
  const caps = byId(mapToCti(exchangeSpec))

  it('covers all eight CTI capabilities exactly once', () => {
    expect([...caps.keys()].sort()).toEqual(
      [
        'balances',
        'cancel',
        'instruments',
        'orderPlacement',
        'orderStatus',
        'positions',
        'quote',
        'webhooks',
      ].sort(),
    )
  })

  it('finds quote/ticker', () => {
    const quote = caps.get('quote')
    expect(quote?.status).toBe('found')
    expect(quote?.endpoints).toContain('GET /api/v3/ticker/price')
  })

  it('finds order placement on POST /order and does not confuse it with cancel', () => {
    const placement = caps.get('orderPlacement')
    expect(placement?.status).toBe('found')
    expect(placement?.endpoints).toEqual(['POST /api/v3/order'])
  })

  it('finds order status via GET /order and openOrders', () => {
    const status = caps.get('orderStatus')
    expect(status?.status).toBe('found')
    expect(status?.endpoints).toContain('GET /api/v3/order')
    expect(status?.endpoints).toContain('GET /api/v3/openOrders')
    // "order book depth" must not read as order management
    expect(status?.endpoints).not.toContain('GET /api/v3/depth')
  })

  it('finds cancel via DELETE /order', () => {
    const cancel = caps.get('cancel')
    expect(cancel?.status).toBe('found')
    expect(cancel?.endpoints).toContain('DELETE /api/v3/order')
  })

  it('finds balances via the account endpoint summary', () => {
    expect(caps.get('balances')?.status).toBe('found')
  })

  it('finds instruments via exchangeInfo', () => {
    const instruments = caps.get('instruments')
    expect(instruments?.status).toBe('found')
    expect(instruments?.endpoints).toContain('GET /api/v3/exchangeInfo')
  })

  it('reports positions and webhooks as gaps with plain-words consequences', () => {
    const positions = caps.get('positions')
    const webhooks = caps.get('webhooks')
    expect(positions?.status).toBe('gap')
    expect(positions?.endpoints).toEqual([])
    expect(webhooks?.status).toBe('gap')
    expect(webhooks?.consequence).toContain('polling')
  })

  it('extracts declared auth schemes', () => {
    expect(extractAuthSchemes(exchangeSpec)).toEqual([
      'apiKey (apiKey, header:X-ACME-APIKEY)',
      'hmacSignature (apiKey, query:signature)',
    ])
  })
})

describe('CTI mapping — edge cases', () => {
  it('maps an empty doc to eight gaps (the no-spec-found path)', () => {
    const caps = mapToCti({})
    expect(caps).toHaveLength(8)
    expect(caps.every((c) => c.status === 'gap' && c.endpoints.length === 0)).toBe(true)
  })

  it('finds webhooks from an OpenAPI 3.1 doc-level webhooks object', () => {
    const caps = byId(mapToCti({ openapi: '3.1.0', paths: {}, webhooks: { orderFilled: {} } }))
    const webhooks = caps.get('webhooks')
    expect(webhooks?.status).toBe('found')
    expect(webhooks?.endpoints).toEqual(['spec webhook: orderFilled'])
  })

  it('handles swagger v2 securityDefinitions and version strings', () => {
    const v2 = {
      swagger: '2.0',
      securityDefinitions: { key: { type: 'apiKey', in: 'header', name: 'X-KEY' } },
      paths: {},
    }
    expect(specVersion(v2)).toBe('Swagger 2.0')
    expect(specVersion(exchangeSpec)).toBe('OpenAPI 3.0.1')
    expect(extractAuthSchemes(v2)).toEqual(['key (apiKey, header:X-KEY)'])
  })

  it('recognizes spec-shaped objects and rejects arbitrary JSON', () => {
    expect(isOpenApiDoc(exchangeSpec)).toBe(true)
    expect(isOpenApiDoc({ paths: {} })).toBe(true)
    expect(isOpenApiDoc({ hello: 'world' })).toBe(false)
    expect(isOpenApiDoc(null)).toBe(false)
    expect(isOpenApiDoc([1, 2, 3])).toBe(false)
  })
})
