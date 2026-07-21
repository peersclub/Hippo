/**
 * Posture matrix — a client presentation concern, NOT protocol.
 *
 * The SDK only ever draws what the server sends; where the panel sits on the
 * page is decided here, from a `posture` signal (see state.ts) and the current
 * viewport. Pure functions so transitions are unit-testable without a DOM.
 *
 *   Web (wide):    pill · dock · overlay · max
 *   Mobile (narrow): pill · sheet · full
 *
 * `pill` is the minimized launcher (the panel renders null; the loader pill
 * shows) and is shared by both viewports.
 */
export type Posture = 'pill' | 'dock' | 'overlay' | 'max' | 'sheet' | 'full'

/** Below this width the mobile posture set applies. */
export const MOBILE_MAX = 640

/** Expanded (non-pill) postures, in cycle order, per viewport. */
export const WEB_POSTURES: Posture[] = ['dock', 'overlay', 'max']
export const MOBILE_POSTURES: Posture[] = ['sheet', 'full']

export function isMobileViewport(width?: number): boolean {
  const w = width ?? (typeof window !== 'undefined' ? window.innerWidth : MOBILE_MAX + 1)
  return w <= MOBILE_MAX
}

/** The expanded posture set valid for this viewport. */
export function postureSet(mobile: boolean): Posture[] {
  return mobile ? MOBILE_POSTURES : WEB_POSTURES
}

/**
 * Map any posture onto the nearest one valid for this viewport. `pill` is
 * always valid; a web posture seen on mobile (or vice-versa) folds onto its
 * counterpart so a server/host default still renders sensibly everywhere.
 */
export function normalizePosture(p: Posture, mobile: boolean): Posture {
  if (p === 'pill') return 'pill'
  const set = postureSet(mobile)
  if (set.includes(p)) return p
  if (mobile) return p === 'overlay' ? 'sheet' : 'full'
  return p === 'sheet' ? 'overlay' : 'dock'
}

/** The posture a fresh "open" lands on for this viewport. */
export function openPosture(mobile: boolean): Posture {
  return postureSet(mobile)[0] ?? 'dock'
}

/**
 * Advance the expand control through the viewport's posture cycle. `pill`
 * (minimized) is handled by the minimize control, never the cycle, so it is
 * first normalized to a concrete expanded posture.
 */
export function cyclePosture(current: Posture, mobile: boolean): Posture {
  const set = postureSet(mobile)
  // `cur` is normalized into `set`, so its index exists and the cycle wraps.
  const cur = normalizePosture(current === 'pill' ? openPosture(mobile) : current, mobile)
  const i = set.indexOf(cur)
  const next = set[(Math.max(i, 0) + 1) % set.length]
  return next ?? cur
}

export type Point = { x: number; y: number }
export type Size = { w: number; h: number }

/** Min on-screen margin so the dragged panel can never be lost past an edge. */
export const DRAG_MARGIN = 8

/**
 * Clamp a floating panel's top-left so it stays fully within the viewport
 * (with a small margin). Pure — the testable core of the drag: given a drop
 * point, the panel size and the viewport, return the on-screen position.
 * When the panel is larger than the viewport (tiny window), pin to the
 * top-left rather than pushing content off the far edge.
 */
export function clampToViewport(pos: Point, size: Size, viewport: Size): Point {
  const maxX = viewport.w - size.w - DRAG_MARGIN
  const maxY = viewport.h - size.h - DRAG_MARGIN
  return {
    x: maxX < DRAG_MARGIN ? DRAG_MARGIN : Math.min(Math.max(pos.x, DRAG_MARGIN), maxX),
    y: maxY < DRAG_MARGIN ? DRAG_MARGIN : Math.min(Math.max(pos.y, DRAG_MARGIN), maxY),
  }
}
