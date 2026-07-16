/**
 * Composer logic — pure, UI-free (the composer renders it).
 */

/** Mirrors the protocol's user_text max (uplinks.ts) — the schema enforces
 * it server-side; surfacing it here means the trader is never surprised. */
export const MAX_USER_TEXT = 2000
/** The counter stays invisible until the trader approaches the limit. */
export const COUNTER_AT = 1800
/** Autosize cap — roughly four lines of composer text. */
export const MAX_COMPOSER_HEIGHT_PX = 96

/** Quiet character counter: null (hidden) until COUNTER_AT. */
export function counterLabel(length: number): string | null {
  if (length < COUNTER_AT) return null
  return `${length} / ${MAX_USER_TEXT}`
}

/** Enter sends; Shift+Enter inserts a newline; anything else is typing. */
export function enterAction(key: string, shiftKey: boolean): 'send' | 'newline' | null {
  if (key !== 'Enter') return null
  return shiftKey ? 'newline' : 'send'
}
