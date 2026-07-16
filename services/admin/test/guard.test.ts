import { describe, expect, it } from 'vitest'
import { LoginThrottle, originAllowed } from '../src/guard.js'

describe('LoginThrottle', () => {
  it('locks after maxFailures within the window and reports retry-after', () => {
    const t = new LoginThrottle(60_000, 3)
    const keys = ['email:a@x', 'ip:1.2.3.4']
    const now = 1_000_000
    expect(t.retryAfterS(keys, now)).toBe(0)
    t.recordFailure(keys, now)
    t.recordFailure(keys, now + 1000)
    t.recordFailure(keys, now + 2000)
    const retry = t.retryAfterS(keys, now + 3000)
    expect(retry).toBeGreaterThan(0)
    expect(retry).toBeLessThanOrEqual(60)
  })

  it('failures age out of the window', () => {
    const t = new LoginThrottle(10_000, 2)
    const keys = ['email:b@x']
    t.recordFailure(keys, 0)
    t.recordFailure(keys, 1000)
    expect(t.retryAfterS(keys, 2000)).toBeGreaterThan(0)
    expect(t.retryAfterS(keys, 12_000)).toBe(0) // window passed
  })

  it('success clears the email key but a spraying IP stays locked', () => {
    const t = new LoginThrottle(60_000, 2)
    const now = 0
    t.recordFailure(['email:c@x', 'ip:9.9.9.9'], now)
    t.recordFailure(['email:c@x', 'ip:9.9.9.9'], now + 1)
    t.clear('email:c@x')
    expect(t.retryAfterS(['email:c@x'], now + 2)).toBe(0)
    expect(t.retryAfterS(['ip:9.9.9.9'], now + 2)).toBeGreaterThan(0)
  })
})

describe('originAllowed', () => {
  it('passes absent Origin, same-host Origin, and configured origin; rejects others', () => {
    expect(originAllowed(undefined, 'localhost:8794')).toBe(true)
    expect(originAllowed('http://localhost:8794', 'localhost:8794')).toBe(true)
    expect(originAllowed('http://evil.example', 'localhost:8794')).toBe(false)
    expect(originAllowed('not a url', 'localhost:8794')).toBe(false)
    expect(
      originAllowed('https://admin.hippo.dev', 'internal:8794', 'https://admin.hippo.dev'),
    ).toBe(true)
  })
})
