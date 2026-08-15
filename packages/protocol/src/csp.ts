import { z } from 'zod'

/**
 * Zod 4 feature-detects JIT compilation with a `new Function("")` probe the
 * first time a schema is CONSTRUCTED — which for this package is at module
 * import, before any consumer code runs. Zod catches the throw and falls
 * back, but on a host page with a strict CSP (script-src without
 * unsafe-eval) the attempt still lands in the host's violation report, and
 * the SDK's host-safety contract is a CLEAN report.
 *
 * So: browser environments go jitless at module scope, before the first
 * schema definition evaluates (frames.ts imports this file first). Node
 * services (gateway/seam/admin) see no window and keep the JIT fast path.
 */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  z.config({ jitless: true })
}

/** Explicit opt-in for non-window JS environments that still enforce a CSP
 * (worker-based embedders). Browser callers never need this — the module
 * side effect above already ran. */
export function enableCspSafeMode(): void {
  z.config({ jitless: true })
}
