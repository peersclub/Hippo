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
      post: {
        summary: 'Place a new order',
        operationId: 'createOrder',
        tags: ['Trade'],
        responses: {
          '200': { description: 'Order accepted' },
          '400': { description: 'Invalid order parameters (symbol, quantity, or price)' },
          '401': { description: 'Invalid API key or request signature' },
          '429': { description: 'Rate limit exceeded' },
        },
      },
      get: {
        summary: 'Query order status',
        operationId: 'getOrder',
        tags: ['Trade'],
        responses: {
          '200': { description: 'Order status' },
          '404': { description: 'Unknown order' },
        },
      },
      delete: { summary: 'Cancel an active order', operationId: 'cancelOrder', tags: ['Trade'] },
    },
    '/api/v3/openOrders': {
      get: { summary: 'Current open orders', tags: ['Trade'] },
    },
    '/api/v3/account': {
      get: {
        summary: 'Account information including balances',
        tags: ['Account'],
        responses: {
          '200': { description: 'Account information' },
          '401': { description: 'Invalid signature' },
        },
      },
    },
  },
}

/**
 * Futures-flavored variant: the full spot surface plus a derivatives segment
 * with leverage (documented 125x cap), margin-type (isolated/crossed enum),
 * position, and funding-rate endpoints. Expected: spot AND futures_perp
 * enabled, with maxLeverage/marginModes extracted from the documented params.
 */
export const futuresSpec: OpenApiDoc = {
  openapi: '3.0.1',
  info: { title: 'Acme Exchange Futures API', version: '2.1.0' },
  components: exchangeSpec.components,
  paths: {
    ...exchangeSpec.paths,
    '/futures/v1/order': {
      post: {
        summary: 'Place a new futures order',
        operationId: 'createFuturesOrder',
        tags: ['Futures Trade'],
      },
    },
    '/futures/v1/leverage': {
      post: {
        summary: 'Change initial leverage for a symbol',
        operationId: 'setLeverage',
        tags: ['Futures Account'],
        parameters: [
          { name: 'symbol', in: 'query', required: true, schema: { type: 'string' } },
          {
            name: 'leverage',
            in: 'query',
            required: true,
            schema: { type: 'integer', minimum: 1, maximum: 125 },
          },
        ],
      },
    },
    '/futures/v1/marginType': {
      post: {
        summary: 'Change margin type between isolated and crossed',
        operationId: 'setMarginType',
        tags: ['Futures Account'],
        parameters: [
          { name: 'symbol', in: 'query', required: true, schema: { type: 'string' } },
          {
            name: 'marginType',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['ISOLATED', 'CROSSED'] },
          },
        ],
      },
    },
    '/futures/v1/positionRisk': {
      get: { summary: 'Position information', tags: ['Futures Account'] },
    },
    '/futures/v1/fundingRate': {
      get: { summary: 'Funding rate history', tags: ['Futures Market Data'] },
    },
  },
}

/**
 * Options-flavored variant: an options-only venue (chain, strikes/expiries,
 * call/put order placement). Expected: ONLY options enabled — the placement
 * endpoint is options-scoped, so it must not read as spot.
 */
export const optionsSpec: OpenApiDoc = {
  openapi: '3.0.1',
  info: { title: 'Acme Exchange Options API', version: '0.9.0' },
  paths: {
    '/api/v1/options/instruments': {
      get: {
        summary: 'List option instruments with strike and expiry',
        tags: ['Options Market Data'],
      },
    },
    '/api/v1/options/chain': {
      get: {
        summary: 'Option chain for an underlying and expiration',
        tags: ['Options Market Data'],
      },
    },
    '/api/v1/options/order': {
      post: {
        summary: 'Place an option order (call or put)',
        operationId: 'createOptionOrder',
        tags: ['Options Trade'],
      },
    },
  },
}
