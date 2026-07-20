/**
 * Library entry for `@hippo/seam` — the importable surface for other packages
 * (e.g. the CLI's conformance runner). Deliberately separate from `index.ts`,
 * which is the runnable server and must never execute on import.
 */

export type { AssetworksOptions, ConfirmSurface } from './assetworks-venue.js'
export { AssetworksVenueAdapter } from './assetworks-venue.js'
export { buildService } from './service.js'
export { SimVenueAdapter } from './sim-venue.js'
export type {
  LifecycleEvent,
  LifecyclePhase,
  OpenOrder,
  OrderSide,
  OrderType,
  Portfolio,
  PositionRow,
  PreparedTicket,
  PrepareRequest,
  VenueAdapter,
} from './types.js'
