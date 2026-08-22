/**
 * Pure derivations for the user detail page. Kept free of JSX/router imports
 * so the node-env vitest suite can exercise them directly.
 */
import { ApiError } from './api.js'

/** What the panel knows about a user's memory: a real persona ('ok'), the
 * memory service positively answering "nothing held" ('none'), or the memory
 * service down/erroring ('unavailable' — state UNKNOWN, never emptiness). */
export type PersonaStatus = 'ok' | 'none' | 'unavailable'

/** Classify the memory-row fallback fetch failure: a 404 is the service
 * answering "nothing held"; anything else (502, network) means the memory
 * state is unknown and must never render as the empty state. */
export function personaStatusFromError(err: unknown): Exclude<PersonaStatus, 'ok'> {
  return err instanceof ApiError && err.status === 404 ? 'none' : 'unavailable'
}

/** Effective userKeys for identity-signed-in sessions are `id:<usernameLower>`;
 * venue-authenticated keys may equal the username itself. */
export function identityMatchesUserKey(usernameLower: string, userKey: string): boolean {
  return userKey === `id:${usernameLower}` || userKey.toLowerCase() === usernameLower
}
