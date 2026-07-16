/**
 * Settings-sheet logic — pure, UI-free. The language row maps the CHROME
 * locale onto the server's content-language parameter (the settings uplink):
 * note `hi-Latn` ↔ `'hinglish'`. Option labels are written in their own
 * language and are deliberately NOT i18n keys — a language option must be
 * readable by the person who needs it.
 */
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
