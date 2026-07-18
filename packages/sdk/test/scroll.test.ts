import { describe, expect, it } from 'vitest'
import { isNearBottom, NEAR_BOTTOM_PX } from '../src/scroll.js'

describe('isNearBottom', () => {
  it('true when resting exactly at the bottom', () => {
    expect(isNearBottom(500, 300, 800)).toBe(true)
  })
  it('true within the slop', () => {
    expect(isNearBottom(500 - NEAR_BOTTOM_PX, 300, 800)).toBe(true)
  })
  it('false just past the slop', () => {
    expect(isNearBottom(500 - NEAR_BOTTOM_PX - 1, 300, 800)).toBe(false)
  })
  it('true when content fits without scrolling', () => {
    expect(isNearBottom(0, 300, 200)).toBe(true)
  })
  it('honours a custom slop', () => {
    expect(isNearBottom(400, 300, 800, 100)).toBe(true)
    expect(isNearBottom(399, 300, 800, 100)).toBe(false)
  })
})
