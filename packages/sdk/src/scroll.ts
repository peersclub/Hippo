/**
 * Thread scroll policy — pure. The thread follows new content ONLY when the
 * trader is already reading the newest message; scrolled-up history is never
 * yanked (a jump pill offers the way back instead).
 */

/** Within this many pixels of the bottom counts as "reading the latest". */
export const NEAR_BOTTOM_PX = 48

export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  slop: number = NEAR_BOTTOM_PX,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= slop
}
