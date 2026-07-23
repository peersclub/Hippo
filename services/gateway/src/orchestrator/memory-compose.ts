/**
 * Memory composition — assemble the four memory scopes into ONE labelled,
 * authority-ordered context block the answer engine receives alongside (never
 * instead of) its system prompt.
 *
 * Order = authority: PLATFORM (super-admin, binding) → VENUE (host) → USER →
 * SESSION. More-specific layers add detail; they do not countermand a higher
 * one. Crucially, ALL of this is *context*, not instruction override: the
 * intelligence service keeps its product guardrail (the "no advice" law)
 * first and authoritative, so no memory layer — not even PLATFORM — can turn
 * Hippo into an advice engine. Memory personalises; it never rewrites the law.
 *
 * Pure and self-contained so the ordering/labelling is unit-testable without a
 * network or a model.
 */

export type ScopeDocs = {
  /** super-admin platform-wide doc */
  global?: string
  /** host/partner doc */
  host?: string
  /** per-user freeform note */
  user?: string
  /** per-session note */
  session?: string
  /** structured persona summary line (level/assets), already server-formatted */
  personaLine?: string
  /** auto-learned USER-scope facts, already formatted into lines */
  userFacts?: string
  /** auto-learned SESSION-scope facts, already formatted into lines */
  sessionFacts?: string
}

/** Machine tags for the interpretation card + inspector (which layers applied). */
export type MemoryScope = 'platform' | 'venue' | 'user' | 'session'

export type ComposedMemory = {
  /** The block to hand the answer engine; empty string when no layer has content. */
  text: string
  /** Which scopes actually contributed (for the card + inspector). */
  scopes: MemoryScope[]
}

const LABELS: Record<MemoryScope, string> = {
  platform: 'PLATFORM RULES (binding)',
  venue: 'VENUE CONTEXT',
  user: 'USER PROFILE',
  session: 'THIS SESSION',
}

function clean(s: string | undefined): string {
  return (s ?? '').trim()
}

/**
 * Compose the labelled block. Layers with no content are omitted (both from
 * the text and the `scopes` list). The USER layer folds in the structured
 * persona line if present.
 */
export function composeMemory(docs: ScopeDocs): ComposedMemory {
  const sections: Array<{ scope: MemoryScope; body: string }> = []

  const platform = clean(docs.global)
  if (platform) sections.push({ scope: 'platform', body: platform })

  const venue = clean(docs.host)
  if (venue) sections.push({ scope: 'venue', body: venue })

  // USER = freeform note + structured persona summary + auto-learned facts.
  const userParts = [clean(docs.user), clean(docs.personaLine), clean(docs.userFacts)].filter(
    Boolean,
  )
  if (userParts.length) sections.push({ scope: 'user', body: userParts.join('\n') })

  // SESSION = freeform note + auto-learned session facts.
  const sessionParts = [clean(docs.session), clean(docs.sessionFacts)].filter(Boolean)
  if (sessionParts.length) sections.push({ scope: 'session', body: sessionParts.join('\n') })

  if (!sections.length) return { text: '', scopes: [] }

  const text = sections.map((s) => `[${LABELS[s.scope]}]\n${s.body}`).join('\n\n')
  return { text, scopes: sections.map((s) => s.scope) }
}
