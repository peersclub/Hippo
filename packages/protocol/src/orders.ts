import { z } from 'zod'

/**
 * Canonical order model — the venue-neutral shape every trade type flows
 * through, discriminated by `capability`. This is the keystone of the
 * capability-driven trading framework (vault: Capability-Driven Trading
 * Framework): the intelligence router extracts one of these from a natural
 * language command; the seam prepares it on the host via the per-capability
 * adapter binding; the SDK renders it.
 *
 * Adding a trade type = adding a member here + its capability module. The
 * engine never changes. Sizes/prices are pre-formatted-safe STRINGS (the seam
 * never guesses or recomputes money); leverage is a numeric multiplier.
 */

export const CAPABILITIES = ['spot', 'futures_perp', 'options'] as const
export type Capability = (typeof CAPABILITIES)[number]

const orderTypeEnum = z.enum(['market', 'limit'])

/** Spot — buy/sell a quantity of an instrument. Framework module #1. */
export const SpotOrder = z.object({
  capability: z.literal('spot'),
  instrument: z.string(), // "BTC/USDT"
  side: z.enum(['buy', 'sell']),
  size: z.string(), // base quantity, explicit — never inferred
  orderType: orderTypeEnum,
  limitPrice: z.string().optional(),
})

/** Perpetual futures — a leveraged long/short position with a margin mode. */
export const FuturesPerpOrder = z.object({
  capability: z.literal('futures_perp'),
  instrument: z.string(), // "BTC/USDT" (perp)
  direction: z.enum(['long', 'short']),
  action: z.enum(['open', 'close']).default('open'),
  leverage: z.number().positive(), // multiplier, e.g. 13 (13x); validated ≤ venue max
  marginMode: z.enum(['isolated', 'cross']),
  size: z.string(), // contracts / base qty, explicit
  reduceOnly: z.boolean().default(false),
  orderType: orderTypeEnum,
  limitPrice: z.string().optional(),
})

/** Options — buy/sell a call/put at a strike and expiry. */
export const OptionsOrder = z.object({
  capability: z.literal('options'),
  underlying: z.string(), // "BTC"
  optionType: z.enum(['call', 'put']),
  side: z.enum(['buy', 'sell']),
  strike: z.string(),
  expiry: z.string(), // ISO date, e.g. "2026-08-29"
  size: z.string(), // contracts
  orderType: orderTypeEnum,
  limitPrice: z.string().optional(),
})

export const CanonicalOrder = z.discriminatedUnion('capability', [
  SpotOrder,
  FuturesPerpOrder,
  OptionsOrder,
])
export type CanonicalOrder = z.infer<typeof CanonicalOrder>
export type SpotOrder = z.infer<typeof SpotOrder>
export type FuturesPerpOrder = z.infer<typeof FuturesPerpOrder>
export type OptionsOrder = z.infer<typeof OptionsOrder>

/**
 * Per-venue capability parameters — what the host actually supports, produced
 * by capability discovery (`hippo scan`/`init`, extending scan/cti.ts). A
 * capability is ENABLED for a venue iff its params object is present. The
 * per-feature values here are what the capability module validates against
 * (accuracy: "leverage 13x exceeds this venue's 10x cap" is a venue-true check).
 */
export const SpotParams = z.object({})
export const FuturesPerpParams = z.object({
  maxLeverage: z.number().positive(),
  marginModes: z.array(z.enum(['isolated', 'cross'])).min(1),
})
export const OptionsParams = z.object({
  // expiries/strikes are instrument-listed; kept minimal until an options venue lands
  settlement: z.enum(['cash', 'physical']).optional(),
})

export const VenueCapabilities = z.object({
  spot: SpotParams.optional(),
  futures_perp: FuturesPerpParams.optional(),
  options: OptionsParams.optional(),
})
export type VenueCapabilities = z.infer<typeof VenueCapabilities>

/** Which capabilities a venue has enabled (params present). */
export function enabledCapabilities(caps: VenueCapabilities): Capability[] {
  return CAPABILITIES.filter((c) => caps[c] !== undefined)
}
