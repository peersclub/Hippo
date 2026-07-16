/**
 * Share-card logic — pure and testable. Baseline §6: sharing produces a
 * live, co-branded card, not a screenshot. There is no share backend yet;
 * the overlay renders entirely from the brief's frame data, and the short
 * link is a deterministic placeholder derived from the frame id so the
 * same brief always previews the same slug.
 */

export const SHARE_LINK_BASE = 'hippo.app/s/'

/** How long "Copy link" reads COPIED ✓ before flipping back. */
export const COPIED_FLASH_MS = 1500

/**
 * Deterministic fake slug from a frame id — FNV-1a 32-bit folded to base36,
 * always 4 lowercase alphanumeric chars. Replaced by a server-issued slug
 * once the share backend exists.
 */
export function shareSlug(frameId: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < frameId.length; i++) {
    h ^= frameId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(4, '0').slice(-4)
}

/** Placeholder short link shown on the share card, e.g. "hippo.app/s/k3x9". */
export function shareLink(frameId: string): string {
  return `${SHARE_LINK_BASE}${shareSlug(frameId)}`
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
