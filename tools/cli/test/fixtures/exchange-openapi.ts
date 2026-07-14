import type { OpenApiDoc } from '../../src/scan/cti.js'

/**
 * Realistic exchange-shaped OpenAPI v3 fixture (Binance/KoinBX-style spot API).
 * Deliberately has NO positions and NO webhooks — those are the expected gaps.
 */
export const exchangeSpec: OpenApiDoc = {
  openapi: '3.0.1',
  info: { title: 'Acme Exchange Spot API', version: '1.4.0' },
  components: {
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'X-ACME-APIKEY' },
      hmacSignature: { type: 'apiKey', in: 'query', name: 'signature' },
    },
  },
  paths: {
    '/api/v3/ticker/price': {
      get: { summary: 'Symbol price ticker', tags: ['Market Data'] },
    },
    '/api/v3/depth': {
      get: { summary: 'Order book depth', tags: ['Market Data'] },
    },
    '/api/v3/exchangeInfo': {
      get: { summary: 'Exchange trading rules and symbol information', tags: ['Market Data'] },
    },
    '/api/v3/order': {
      post: { summary: 'Place a new order', operationId: 'createOrder', tags: ['Trade'] },
      get: { summary: 'Query order status', operationId: 'getOrder', tags: ['Trade'] },
      delete: { summary: 'Cancel an active order', operationId: 'cancelOrder', tags: ['Trade'] },
    },
    '/api/v3/openOrders': {
      get: { summary: 'Current open orders', tags: ['Trade'] },
    },
    '/api/v3/account': {
      get: { summary: 'Account information including balances', tags: ['Account'] },
    },
  },
}
