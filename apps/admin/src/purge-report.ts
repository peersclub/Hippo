/**
 * Display shaping for DELETE /v1/users/:pid/:uid/everywhere — the four-legged
 * cross-store erasure. Pure module (no JSX/router) so the node-env tests can
 * assert that a failed leg is never summarized as success.
 */

export type PurgeLeg =
  | { ok: true; detail: unknown }
  | { ok: false; error: string; status?: number }

export type PurgeResponse = {
  partnerId: string
  userId: string
  ok: boolean
  results: { persona: PurgeLeg; learnedFacts: PurgeLeg; userNote: PurgeLeg; gateway: PurgeLeg }
}

const STORE_LABEL: Record<keyof PurgeResponse['results'], string> = {
  persona: 'Persona (memory service)',
  learnedFacts: 'Learned facts (memory service)',
  userNote: 'User note (memory service)',
  gateway: 'Gateway stores (signals, uploads, alerts, identity)',
}

export type PurgeRow = { store: string; ok: boolean; note: string }

/** The gateway leg answers 200 with per-store markers INSIDE the body —
 * 'failed'/'unsupported' in deleted{} means data may remain even though the
 * HTTP leg succeeded. Surface those instead of trusting the status code.
 * 'retained' is deliberate (billing counts) and not a failure. */
function gatewaySubFailures(detail: unknown): string[] {
  const deleted = (detail as { deleted?: Record<string, unknown> } | null)?.deleted
  if (!deleted || typeof deleted !== 'object') return []
  return Object.entries(deleted)
    .filter(([, v]) => v === 'failed' || v === 'unsupported')
    .map(([k, v]) => `${k}: ${String(v)}`)
}

/** One honest row per store: what succeeded, and exactly how a leg failed. */
export function purgeRows(results: PurgeResponse['results']): PurgeRow[] {
  return (Object.keys(STORE_LABEL) as Array<keyof typeof STORE_LABEL>).map((k) => {
    const leg = results[k]
    if (leg.ok && k === 'gateway') {
      const sub = gatewaySubFailures(leg.detail)
      if (sub.length)
        return {
          store: STORE_LABEL[k],
          ok: false,
          note: `FAILED — ${sub.join(', ')}; data may remain`,
        }
    }
    return {
      store: STORE_LABEL[k],
      ok: leg.ok,
      note: leg.ok
        ? 'purged'
        : leg.error === 'unreachable'
          ? 'FAILED — service unreachable, data may remain'
          : `FAILED — upstream error${leg.status ? ` (${leg.status})` : ''}, data may remain`,
    }
  })
}
