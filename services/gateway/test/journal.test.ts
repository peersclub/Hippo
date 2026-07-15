import { Frame } from '@hippo/protocol'
import { describe, expect, it } from 'vitest'
import { createEmitter, InMemoryJournal } from '../src/plugins/sse.js'
import { createSession, testApp } from './helpers.js'

const silentLog = { error: () => {} }

describe('InMemoryJournal', () => {
  it('replays entries strictly after a seq, oldest first', () => {
    const journal = new InMemoryJournal()
    for (let seq = 1; seq <= 5; seq++) {
      journal.append({ seq, frame: { type: 'pulse', tag: `· ${seq}` } as never })
    }
    expect(journal.after(2).map((e) => e.seq)).toEqual([3, 4, 5])
    expect(journal.after(0)).toHaveLength(5)
    expect(journal.after(5)).toEqual([])
    expect(journal.lastSeq()).toBe(5)
  })

  it('evicts oldest entries beyond the ring capacity (500)', () => {
    const journal = new InMemoryJournal()
    for (let seq = 1; seq <= 505; seq++) {
      journal.append({ seq, frame: { type: 'pulse', tag: '·' } as never })
    }
    const all = journal.after(0)
    expect(all).toHaveLength(500)
    expect(all[0]?.seq).toBe(6)
    expect(journal.lastSeq()).toBe(505)
  })
})

describe('SSE resume (real socket)', () => {
  it('replays frames after Last-Event-ID before going live — gap-free', async () => {
    const { app, sessions, emit } = await testApp()
    const session = await createSession(app, sessions)

    // Five frames land while no stream is connected — journal only.
    for (let i = 1; i <= 5; i++) emit(session, { type: 'pulse', tag: `· frame ${i}` })

    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')

    // Reconnect claiming we last saw seq 2 (what EventSource sends).
    const ctrl = new AbortController()
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/stream?session=${session.id}`, {
      headers: { accept: 'text/event-stream', 'last-event-id': '2' },
      signal: ctrl.signal,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body stream')
    const decoder = new TextDecoder()
    let buffer = ''
    while ((buffer.match(/^data: /gm) ?? []).length < 3) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    ctrl.abort()

    const ids = [...buffer.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
    expect(ids).toEqual([3, 4, 5])

    const frames = [...buffer.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1] as string))
    expect(frames.map((f) => f.tag)).toEqual(['· frame 3', '· frame 4', '· frame 5'])
    for (const frame of frames) expect(Frame.safeParse(frame).success).toBe(true)

    await app.close()
  })

  it('delivers frames that arrive while disconnected on the next connect', async () => {
    const { app, sessions, emit } = await testApp()
    const session = await createSession(app, sessions)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const url = `http://127.0.0.1:${address.port}/v1/stream?session=${session.id}`

    // First connect: opening orders_snapshot (seq 1).
    const c1 = new AbortController()
    const r1 = await fetch(url, { signal: c1.signal })
    const reader1 = r1.body?.getReader()
    if (!reader1) throw new Error('no body')
    let buf1 = ''
    while (!/^id: 1$/m.test(buf1)) {
      const { value, done } = await reader1.read()
      if (done) break
      buf1 += new TextDecoder().decode(value, { stream: true })
    }
    expect(buf1).toContain('"orders_snapshot"')
    c1.abort()

    // Disconnected: a lifecycle change lands in the journal.
    emit(session, {
      type: 'lifecycle',
      ticketId: 't_gap',
      phase: 'filled',
      statusLine: 'FILLED',
    })

    // Reconnect from seq 1 → the missed lifecycle replays.
    const c2 = new AbortController()
    const r2 = await fetch(url, {
      headers: { 'last-event-id': '1' },
      signal: c2.signal,
    })
    const reader2 = r2.body?.getReader()
    if (!reader2) throw new Error('no body')
    let buf2 = ''
    while ((buf2.match(/^data: /gm) ?? []).length < 1) {
      const { value, done } = await reader2.read()
      if (done) break
      buf2 += new TextDecoder().decode(value, { stream: true })
    }
    c2.abort()
    expect(buf2).toContain('"t_gap"')
    expect(buf2).not.toContain('"orders_snapshot"')

    await app.close()
  })
})

describe('frame emitter validity', () => {
  const session = () => ({
    id: 's_test',
    seq: 0,
    journal: new InMemoryJournal(),
    live: null,
  })

  it('stamps envelope fields and every emitted frame passes Frame.safeParse', () => {
    const emit = createEmitter({ strict: true, log: silentLog })
    const s = session()
    const frame = emit(s as never, { type: 'pulse', tag: '· BTC −4.2%' })
    expect(frame).not.toBeNull()
    expect(Frame.safeParse(frame).success).toBe(true)
    expect(frame?.id).toBe('f_s_test_1')
    expect(s.journal.lastSeq()).toBe(1)
  })

  it('strict mode (tests) throws on a protocol-invalid frame', () => {
    const emit = createEmitter({ strict: true, log: silentLog })
    expect(() => emit(session() as never, { type: 'research_brief' })).toThrow(
      /protocol validation/,
    )
  })

  it('prod mode logs + drops invalid frames instead of throwing', () => {
    let logged = 0
    const emit = createEmitter({ strict: false, log: { error: () => logged++ } })
    const s = session()
    const frame = emit(s as never, { type: 'thinking', lines: [] })
    expect(frame).toBeNull()
    expect(logged).toBe(1)
    expect(s.journal.lastSeq()).toBe(0) // nothing invalid ever reaches the journal
  })
})
