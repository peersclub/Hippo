import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Transport resilience. The stream + session are mocked (curl can't reach this
 * layer): a fake EventSource whose readyState/handlers the test drives, and a
 * fetch stub that returns chosen status codes. Module state (backoff ladder,
 * cfg, es) is per-test via vi.resetModules + a fresh dynamic import.
 */

type Resp = { ok: boolean; status: number; json?: () => Promise<unknown> }

let mockEventSources: MockEventSource[] = []

class MockEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  url: string
  readyState = MockEventSource.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    mockEventSources.push(this)
  }
  close() {
    this.readyState = MockEventSource.CLOSED
  }
  // test drivers
  open() {
    this.readyState = MockEventSource.OPEN
    this.onopen?.()
  }
  fail(state: number) {
    this.readyState = state
    this.onerror?.()
  }
}

const cfg = { gateway: 'https://gw.test', key: 'pk_x' }

const sessionOk = (id: string): Resp => ({
  ok: true,
  status: 200,
  json: async () => ({ sessionId: id }),
})

function stubFetch(handler: (url: string, init?: { body?: string }) => Resp) {
  const fn = vi.fn(async (url: string, init?: { body?: string }) => handler(url, init) as Response)
  vi.stubGlobal('fetch', fn)
  return fn
}

async function load() {
  vi.resetModules()
  const state = await import('../src/state.js')
  const transport = await import('../src/transport.js')
  return { ...transport, connection: state.connection, sessionId: state.sessionId }
}

beforeEach(() => {
  mockEventSources = []
  vi.stubGlobal('EventSource', MockEventSource)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('stream death → re-mint', () => {
  it('mints a FRESH session when the stream closes with readyState CLOSED', async () => {
    vi.useFakeTimers()
    let n = 0
    stubFetch((url) => {
      if (url.includes('/v1/session')) {
        n++
        return sessionOk(`s${n}`)
      }
      return { ok: true, status: 200 }
    })
    const { connect, connection } = await load()

    await connect(cfg)
    expect(mockEventSources).toHaveLength(1)
    mockEventSources[0]?.open()
    expect(connection.value).toBe('live')

    // The browser gave up its own reconnect (session gone) — readyState CLOSED.
    mockEventSources[0]?.fail(MockEventSource.CLOSED)
    expect(connection.value).toBe('offline')

    await vi.advanceTimersByTimeAsync(1000)
    // A brand-new session was minted and a new stream opened on it.
    expect(n).toBe(2)
    expect(mockEventSources).toHaveLength(2)
    expect(mockEventSources[1]?.url).toContain('session=s2')
  })

  it('lets EventSource recover on its own when readyState is CONNECTING', async () => {
    vi.useFakeTimers()
    let n = 0
    stubFetch((url) => {
      if (url.includes('/v1/session')) {
        n++
        return sessionOk(`s${n}`)
      }
      return { ok: true, status: 200 }
    })
    const { connect, connection } = await load()

    await connect(cfg)
    mockEventSources[0]?.open()
    mockEventSources[0]?.fail(MockEventSource.CONNECTING)
    expect(connection.value).toBe('offline')

    await vi.advanceTimersByTimeAsync(60_000)
    // No re-mint — the same session's stream is expected to recover itself.
    expect(n).toBe(1)
    expect(mockEventSources).toHaveLength(1)
  })
})

describe('send → 404 unknown session', () => {
  it('re-mints and replays the uplink once, carrying the fresh session id', async () => {
    let sessN = 0
    let turnN = 0
    const bodies: string[] = []
    const fn = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes('/v1/session')) {
        sessN++
        return sessionOk(`s${sessN}`) as Response
      }
      turnN++
      bodies.push(String(init?.body))
      // First turn 404s (session forgotten); the replay after re-mint succeeds.
      return { ok: turnN > 1, status: turnN === 1 ? 404 : 200 } as Response
    })
    vi.stubGlobal('fetch', fn)
    const { connect, send } = await load()

    await connect(cfg)
    mockEventSources[0]?.open()

    const ok = await send({ kind: 'user_text', text: 'hi' })
    expect(ok).toBe(true)
    expect(sessN).toBe(2) // initial + one re-mint
    expect(turnN).toBe(2) // original + one replay
    expect(bodies[0]).toContain('"sessionId":"s1"')
    expect(bodies[1]).toContain('"sessionId":"s2"')
  })

  it('reports failure without a second replay when the re-mint also fails', async () => {
    let turnN = 0
    const fn = vi.fn(async (url: string) => {
      if (url.includes('/v1/session')) return { ok: false, status: 500 } as Response
      turnN++
      return { ok: false, status: 404 } as Response
    })
    vi.stubGlobal('fetch', fn)
    vi.useFakeTimers()
    const { connect, send, connection } = await load()

    // Seed a live session first (session #1 succeeds), then flip fetch to fail.
    fn.mockImplementationOnce(async () => sessionOk('s1') as Response)
    await connect(cfg)
    mockEventSources[0]?.open()

    const ok = await send({ kind: 'user_text', text: 'hi' })
    expect(ok).toBe(false)
    expect(turnN).toBe(1) // only the original — no replay against a dead re-mint
    expect(connection.value).toBe('offline') // re-mint 5xx → transient/backoff
  })
})

