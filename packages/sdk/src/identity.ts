/**
 * In-panel identity logic — pure, UI-free (the identity card renders it).
 *
 * Demo-grade username + 4-digit PIN (protocol `identity_claim` /` identity`):
 * the SDK validates LOCALLY against the same regexes the uplink schema
 * enforces (so an invalid claim never even leaves the panel), builds the
 * uplinks, and maps every server status to a chrome message key. The server
 * stays authoritative — hashing, uniqueness and rate limits all live there.
 *
 * The PIN is handled like a password: it exists only in component state and
 * the uplink body — never logged, never persisted, never echoed to the DOM
 * unmasked.
 */
import type { MessageKey } from './i18n.js'

/** Mirrors IdentityClaimUplink's schema (protocol/uplinks.ts) exactly. */
export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/
export const PIN_RE = /^\d{4}$/
export const PIN_LENGTH = 4

export type IdentityMode = 'create' | 'signin'
export type IdentityStatus =
  | 'ok'
  | 'taken'
  | 'wrong_pin'
  | 'invalid'
  | 'rate_limited'
  | 'signed_out'

/** Local pre-flight — true only when both fields would pass the wire schema. */
export function validateClaim(username: string, pin: string): boolean {
  return USERNAME_RE.test(username) && PIN_RE.test(pin)
}

export function identityClaimUplink(
  mode: IdentityMode,
  username: string,
  pin: string,
): { kind: 'identity_claim'; mode: IdentityMode; username: string; pin: string } {
  return { kind: 'identity_claim', mode, username, pin }
}

/** Sign-out carries no credentials — the gateway reverts the session to its
 * anonymous host-minted identity and answers with a `signed_out` frame. */
export function signOutUplink(): { kind: 'identity_claim'; mode: 'signout' } {
  return { kind: 'identity_claim', mode: 'signout' }
}

/**
 * Chrome message per server status. `ok` has no error line (the card flips to
 * its signed-in state instead); every non-ok status maps to a countdown-free,
 * plain-words line. A server-authored `note` on the frame wins over these.
 */
export function statusMessageKey(status: IdentityStatus | undefined | null): MessageKey | null {
  switch (status) {
    case 'taken':
      return 'id_taken'
    case 'wrong_pin':
      return 'id_wrong_pin'
    case 'invalid':
      return 'id_invalid'
    case 'rate_limited':
      return 'id_rate_limited'
    case 'signed_out':
      return 'id_signed_out'
    default:
      return null
  }
}
