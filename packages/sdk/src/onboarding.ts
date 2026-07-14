/**
 * Onboarding logic — pure, storage-injected, UI-free (the overlay lives in
 * overlays.tsx). Baseline §5: invited, never imposed. "Not now" genuinely
 * means not now — nothing is persisted, and consent is asked at the door
 * every time until given.
 */
import { signal } from '@preact/signals'

export const ONBOARDING_STEPS = 4

/** Real queries — shared by the hero typewriter and the empty-thread hero. */
export const HERO_QUERIES = [
  'why is BTC down today?',
  "what's driving SOL volume?",
  'explain funding rates',
]

export type OnboardingDeps = {
  /** Reads persisted completion (localStorage in prod, a fake in tests). */
  isDone: () => boolean
  /** Persists completion — called only by "Agree & start". */
  markDone: () => void
}

export function createOnboardingStore(deps: OnboardingDeps) {
  const active = signal(false)
  const step = signal(0)
  return {
    active,
    step,
    /** On panel open: offer the flow unless completion was persisted. */
    offerIfNeeded(): boolean {
      if (deps.isDone()) return false
      step.value = 0
      active.value = true
      return true
    },
    next() {
      step.value = Math.min(step.value + 1, ONBOARDING_STEPS - 1)
    },
    /** "Not now" — closes the flow, persists nothing. Next open offers again. */
    dismiss() {
      active.value = false
      step.value = 0
    },
    /** "Agree & start" — persists completion; the flow never auto-shows again. */
    complete() {
      deps.markDone()
      active.value = false
      step.value = 0
    },
    /** Settings → "Replay the intro" (see replayOnboarding in panel.tsx). */
    replay() {
      step.value = 0
      active.value = true
    },
  }
}

export type OnboardingStore = ReturnType<typeof createOnboardingStore>

/**
 * Data-consent rows, config-driven. Whether row 3 (Layer 2) needs an active
 * checkbox vs. disclosed-in-terms is a per-jurisdiction counsel question —
 * switching is a one-word change to `control` here; the overlay renders
 * whichever control the row declares.
 */
export type ConsentControl = 'static' | 'toggle' | 'checkbox'

export type ConsentRow = {
  id: 'venue_data' | 'memory' | 'l2'
  icon: string
  title: string
  body: string
  control: ConsentControl
  defaultOn?: boolean
}

export function consentRows(venue: string): ConsentRow[] {
  return [
    {
      id: 'venue_data',
      icon: '🔒',
      title: `Your account & orders stay with ${venue}`,
      body: 'Balances, orders and personal data never leave your exchange.',
      control: 'static',
    },
    {
      id: 'memory',
      icon: '◎',
      title: 'Personal memory',
      body: 'Hippo can remember your preferences and past questions. Off means every conversation starts fresh.',
      control: 'toggle',
      defaultOn: true,
    },
    {
      id: 'l2',
      icon: '◇',
      title: 'Anonymized conversations improve Hippo',
      body: 'Stripped of anything identifying, conversations help Hippo answer better for everyone — disclosed plainly here and in the terms.',
      // Per-jurisdiction lever: flip to 'checkbox' where counsel requires active consent.
      control: 'static',
    },
  ]
}