describe('session-mint status codes', () => {
  it('401 is terminal — blocked, no retry, no error state', async () => {
    vi.useFakeTimers()
    const fn = stubFetch(() => ({ ok: false, status: 401 }))
    const { connect, connection } = await load()

    await connect(cfg)
    expect(connection.value).toBe('blocked')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(fn).toHaveBeenCalledTimes(1) // never retried
    expect(connection.value).toBe('blocked')
  })

  it('429 is a friendly capacity state with a long backoff', async () => {
    vi.useFakeTimers()
    let n = 0
    stubFetch(() => {
      n++
      return { ok: false, status: 429 }
    })
    const { connect, connection } = await load()

    await connect(cfg)
    expect(connection.value).toBe('capacity')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(n).toBe(1) // not on the tight ladder

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(n).toBe(2) // retried after the long capacity backoff
  })

  it('5xx retries on an exponential ladder (1s, 2s, 4s)', async () => {
    vi.useFakeTimers()
    let n = 0
    stubFetch(() => {
      n++
      return { ok: false, status: 503 }
    })
    const { connect, connection } = await load()

    await connect(cfg)
    expect(connection.value).toBe('offline')
    expect(n).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(n).toBe(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(n).toBe(3)
    await vi.advanceTimersByTimeAsync(4000)
    expect(n).toBe(4)
  })

  it('a network failure (fetch throws) also backs off', async () => {
    vi.useFakeTimers()
    let n = 0
    const fn = vi.fn(async () => {
      n++
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fn)
    const { connect, connection } = await load()

    await connect(cfg)
    expect(connection.value).toBe('offline')
    expect(n).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(n).toBe(2)
  })

  it('resets the backoff ladder once a stream goes genuinely live', async () => {
    vi.useFakeTimers()
    let sessN = 0
    let fail = true
    stubFetch((url) => {
      if (url.includes('/v1/session')) {
        sessN++
        return fail ? { ok: false, status: 503 } : sessionOk(`s${sessN}`)
      }
      return { ok: true, status: 200 }
    })
    const { connect, connection } = await load()

    await connect(cfg) // 503 → schedules 1s
    await vi.advanceTimersByTimeAsync(1000) // 503 → schedules 2s
    fail = false
    await vi.advanceTimersByTimeAsync(2000) // succeeds → stream opens
    mockEventSources[mockEventSources.length - 1]?.open()
    expect(connection.value).toBe('live')

    // Ladder reset: the next CLOSED drop retries at the 1s base again.
    fail = true
    mockEventSources[mockEventSources.length - 1]?.fail(MockEventSource.CLOSED)
    const before = sessN
    await vi.advanceTimersByTimeAsync(1000)
    expect(sessN).toBe(before + 1)
  })
})

describe('partner token mint (data-hippo-token-url)', () => {
  const tokenCfg = { ...cfg, tokenUrl: 'https://host.test/api/hippo-token' }
  const tokenOk: Resp = { ok: true, status: 200, json: async () => ({ token: 'jwt.abc.sig' }) }

  type Init = { body?: string; headers?: Record<string, string> }
  function stubFetchWithInit(handler: (url: string, init?: Init) => Resp) {
    const fn = vi.fn(async (url: string, init?: Init) => handler(url, init) as Response)
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('fetches a token and carries it as a Bearer header on the mint', async () => {
    const calls: Array<{ url: string; init?: Init }> = []
    stubFetchWithInit((url, init) => {
      calls.push({ url, init })
      if (url.includes('/api/hippo-token')) return tokenOk
      return sessionOk('s1')
    })
    const { connect, connection } = await load()

    await connect(tokenCfg)
    mockEventSources[0]?.open()
    expect(connection.value).toBe('live')

    expect(calls[0]?.url).toContain('/api/hippo-token')
    expect(calls[1]?.url).toContain('/v1/session')
    expect(calls[1]?.init?.headers?.authorization).toBe('Bearer jwt.abc.sig')
    // The bare key still rides along — the gateway may use it as a fallback
    // partner lookup when the token's iss is absent.
    expect(calls[1]?.init?.body).toContain('pk_x')
  })

  it('omits the token fetch and Authorization header without a tokenUrl', async () => {
    const calls: Array<{ url: string; init?: Init }> = []
    stubFetchWithInit((url, init) => {
      calls.push({ url, init })
      return sessionOk('s1')
    })
    const { connect } = await load()

    await connect(cfg)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/v1/session')
    expect(calls[0]?.init?.headers?.authorization).toBeUndefined()
  })

  it('token endpoint 401 is terminal — blocked, gateway never called', async () => {
    const urls: string[] = []
    stubFetchWithInit((url) => {
      urls.push(url)
      return { ok: false, status: 401 }
    })
    const { connect, connection } = await load()

    await connect(tokenCfg)
    expect(connection.value).toBe('blocked')
    expect(urls.every((u) => u.includes('/api/hippo-token'))).toBe(true)
  })

  it('token endpoint 5xx backs off and retries like any transient failure', async () => {
    vi.useFakeTimers()
    let tokenN = 0
    stubFetchWithInit((url) => {
      if (url.includes('/api/hippo-token')) {
        tokenN++
        return { ok: false, status: 503 }
      }
      return sessionOk('s1')
    })
    const { connect, connection } = await load()

    await connect(tokenCfg)
    expect(connection.value).toBe('offline')
    await vi.advanceTimersByTimeAsync(1000)
    expect(tokenN).toBe(2)
  })

  it('a malformed token payload is retryable, never a crash', async () => {
    vi.useFakeTimers()
    let tokenN = 0
    stubFetchWithInit((url) => {
      if (url.includes('/api/hippo-token')) {
        tokenN++
        return { ok: true, status: 200, json: async () => ({}) }
      }
      return sessionOk('s1')
    })
    const { connect, connection } = await load()

    await connect(tokenCfg)
    expect(connection.value).toBe('offline')
    await vi.advanceTimersByTimeAsync(1000)
    expect(tokenN).toBe(2)
  })

  it('re-mint after stream death fetches a FRESH token', async () => {
    vi.useFakeTimers()
    let tokenN = 0
    let sessN = 0
    stubFetchWithInit((url) => {
      if (url.includes('/api/hippo-token')) {
        tokenN++
        return tokenOk
      }
      sessN++
      return sessionOk(`s${sessN}`)
    })
    const { connect } = await load()

    await connect(tokenCfg)
    mockEventSources[0]?.open()
    mockEventSources[0]?.fail(MockEventSource.CLOSED)
    await vi.advanceTimersByTimeAsync(1000)

    expect(sessN).toBe(2)
    expect(tokenN).toBe(2) // one per mint — short-lived tokens are never reused
  })
})
