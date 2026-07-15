/**
 * In-process driver — adapts a seam VenueAdapter to the conformance suite's
 * ConformanceDriver, calling the adapter's methods directly (no HTTP hop). This
 * is how `hippo conform` dogfoods the real sim and KoinBX adapters against the
 * same battery a generated adapter will face. The suite's contract types and
 * the seam's VenueAdapter types are structurally aligned by design, so the
 * mapping is a thin pass-through.
 */
import type { VenueAdapter } from '@hippo/seam'
import type {
  ConformanceDriver,
  LifecycleEventShape,
  PortfolioShape,
  PreparedTicketShape,
  PrepareInput,
} from './contract.js'

export function inProcessDriver(adapter: VenueAdapter, target: string): ConformanceDriver {
  return {
    target,
    prepare: (input: PrepareInput): Promise<PreparedTicketShape> => adapter.prepare(input),
    confirm: (ticketId: string): Promise<void> => adapter.confirm(ticketId),
    cancel: (ticketId: string): Promise<boolean> => adapter.cancel(ticketId),
    portfolio: (partnerId: string, userId: string): Promise<PortfolioShape> =>
      adapter.portfolio(partnerId, userId),
    onLifecycle: (handler: (event: LifecycleEventShape) => void): void => adapter.onEvent(handler),
  }
}
