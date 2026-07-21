import cors from '@fastify/cors'
import { Frame, Uplink } from '@hippo/protocol'
import Fastify from 'fastify'
import type { FrameDraft, ScriptStep } from './golden.js'
import {
  lifecycleScriptFor,
  marketPulse,
  openingScript,
  ordersSnapshot,
  replyScriptFor,
  stoppedBrief,
} from './golden.js'

const PORT = Number(process.env.PORT ?? 8787)

type Session = {
  id: string
  send: ((frame: unknown) => void) | null
  seq: number
  /** Pending scripted timers — stream_stop cancels them mid-play. */
  timers: Set<ReturnType<typeof setTimeout>>
}

const sessions = new Map<string, Session>()

/** Stamp envelope fields onto a draft and validate against the protocol. */
function stamp(session: Session, draft: FrameDraft) {
  const frame = { v: 1, id: `f_${session.id}_${++session.seq}`, ts: Date.now(), ...draft }
  const parsed = Frame.safeParse(frame)
  if (!parsed.success) {
    // A drifted fixture is a bug in the mock, never something we put on the wire.
    throw new Error(`golden fixture failed protocol validation: ${parsed.error.message}`)
  }
  return parsed.data
}

function play(session: Session, script: ScriptStep[]) {
  let delay = 0
  for (const step of script) {
    delay += step.afterMs
    const timer = setTimeout(() => {
      session.timers.delete(timer)
      // Frames may be thunks (live market templating) — resolve at fire time.
      const draft = typeof step.frame === 'function' ? step.frame() : step.frame
      Promise.resolve(draft)
        .then((frame) => session.send?.(stamp(session, frame)))
        .catch((err) => app.log.error({ err }, 'script step failed'))
    }, delay)
    session.timers.add(timer)
  }
}

const app = Fastify({ logger: { level: 'info' } })
await app.register(cors, { origin: true })

app.post('/v1/session', async () => {
  const id = `s_${Math.random().toString(36).slice(2, 10)}`
  sessions.set(id, { id, send: null, seq: 0, timers: new Set() })
  return {
    sessionId: id,
    config: {
      venueName: 'Assetworks',
      locales: ['en', 'hi', 'hinglish'],
      suggestedQueries: [
        "What's driving SOL volume?",
        'My positions & P&L',
        'ETH funding rate',
        'Explain liquidations',
      ],
    },
  }
})

app.get('/v1/stream', async (req, reply) => {
  const { session: sessionId } = req.query as { session?: string }
  const session = sessionId ? sessions.get(sessionId) : undefined
  if (!session) {
    reply.code(404)
    return { error: 'unknown session' }
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  })
  reply.raw.write(': connected\n\n')

  session.send = (frame) => {
    reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`)
  }

  const heartbeat = setInterval(() => reply.raw.write(': hb\n\n'), 15_000)
  req.raw.on('close', () => {
    clearInterval(heartbeat)
    session.send = null
  })

  // Opening state: orders strip, then the golden conversation plays in.
  session.send(stamp(session, ordersSnapshot))
  play(session, openingScript)
  // Ambient pulse a while later — demos the minimized-pill glow.
  play(session, [{ afterMs: 20_000, frame: marketPulse }])

  // Keep the connection open (Fastify: returning nothing after hijacking raw).
  return reply
})

app.post('/v1/turns', async (req, reply) => {
  const parsed = Uplink.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400)
    return { error: 'invalid uplink', issues: parsed.error.issues }
  }
  const up = parsed.data
  const session = sessions.get(up.sessionId)
  if (!session) {
    reply.code(404)
    return { error: 'unknown session' }
  }

  switch (up.kind) {
    case 'user_text':
    case 'chip_tap':
      play(session, [
        { afterMs: 0, frame: { type: 'user_echo', text: up.text } },
        ...replyScriptFor(up.text),
      ])
      break
    case 'ticket_action':
      if (up.action === 'confirm_handoff') play(session, lifecycleScriptFor(up.ticketId))
      break
    case 'stream_stop':
      // Cancel the pending scripted steps and land the authoritative brief
      // early — the stopped answer is server-decided, honest and truncated.
      // Nothing pending → silent no-op, mirroring the real gateway.
      if (session.timers.size > 0) {
        for (const timer of session.timers) clearTimeout(timer)
        session.timers.clear()
        session.send?.(stamp(session, stoppedBrief))
      }
      break
    case 'feedback':
    case 'consent':
    case 'settings':
      app.log.info({ uplink: up.kind }, 'recorded')
      break
  }
  return { ok: true }
})

app.get('/health', async () => ({ ok: true, service: 'mock-gateway' }))

await app.listen({ port: PORT, host: '::' })
console.log(`mock-gateway on :${PORT} — golden conversation ready`)
