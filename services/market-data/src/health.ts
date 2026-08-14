/**
 * /health payload. Lives outside index.ts because index.ts listens on import —
 * the payload must stay unit-testable without opening a socket.
 */

// Build provenance: stamped by the Docker build (Railway build args); an
// unstamped build reports "unknown", never a guessed value.
const GIT_SHA = process.env.GIT_SHA || 'unknown'
const BUILT_AT = process.env.BUILT_AT || 'unknown'

export function healthPayload(fixtures: boolean) {
  return {
    ok: true,
    service: 'market-data',
    mode: fixtures ? 'fixtures' : 'live',
    sha: GIT_SHA,
    builtAt: BUILT_AT,
  }
}
