import { describe, expect, it } from 'vitest'
import {
  cyclePosture,
  isMobileViewport,
  MOBILE_MAX,
  MOBILE_POSTURES,
  normalizePosture,
  openPosture,
  type Posture,
  postureSet,
  WEB_POSTURES,
} from '../src/posture.js'

describe('viewport detection', () => {
  it('treats <= MOBILE_MAX as mobile, wider as web', () => {
    expect(isMobileViewport(MOBILE_MAX)).toBe(true)
    expect(isMobileViewport(MOBILE_MAX - 1)).toBe(true)
    expect(isMobileViewport(MOBILE_MAX + 1)).toBe(false)
    expect(isMobileViewport(1440)).toBe(false)
  })

  it('picks the right posture set per viewport', () => {
    expect(postureSet(false)).toEqual(WEB_POSTURES)
    expect(postureSet(true)).toEqual(MOBILE_POSTURES)
  })
})

describe('openPosture', () => {
  it('lands on dock on web and sheet on mobile', () => {
    expect(openPosture(false)).toBe('dock')
    expect(openPosture(true)).toBe('sheet')
  })
})

describe('normalizePosture', () => {
  it('leaves pill alone on either viewport', () => {
    expect(normalizePosture('pill', false)).toBe('pill')
    expect(normalizePosture('pill', true)).toBe('pill')
  })

  it('keeps a posture that is already valid for the viewport', () => {
    expect(normalizePosture('overlay', false)).toBe('overlay')
    expect(normalizePosture('full', true)).toBe('full')
  })

  it('folds web postures onto the mobile set on a narrow viewport', () => {
    expect(normalizePosture('overlay', true)).toBe('sheet')
    expect(normalizePosture('dock', true)).toBe('full')
    expect(normalizePosture('max', true)).toBe('full')
  })

  it('folds mobile postures onto the web set on a wide viewport', () => {
    expect(normalizePosture('sheet', false)).toBe('overlay')
    expect(normalizePosture('full', false)).toBe('dock')
  })
})

describe('cyclePosture', () => {
  it('walks the full web cycle dock → overlay → max → dock', () => {
    let p: Posture = 'dock'
    p = cyclePosture(p, false)
    expect(p).toBe('overlay')
    p = cyclePosture(p, false)
    expect(p).toBe('max')
    p = cyclePosture(p, false)
    expect(p).toBe('dock')
  })

  it('walks the mobile cycle sheet → full → sheet', () => {
    let p: Posture = 'sheet'
    p = cyclePosture(p, true)
    expect(p).toBe('full')
    p = cyclePosture(p, true)
    expect(p).toBe('sheet')
  })

  it('re-enters the cycle from pill via the viewport default', () => {
    expect(cyclePosture('pill', false)).toBe('overlay') // openPosture(web)=dock → next=overlay
    expect(cyclePosture('pill', true)).toBe('full') // openPosture(mobile)=sheet → next=full
  })

  it('cycles from a cross-viewport posture by normalizing first', () => {
    // holding a web posture but now on mobile: normalize(overlay)=sheet → next=full
    expect(cyclePosture('overlay', true)).toBe('full')
  })
})
