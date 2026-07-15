/**
 * Draft adapter config — stage 3 of `hippo init` (Build Plan/05). The
 * declarative-first artifact: it maps each Canonical Trading Interface
 * operation to a discovered venue endpoint. Operations whose response shape
 * diverges from the CTI get `needsMappingCode`, marking where the stage-4
 * (model-driven) `mapping.ts` codegen must fill in — config where config
 * suffices, code only where shapes genuinely diverge. The generated adapter is
 * then graded by `hippo conform`.
 */
import type { CapabilityId } from '../scan/types.js'

export interface AdapterOperation {
  capability: CapabilityId
  label: string
  status: 'mapped' | 'gap'
  /** First discovered candidate, e.g. "POST /api/v3/order"; null for a gap. */
  endpoint: string | null
  /** Remaining discovered candidates the human/agent can choose instead. */
  alternates: string[]
  /** Mapped data-returning ops need a mapping.ts function; pure actions do not. */
  needsMappingCode: boolean
  /** Consequence copy for a gap; a short hint for a mapped op. */
  note: string
}

export interface AdapterConfig {
  venue: string
  /** Best-guess API base; flagged for confirmation, never invented silently. */
  baseUrl: string | null
  auth: {
    schemes: string[]
    /** Heuristic signing strategy, e.g. "hmac-signed request". */
    strategy: string
  }
  operations: AdapterOperation[]
  /** Capability ids with no discovered endpoint. */
  gaps: CapabilityId[]
  /** Mapped ops that still need a hand/agent-written mapping function. */
  needsMappingCode: CapabilityId[]
}
