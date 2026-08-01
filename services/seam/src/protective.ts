/**
 * Protective-exit (attached stop-loss / take-profit) validation + ticket rows,
 * shared by the venue adapters. The seam is the compliance-critical surface:
 * a nonsense protection level must be rejected HERE with an honest message —
 * never silently dropped, never "fixed" by guessing.
 *
 * Direction semantics: a LONG exposure (perp long open, spot buy) protects
 * with stop < entry < tp; a SHORT (perp short open) with tp < entry < stop.
 */

export type ProtectiveExits = {
  stopLoss?: number
  takeProfit?: number
}

export type ProtectiveInput = {
  stopLossPrice?: string
  takeProfitPrice?: string
}

/**
 * Parse + sanity-check the plan's protective exits against the entry price.
 * Returns undefined when neither field is present. Throws a human message on
 * nonsense — mirrored wording with the host venue's own gate.
 */
export function validateProtectiveExits(
  input: ProtectiveInput,
  entry: number,
  isLong: boolean,
): ProtectiveExits | undefined {
  const slRaw = input.stopLossPrice
  const tpRaw = input.takeProfitPrice
  if (slRaw === undefined && tpRaw === undefined) return undefined
  let stopLoss: number | undefined
  let takeProfit: number | undefined
  if (slRaw !== undefined) {
    stopLoss = Number(slRaw)
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) throw new Error('invalid stop-loss price')
  }
  if (tpRaw !== undefined) {
    takeProfit = Number(tpRaw)
    if (!Number.isFinite(takeProfit) || takeProfit <= 0)
      throw new Error('invalid take-profit price')
  }
  if (isLong) {
    if (stopLoss !== undefined && stopLoss >= entry)
      throw new Error(
        `stop-loss (${slRaw}) must be below the entry price (${entry}) for a long — it would trigger immediately`,
      )
    if (takeProfit !== undefined && takeProfit <= entry)
      throw new Error(
        `take-profit (${tpRaw}) must be above the entry price (${entry}) for a long — it would fill immediately`,
      )
  } else {
    if (stopLoss !== undefined && stopLoss <= entry)
      throw new Error(
        `stop-loss (${slRaw}) must be above the entry price (${entry}) for a short — it would trigger immediately`,
      )
    if (takeProfit !== undefined && takeProfit >= entry)
      throw new Error(
        `take-profit (${tpRaw}) must be below the entry price (${entry}) for a short — it would fill immediately`,
      )
  }
  return { stopLoss, takeProfit }
}

/** Server-authored display rows for the ticket — the SDK renders verbatim. */
export function protectiveRows(
  exits: ProtectiveExits | undefined,
  formatPrice: (n: number) => string,
): Array<{ label: string; value: string }> {
  if (!exits) return []
  return [
    ...(exits.stopLoss !== undefined
      ? [{ label: 'Stop loss', value: formatPrice(exits.stopLoss) }]
      : []),
    ...(exits.takeProfit !== undefined
      ? [{ label: 'Take profit', value: formatPrice(exits.takeProfit) }]
      : []),
  ]
}
