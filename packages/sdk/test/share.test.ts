import { describe, expect, it } from 'vitest'
import { SHARE_LINK_BASE, shareLink, shareSlug } from '../src/share.js'

describe('share slug', () => {
  it('is deterministic for the same frame id', () => {
    expect(shareSlug('frame-abc-123')).toBe(shareSlug('frame-abc-123'))
  })

  it('is always 4 lowercase base36 chars', () => {
    for (const id of ['a', 'frame-1', 'a-very-long-frame-identifier-0000', '☃']) {
      expect(shareSlug(id)).toMatch(/^[0-9a-z]{4}$/)
    }
  })

  it('differs across different frame ids', () => {
    expect(shareSlug('frame-1')).not.toBe(shareSlug('frame-2'))
  })

  it('builds the placeholder short link', () => {
    const link = shareLink('frame-1')
    expect(link.startsWith(SHARE_LINK_BASE)).toBe(true)
    expect(link).toBe(`hippo.app/s/${shareSlug('frame-1')}`)
  })
})
