/**
 * Share-card logic. Baseline §6: sharing produces a live, co-branded card,
 * not a screenshot. The overlay renders from the brief's frame data; the
 * short link comes from the gateway's share service (POST /v1/shares →
 * GET /s/:id), which re-grounds the card on the live market at open time.
 *
 * THE LINK IS NEVER FABRICATED CLIENT-SIDE. The card once printed a
 * client-invented `hippo.app/s/<slug>` that resolved nowhere; today the ONLY
 * address that can render or be copied is the one the server minted and
 * answered with — createShare returns the server's URL verbatim or nothing.
 */
import { sessionId } from './state.js'
import { gatewayUrl } from './transport.js'

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

/** A server-minted share link: the id and the URL that actually resolves. */
export type ShareLink = { id: string; url: string }

/** The card shows the address without its scheme (the mono look); the
 * clipboard always gets the server's URL verbatim — only display calls this. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '')
}

/**
 * Ask the gateway to mint a share for a brief this session received. Returns
 * the server's link VERBATIM, or null (no session, network/HTTP failure,
 * malformed answer) — on null the overlay simply draws no address, exactly
 * the pre-share-service behavior. The SDK never assembles a URL itself.
 */
export async function createShare(frameId: string): Promise<ShareLink | null> {
  const gateway = gatewayUrl()
  const sid = sessionId.value
  if (!gateway || !sid) return null
  try {
    const res = await fetch(`${gateway}/v1/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, frameId }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { id?: unknown; url?: unknown }
    if (typeof data.id !== 'string' || data.id.length === 0) return null
    if (typeof data.url !== 'string' || !/^https?:\/\//.test(data.url)) return null
    return { id: data.id, url: data.url }
  } catch {
    return null
  }
}

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
