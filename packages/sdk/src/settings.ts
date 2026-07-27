/**
 * Settings-sheet logic — pure, UI-free. The language row maps the CHROME
 * locale onto the server's content-language parameter (the settings uplink):
 * note `hi-Latn` ↔ `'hinglish'`. Option labels are written in their own
 * language and are deliberately NOT i18n keys — a language option must be
 * readable by the person who needs it.
 */
import type { LearnedFact } from './state.js'
import type { Locale } from './i18n.js'

export type SettingsLanguage = 'en' | 'hi' | 'hinglish' | 'ar'

export const LANGUAGE_OPTIONS: ReadonlyArray<{
  locale: Locale
  label: string
  uplink: SettingsLanguage
}> = [
  { locale: 'en', label: 'English', uplink: 'en' },
  { locale: 'hi', label: 'हिन्दी', uplink: 'hi' },
  { locale: 'hi-Latn', label: 'Hinglish', uplink: 'hinglish' },
  { locale: 'ar', label: 'عربي', uplink: 'ar' },
]

export function toSettingsLanguage(locale: Locale): SettingsLanguage {
  return LANGUAGE_OPTIONS.find((o) => o.locale === locale)?.uplink ?? 'en'
}

/**
 * Clear-memory confirm flow — same shape as feedbackTransition: invalid
 * events no-op, `done` is terminal, the uplink fires exactly once (this is
 * the settings promise: "clear everything Hippo remembers", baseline §6).
 */
export type ClearMemoryState = { phase: 'idle' } | { phase: 'confirming' } | { phase: 'done' }

export type ClearMemoryEvent = { type: 'request' } | { type: 'confirm' } | { type: 'cancel' }

export type ClearMemoryTransition = {
  state: ClearMemoryState
  uplink?: { clearMemory: true }
}

export function clearMemoryTransition(
  state: ClearMemoryState,
  event: ClearMemoryEvent,
): ClearMemoryTransition {
  switch (state.phase) {
    case 'idle':
      if (event.type === 'request') return { state: { phase: 'confirming' } }
      return { state }
    case 'confirming':
      if (event.type === 'confirm')
        return { state: { phase: 'done' }, uplink: { clearMemory: true } }
      if (event.type === 'cancel') return { state: { phase: 'idle' } }
      return { state }
    default:
      // done is terminal — clearing is one-shot per sheet visit.
      return { state }
  }
}

/**
 * "What Hippo remembers about you" — pure view logic, mirroring the rest of
 * this module (UI-free, so the panel just draws the result).
 *
 * The section is entitlement-gated: it shows ONLY when the plan grants
 * `memoryLab` AND the server has actually pushed facts. Absent entitlement,
 * a non-`true` value, or an empty set all keep it invisible — the SDK never
 * invents the feature, it only reflects what the server sent.
 */
export function showLearnedMemory(
  entitlements: Record<string, unknown>,
  facts: readonly LearnedFact[],
): boolean {
  return entitlements.memoryLab === true && facts.length > 0
}

export type GroupedLearnedFacts = {
  /** Durable facts (scope `user`) — the "Remembered" group. */
  remembered: LearnedFact[]
  /** This-conversation facts (scope `session`) — the "This chat" group. */
  session: LearnedFact[]
}

/** Split learned facts into the two scope groups the sheet renders, order
 * preserved within each group (server decides the ordering). */
export function groupLearnedFacts(facts: readonly LearnedFact[]): GroupedLearnedFacts {
  const remembered: LearnedFact[] = []
  const session: LearnedFact[] = []
  for (const f of facts) (f.scope === 'session' ? session : remembered).push(f)
  return { remembered, session }
}

/**
 * The one-tap clear uplink. Distinct from `clearMemory` (which wipes the
 * structured persona): this only wipes the auto-learned facts. The server
 * re-emits an empty `learned_memory` frame after clearing, which empties the
 * section — the SDK never optimistically hand-clears the set.
 */
export function clearLearnedMemoryUplink(): { kind: 'settings'; clearLearnedMemory: true } {
  return { kind: 'settings', clearLearnedMemory: true }
}
