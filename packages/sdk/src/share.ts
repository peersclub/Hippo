/**
 * Share-card logic — pure and testable. Baseline §6: sharing produces a
 * live, co-branded card, not a screenshot. There is no share backend yet, so
 * the overlay renders entirely from the brief's frame data.
 *
 * NO SHORT LINK IS DRAWN. The card used to print a client-fabricated
 * `hippo.app/s/<slug>` and copy it to the clipboard — a URL that looks live
 * and resolves nowhere. The link comes back when a share service issues a
 * real slug on the frame; until then the card shows no address at all.
 */

/** How long the copy button reads "Copied" before flipping back. */
export const COPIED_FLASH_MS = 1500

/**
 * What the share card draws, straight off the frame — no invention, no
 * truncation:
 *  - `live` IS the server's `live` flag (same gate as the in-thread brief
 *    card). A stale brief must never export wearing a LIVE badge.
 *  - EVERY paragraph travels. The card used to render `paragraphs[0]` only,
 *    so a caveat or qualifier the server put in paragraph 2 vanished from the
 *    most distributable surface — meaning-changing truncation of financial
 *    commentary. The overlay scrolls a long brief rather than cutting it.
 */
export function shareCardView(frame: { live?: boolean; headline: string; paragraphs: string[] }): {
  live: boolean
  headline: string
  paragraphs: string[]
} {
  return {
    live: frame.live === true,
    headline: frame.headline,
    paragraphs: frame.paragraphs,
  }
}

/** The advice line travels with every copied brief — same non-negotiable
 * rule as the share card (baseline §6): distribution never crosses it. */
export const COPY_DISCLAIMER = 'MARKET INFORMATION · NOT INVESTMENT ADVICE'

/** Plain-text rendering of a brief for the clipboard. Structural typing so
 * this module keeps zero runtime imports. */
export function briefClipboardText(frame: {
  headline: string
  paragraphs: string[]
  stats: Array<{ k: string; v: string }>
  liveBar?: { asOf: string }
}): string {
  const lines = [frame.headline, '', ...frame.paragraphs]
  if (frame.stats.length > 0) {
    lines.push('', frame.stats.map((s) => `${s.k} ${s.v}`).join(' · '))
  }
  if (frame.liveBar?.asOf) lines.push('', frame.liveBar.asOf)
  lines.push('', COPY_DISCLAIMER)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}
