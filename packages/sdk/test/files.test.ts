import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Files-view state handling: the defensive list parser, the compact relative
 * time, and loadFiles' loading→list/error/empty transitions. The gateway
 * origin comes from a mocked transport; global fetch is stubbed per test.
 */

// gatewayUrl() reads module state set by connect(); mock it to a fixed origin.
vi.mock('../src/transport.js', () => ({ gatewayUrl: () => 'http://gw.test' }))

import { filesView, loadFiles, parseFiles, relativeTime } from '../src/files.js'
import { sessionId } from '../src/state.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('parseFiles — defensive against a malformed payload', () => {
  it('keeps only well-formed rows', () => {
    const rows = parseFiles({
      files: [
        {
          fileId: 'u_1',
          name: 'a.csv',
          sizeDisplay: '1 KB',
          mime: 'text/csv',
          kind: 'csv',
          status: 'analyzed',
          summary: 'ok',
          createdAt: 5,
        },
        { fileId: 'u_2' }, // missing fields — dropped
        {
          fileId: 'u_3',
          name: 'b',
          sizeDisplay: '1',
          mime: 'x',
          kind: 'zip',
          status: 'analyzed',
          createdAt: 1,
        }, // bad kind
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.fileId).toBe('u_1')
    expect(rows[0]?.summary).toBe('ok')
  })

  it('returns [] for non-object / missing files', () => {
    expect(parseFiles(null)).toEqual([])
    expect(parseFiles({})).toEqual([])
    expect(parseFiles({ files: 'nope' })).toEqual([])
  })
})

describe('relativeTime', () => {
  const now = 1_000_000_000_000
  it('buckets into compact forms', () => {
    expect(relativeTime(now, now)).toBe('just now')
    expect(relativeTime(now - 30_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d')
  })
  it('falls back to an ISO date beyond a week', () => {
    const old = Date.UTC(2020, 0, 15)
    expect(relativeTime(old, old + 40 * 86_400_000)).toBe('2020-01-15')
  })
})

describe('loadFiles — view state machine', () => {
  beforeEach(() => {
    sessionId.value = 's_1'
    filesView.value = { phase: 'loading' }
  })

  it('resolves to a list on a 200', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        files: [
          {
            fileId: 'u_1',
            name: 'a.csv',
            sizeDisplay: '1 KB',
            mime: 'text/csv',
            kind: 'csv',
            status: 'analyzed',
            createdAt: 1,
          },
        ],
      }),
    })) as unknown as typeof fetch
    await loadFiles()
    expect(filesView.value.phase).toBe('list')
    if (filesView.value.phase === 'list') expect(filesView.value.files).toHaveLength(1)
  })

  it('resolves to an empty list (honest empty state) on a 200 with no files', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ files: [] }),
    })) as unknown as typeof fetch
    await loadFiles()
    expect(filesView.value).toEqual({ phase: 'list', files: [] })
  })

  it('errors on a non-ok response', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch
    await loadFiles()
    expect(filesView.value.phase).toBe('error')
  })

  it('errors on a network throw', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network')
    }) as unknown as typeof fetch
    await loadFiles()
    expect(filesView.value.phase).toBe('error')
  })

  it('errors when there is no live session', async () => {
    sessionId.value = null
    await loadFiles()
    expect(filesView.value.phase).toBe('error')
  })
})
