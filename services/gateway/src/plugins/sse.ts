/**
 * SSE channel + frame journal.
 *
 * Journal: per-session append-only log of emitted frames, seq-numbered from 1.
 * The in-memory ring buffer (last 500 frames) ships here; in regional pods a
 * Redis Streams implementation (`session:{id}:frames`, XADD/XRANGE) replaces
 * it behind the same `Journal` interface — see Build Plan/10 BE Architecture
 * §1 "Frame journal".
 *
 * The SSE route writes `id: <seq>` with every frame so EventSource resumes
 * with Last-Event-ID; on (re)connect we replay everything after that seq
 * BEFORE going live — the gap-free lifecycle guarantee ("status changes made
 * elsewhere still arrive in the thread").
 */
import { Frame } from '@hippo/protocol'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Session } from './auth.js'

export type JournalEntry = { seq: number; frame: Frame }

export interface Journal {
  append(entry: JournalEntry): void
  /** Entries with seq strictly greater than `seq`, oldest first. */
  after(seq: number): JournalEntry[]
  lastSeq(): number
}

/** Ring capacity: enough for any realistic reconnect gap; a client further
 * behind than 500 frames re-syncs from the opening orders_snapshot anyway. */
const RING_CAPACITY = 500

export class InMemoryJournal implements Journal {
  private entries: JournalEntry[] = []

  append(entry: JournalEntry): void {
    this.entries.push(entry)
    if (this.entries.length > RING_CAPACITY) this.entries.shift()
  }

  after(seq: number): JournalEntry[] {
    return this.entries.filter((e) => e.seq > seq)
  }

  lastSeq(): number {
    const last = this.entries[this.entries.length - 1]
    return last ? last.seq : 0
  }
}

/** Server-side frame draft: envelope fields (v, id, ts) are stamped at emit. */
export type FrameDraft = { type: string } & Record<string, unknown>

type EmitterLog = { error: (obj: object, msg: string) => void }

export type EmitFrame = (session: Session, draft: FrameDraft) => Frame | null

/**
 * The single choke point every frame passes through: stamp envelope, validate
 * against @hippo/protocol, append to the journal, push to the live SSE (if
 * connected). A frame that fails validation never goes on the wire —
 * strict mode (tests) throws so drift is caught immediately; prod logs + drops
 * so one bad frame can't take the session down.
 */
export function createEmitter(opts: { strict: boolean; log: EmitterLog }): EmitFrame {
  return (session, draft) => {
    const seq = session.seq + 1
    const candidate = { v: 1, id: `f_${session.id}_${seq}`, ts: Date.now(), ...draft }
    const parsed = Frame.safeParse(candidate)
    if (!parsed.success) {
      if (opts.strict) throw new Error(`frame failed protocol validation: ${parsed.error.message}`)
      opts.log.error({ type: draft.type, issues: parsed.error.issues }, 'dropped invalid frame')
      return null
    }
    session.seq = seq
    const entry: JournalEntry = { seq, frame: parsed.data }
    session.journal.append(entry)
    session.live?.(entry)
    return parsed.data
  }
}

const HEARTBEAT_MS = 15_000

/**
 * Hijack the reply into an SSE stream: replay the journal gap, then go live.
 * Multiple frames that arrived while the client was disconnected are all in
 * the journal and replay in order before any new frame is delivered.
 */
export function streamSession(session: Session, req: FastifyRequest, reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  })
  reply.raw.write(': connected\n\n')

  const writeEntry = (entry: JournalEntry) => {
    try {
      reply.raw.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry.frame)}\n\n`)
    } catch {
      // Socket raced shut mid-write; the close handler detaches us.
    }
  }

  // EventSource sends Last-Event-ID automatically on reconnect. Replay
  // everything after it BEFORE attaching live — no gap, no reordering.
  const lastIdHeader = req.headers['last-event-id']
  const lastId = typeof lastIdHeader === 'string' ? Number.parseInt(lastIdHeader, 10) : Number.NaN
  for (const entry of session.journal.after(Number.isFinite(lastId) ? lastId : 0)) {
    writeEntry(entry)
  }
  session.live = writeEntry

  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(': hb\n\n')
    } catch {
      // Ignore — close handler cleans up.
    }
  }, HEARTBEAT_MS)

  req.raw.on('close', () => {
    clearInterval(heartbeat)
    // Only detach if a newer connection hasn't already replaced us.
    if (session.live === writeEntry) session.live = null
  })

  return reply
}
