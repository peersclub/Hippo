// biome-ignore-all assist/source/organizeImports: csp.js must evaluate before the schema modules — alphabetizing re-breaks the CSP fix
// csp.js first: its module-scope side effect must run before any
// schema-constructing module evaluates (zod's JIT probe fires there).
export * from './csp.js'
export * from './admin.js'
export * from './frames.js'
export * from './orders.js'
export * from './uplinks.js'

import { Frame, FrameEnvelope, type UnknownFrame } from './frames.js'

export type ParsedFrame =
  | { ok: true; frame: Frame }
  | { ok: false; unknown: UnknownFrame }
  | { ok: false; unknown: null }

/**
 * Parse a wire frame. Three outcomes:
 *  - known type, valid        → { ok: true, frame }
 *  - unknown/future type      → { ok: false, unknown } (render FallbackCard)
 *  - not a frame at all       → { ok: false, unknown: null } (drop silently)
 *
 * The SDK must never throw on any byte sequence the wire delivers.
 */
export function parseFrame(input: unknown): ParsedFrame {
  const data = typeof input === 'string' ? safeJson(input) : input
  if (data === undefined) return { ok: false, unknown: null }
  const known = Frame.safeParse(data)
  if (known.success) return { ok: true, frame: known.data }
  const envelope = FrameEnvelope.safeParse(data)
  if (envelope.success) return { ok: false, unknown: envelope.data }
  return { ok: false, unknown: null }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}
