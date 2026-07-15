/**
 * CTI conformance suite — shared shapes.
 *
 * The behavioural counterpart to `scan/cti.ts`: scan detects the eight
 * Canonical Trading Interface capabilities *statically in a spec*; the
 * conformance suite *executes* the contract against a live adapter (via a
 * driver) and certifies it. Build Plan/05 sequences this before the codegen
 * generator — "the verifier must exist before the generator" — so a generated
 * adapter can be graded against the same battery the hand-built KoinBX adapter
 * passes.
 *
 * These types are the suite's OWN specification of the contract, deliberately
 * not imported from `@hippo/seam`: a conformance suite that borrowed the
 * implementation's types would only prove the code type-checks against itself.
 */

export type CheckId =
  | 'prepare-market'
  | 'prepare-limit'
  | 'ticket-display-strings'
  | 'reject-bad-size'
  | 'confirm-lifecycle'
  | 'cancel-preconfirm'
  | 'cancel-postconfirm'
  | 'portfolio-shape'

export type CheckStatus = 'pass' | 'fail' | 'skip'

export interface CheckResult {
  id: CheckId
  label: string
  status: CheckStatus
  /** One line: what was observed (pass) or what broke the contract (fail/skip). */
  detail: string
  /** Plain-words impact when this check fails — mirrors scan/cti consequence copy. */
  consequence: string
}

export interface Verdict {
  level: 'Conformant' | 'Partial' | 'Non-conformant'
  passed: number
  failed: number
  skipped: number
  total: number
}

export interface ConformanceReport {
  /** What was exercised, e.g. "sim venue (in-process)" or a seam URL. */
  target: string
  ranAt: string
  checks: CheckResult[]
  verdict: Verdict
}
