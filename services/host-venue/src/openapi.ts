/**
 * The venue's public API description — served at GET /openapi.json so the
 * `hippo scan` → CTI → codegen pipeline has real documentation to chew on
 * (the second-venue dogfood needs a venue that documents itself, like any
 * real integration target would).
 *
 * Honest to the wire: only the signed trade surface + capabilities are
 * documented. Deliberately ABSENT (they're real gaps the scan should find):
 * no quote/ticker endpoint (the venue prices internally; integrators bring
 * market data) and no webhooks (lifecycle is poll-reconciled) — the SSE
 * /stream is a UI feed, not an integration contract.
 */

const SIGNED = {
  description:
    'Signed request: x-api-key + x-timestamp (ISO 8601) + x-signature = hex(HMAC-SHA256(rawBodyJSON + timestamp, secret)). Signature is over the RAW body bytes.',
  security: [{ apiKey: [] }, { signature: [] }, { timestamp: [] }],
}

const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    clientOrderId: { type: 'string' },
    pairName: { type: 'string', example: 'BTC-USDT' },
    market: { type: 'string', enum: ['spot', 'perp'] },
    qty: { type: 'number' },
    filledQty: { type: 'number' },
    remainingQty: { type: 'number' },
    rate: { type: 'number' },
    status: {
      type: 'integer',
      description: '10 ACTIVE · 15 PARTIAL · 20 SETTLED · 30 CANCELED · 35 PARTIAL_CANCELED',
    },
    orderType: { type: 'integer', description: '0 buy · 1 sell' },
    tradeTypeLabel: { type: 'string', enum: ['market', 'limit'] },
  },
} as const

export const OPENAPI_DOC = {
  openapi: '3.0.3',
  info: {
    title: 'Assetworks Exchange API',
    version: '1.0.0',
    description:
      'Signed trading wire for the Assetworks demo venue: order placement, cancel, open orders, status, balances, positions, and a confirm-handoff surface. HMAC-signed requests; capabilities are served unsigned.',
  },
  components: {
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      timestamp: { type: 'apiKey', in: 'header', name: 'x-timestamp' },
      signature: {
        type: 'apiKey',
        in: 'header',
        name: 'x-signature',
        description: 'hex(HMAC-SHA256(rawBodyJSON + x-timestamp, apiSecret))',
      },
    },
    schemas: { Order: ORDER_SCHEMA },
  },
  paths: {
    '/api/v1/trade/orders': {
      post: {
        ...SIGNED,
        operationId: 'placeOrder',
        summary: 'Place order (spot or perp; market or limit)',
        tags: ['trading'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['pairName', 'orderType', 'tradeType', 'qty', 'rate'],
                properties: {
                  pairName: { type: 'string', example: 'BTC-USDT' },
                  orderType: { type: 'integer', description: '0 buy · 1 sell' },
                  tradeType: { type: 'integer', description: '10 limit · 20 market' },
                  qty: { type: 'number' },
                  rate: {
                    type: 'number',
                    description: 'limit price, or quote at placement for market',
                  },
                  clientOrderId: { type: 'string' },
                  market: { type: 'string', enum: ['spot', 'perp'], default: 'spot' },
                  direction: { type: 'string', enum: ['long', 'short'] },
                  leverage: { type: 'number' },
                  marginMode: { type: 'string', enum: ['isolated', 'cross'] },
                  reduceOnly: { type: 'boolean' },
                  stopLossPrice: {
                    type: 'number',
                    description:
                      'Attached stop-loss trigger — a venue-native conditional close created when the entry fills (OCO with takeProfitPrice)',
                  },
                  takeProfitPrice: {
                    type: 'number',
                    description:
                      'Attached take-profit — a resting reduce-only limit created when the entry fills (OCO with stopLossPrice)',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Order accepted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'boolean' },
                    data: { $ref: '#/components/schemas/Order' },
                  },
                },
              },
            },
          },
          '400': { description: 'Rejected (size, funds, leverage, maintenance)' },
          '401': { description: 'Bad signature / stale timestamp' },
        },
      },
    },
    '/api/v1/trade/orders/cancel': {
      post: {
        ...SIGNED,
        operationId: 'cancelOrder',
        summary: 'Cancel a working order by id',
        tags: ['trading'],
        responses: { '200': { description: '{ status } — false when not cancellable' } },
      },
    },
    '/api/v1/trade/orders/open': {
      post: {
        ...SIGNED,
        operationId: 'openOrders',
        summary: 'Open orders (ACTIVE + PARTIAL) for a pair',
        tags: ['trading'],
        responses: {
          '200': {
            description: 'Working orders',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } },
              },
            },
          },
        },
      },
    },
    '/api/v1/trade/orders/all': {
      post: {
        ...SIGNED,
        operationId: 'orderHistory',
        summary: 'Order history for a pair (all statuses)',
        tags: ['trading'],
        responses: { '200': { description: 'Orders, newest first' } },
      },
    },
    '/api/v1/trade/orders/status': {
      post: {
        ...SIGNED,
        operationId: 'orderStatus',
        summary: 'Terminal order status by id or clientOrderId',
        tags: ['trading'],
        responses: { '200': { description: '{ status, data: Order } incl. terminal states' } },
      },
    },
    '/api/v1/trade/balance': {
      post: {
        ...SIGNED,
        operationId: 'balances',
        summary: 'Wallet balances (total / reserved per currency)',
        tags: ['account'],
        responses: { '200': { description: 'Balance rows' } },
      },
    },
    '/api/v1/trade/positions': {
      post: {
        ...SIGNED,
        operationId: 'positions',
        summary: 'Open perp positions (entry, leverage, liquidation)',
        tags: ['account'],
        responses: { '200': { description: 'Position rows' } },
      },
    },
    '/api/v1/trade/handoff': {
      post: {
        ...SIGNED,
        operationId: 'createHandoff',
        summary: 'Create a confirm handoff (host renders the confirm modal, places on approval)',
        tags: ['trading'],
        responses: { '200': { description: '{ status, handoffId }' } },
      },
    },
    '/api/v1/trade/handoff/status': {
      post: {
        ...SIGNED,
        operationId: 'handoffStatus',
        summary: 'Handoff state: pending | approved | rejected | expired',
        tags: ['trading'],
        responses: { '200': { description: '{ state, orderId? }' } },
      },
    },
    '/v1/capabilities': {
      get: {
        operationId: 'capabilities',
        summary:
          'Venue capabilities + instruments/markets list (spot, futures_perp, leverage, size limits)',
        tags: ['discovery'],
        responses: {
          '200': {
            description: 'Derived live from venue config',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    venue: { type: 'string' },
                    instruments: { type: 'array', items: { type: 'string' } },
                    minOrderSize: { type: 'number' },
                    maxOrderSize: { type: 'number' },
                    capabilities: { type: 'object' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness',
        tags: ['discovery'],
        responses: { '200': { description: '{ ok }' } },
      },
    },
  },
} as const
