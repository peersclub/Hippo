/**
 * POST /v1/uplink/file — the file upload → analysis pipeline.
 *
 * Contract (pinned with the SDK track):
 *  - JSON body { sessionId, name, mime, dataBase64 }, authenticated exactly
 *    like POST /v1/turns: possession of a live sessionId (400 malformed,
 *    404 unknown session — the SDK's re-mint path).
 *  - Limits: CSV ≤ 512KB decoded, PNG/JPEG/WebP ≤ 3MB decoded. Over-limit or
 *    unsupported type is NOT a hard 4xx: the route answers 200 with a simple
 *    JSON ack and pushes an upload_status phase:'failed' frame — the SDK
 *    treats frames as the source of truth.
 *  - Success: 202 { fileId } immediately, then asynchronously over the
 *    session SSE: upload_status 'received' → 'analyzing' → 'analyzed' + a
 *    research_brief (or advice_decline — the no-advice guardrail applies to
 *    file answers too), or upload_status 'failed' + reason.
 *  - Durability split (the price_tick precedent): 'received'/'analyzing' are
 *    TRANSIENT progress — live socket only, never journaled — while the
 *    terminal 'analyzed'/'failed' frames are journaled, so a resume/reload
 *    replays exactly one chip per file in its final state.
 *  - Every ACCEPTED upload is recorded in the uploaded_files store (keyed by
 *    the session's effective userKey — identity-aware, like memory) and
 *    listed by GET /v1/uplink/files?session=… for the SDK's "Files" view.
 *
 * File content is UNTRUSTED DATA end to end: CSV bytes are parsed server-side
 * into a bounded digest (never shipped raw into a prompt) and the intelligence
 * service places file content strictly in the user-content position beneath
 * its no-advice system prompt.
 */
import { randomUUID } from 'node:crypto'
import type { UploadedFile, UploadedFileStore } from '@hippo/stores'
import { UPLOADED_FILES_LIST_CAP } from '@hippo/stores'
import type { FastifyInstance } from 'fastify'
import { userKey } from '../orchestrator/index.js'
import type { RespondResult } from '../orchestrator/intelligence.js'
import { asOfDisplay } from '../orchestrator/market.js'
import type { Session, SessionStore } from '../plugins/auth.js'
import { type EmitFrame, emitTransient } from '../plugins/sse.js'
import type { FileAnalysisClient, FileAnalysisRequest } from './analysis.js'
import { buildCsvDigest } from './csv.js'

export const CSV_MAX_BYTES = 512 * 1024
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024

/** Library summaries stay excerpts — the full brief lives in the thread. */
export const SUMMARY_MAX_CHARS = 400

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

type Log = {
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
}

export type FileUploadDeps = {
  sessions: SessionStore
  emit: EmitFrame
  analysis: FileAnalysisClient
  /** Durable upload records (migration 016) — the "Files" library. All writes
   * are best-effort: a store outage must never break the upload pipeline. */
  files: UploadedFileStore
  log: Log
  /** The gateway's shared per-IP limiter (uploads fan out to the LLM). */
  rateLimit?: import('../plugins/rate-limit.js').RateLimitHandler
}

type UploadBody = { sessionId: string; name: string; mime: string; dataBase64: string }

function parseBody(raw: unknown): UploadBody | null {
  if (typeof raw !== 'object' || raw === null) return null
  const b = raw as Record<string, unknown>
  if (
    typeof b.sessionId !== 'string' ||
    b.sessionId.length === 0 ||
    typeof b.name !== 'string' ||
    b.name.length === 0 ||
    b.name.length > 256 ||
    typeof b.mime !== 'string' ||
    b.mime.length === 0 ||
    b.mime.length > 128 ||
    typeof b.dataBase64 !== 'string' ||
    b.dataBase64.length === 0
  ) {
    return null
  }
  return {
    sessionId: b.sessionId,
    name: b.name,
    mime: b.mime,
    dataBase64: b.dataBase64,
  }
}

/** Display filename: control chars stripped, length-capped. Server-sanitized
 * because it round-trips into frames the SDK renders verbatim. */
function displayName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate sanitization
  const clean = name.replaceAll(/[\u0000-\u001f\u007f]/g, '').trim()
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean || 'file'
}

export function sizeDisplay(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const BASE64_RE = /^[A-Za-z0-9+/\s]+={0,2}\s*$/

function classify(name: string, mime: string): 'csv' | 'image' | null {
  const m = mime.toLowerCase()
  if (m === 'text/csv' || /\.csv$/i.test(name)) return 'csv'
  if (IMAGE_MIMES.has(m)) return 'image'
  return null
}

/** Short plain-text library summary of an analysis answer (headline + prose,
 * excerpt-capped) — what the "Files" view shows without re-opening the brief. */
export function summaryOf(res: RespondResult): string {
  const text = (
    res.kind === 'decline' ? res.message : [res.headline, ...res.paragraphs].join(' ')
  ).trim()
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}…` : text
}

export function registerFileUploadRoute(app: FastifyInstance, deps: FileUploadDeps): void {
  const { sessions, emit, analysis, files, log } = deps
  // Fastify's default 1MB bodyLimit would 413 a legitimate 3MB image before
  // the handler runs. 8MB comfortably covers the base64 form of every
  // in-limit file (3MB → ~4.2MB) AND the over-limit range we soft-fail with
  // a frame; only grossly oversized bodies still get the transport-level 413.
  const routeOpts = {
    bodyLimit: 8 * 1024 * 1024,
    ...(deps.rateLimit ? { preHandler: deps.rateLimit } : {}),
  }

  /** Progress phases ride the transient (journal-bypassing) path — like
   * price_tick — so a resume never replays a stale "analyzing". The terminal
   * phases go through the journaled emitter: the file chip's final state must
   * survive reload/resume. */
  function uploadStatus(
    session: Session,
    fileId: string,
    name: string,
    size: string,
    phase: 'received' | 'analyzing' | 'analyzed' | 'failed',
    reason?: string,
    kind?: 'csv' | 'image',
  ): void {
    const terminal = phase === 'analyzed' || phase === 'failed'
    const deliver = terminal ? emit : emitTransient
    deliver(session, {
      type: 'upload_status',
      fileId,
      name,
      sizeDisplay: size,
      phase,
      ...(reason ? { reason } : {}),
      ...(kind ? { kind } : {}),
    })
  }

  /** The analysis result → thread frame. Briefs ride the same research_brief
   * shape as every other answer; a decline (the guardrail tripping on file
   * content) rides advice_decline — file answers get no special surface. */
  function emitAnalysis(session: Session, res: RespondResult): void {
    if (res.kind === 'decline') {
      emit(session, {
        type: 'advice_decline',
        message: res.message,
        pivotTitle: res.pivotTitle,
        facts: res.facts,
        followups: res.followups,
      })
      return
    }
    emit(session, {
      type: 'research_brief',
      eyebrow: 'FILE ANALYSIS',
      live: false,
      headline: res.headline,
      paragraphs: res.paragraphs,
      stats: res.stats,
      model: res.model,
      ...(res.sparkPoints && res.sparkPoints.length >= 2
        ? { spark: { points: res.sparkPoints } }
        : {}),
      sources: res.sources,
      followups: res.followups,
      liveBar: {
        asOf: asOfDisplay(res.asOfIso),
        asOfIso: res.asOfIso,
        // Not refreshable: the file bytes aren't retained server-side, so an
        // in-place re-run would have nothing to re-analyze.
        refreshable: false,
        shareable: true,
        feedback: true,
        cached: false,
      },
    })
  }

  /** Best-effort store write — a library outage must never break the upload
   * pipeline (frames stay the source of truth for the thread). */
  function record(op: Promise<void>, fileId: string): void {
    op.catch((err) => log.warn({ err, fileId }, 'uploaded_files store write failed'))
  }

  async function analyze(
    session: Session,
    fileId: string,
    name: string,
    size: string,
    kind: 'csv' | 'image',
    mime: string,
    bytes: Buffer,
    dataBase64: string,
  ): Promise<void> {
    const partnerId = session.partner.partnerId
    uploadStatus(session, fileId, name, size, 'received', undefined, kind)
    uploadStatus(session, fileId, name, size, 'analyzing', undefined, kind)
    try {
      const req: FileAnalysisRequest =
        kind === 'csv'
          ? {
              kind: 'csv',
              name,
              digest: buildCsvDigest(bytes.toString('utf8')),
              ...(session.language ? { language: session.language } : {}),
            }
          : {
              kind: 'image',
              name,
              mime: mime.toLowerCase(),
              dataBase64,
              ...(session.language ? { language: session.language } : {}),
            }
      const res = await analysis.analyzeFile(req)
      record(files.markAnalyzed(partnerId, fileId, summaryOf(res)), fileId)
      // Terminal chip BEFORE the answer card, so a resume replays them in
      // reading order (chip, then the brief beneath it).
      uploadStatus(session, fileId, name, size, 'analyzed', undefined, kind)
      emitAnalysis(session, res)
    } catch (err) {
      log.error({ err, fileId, kind }, 'file analysis failed')
      const reason =
        'Analysis is temporarily unavailable — your file was not stored. Try again in a moment.'
      record(files.markFailed(partnerId, fileId, reason), fileId)
      uploadStatus(session, fileId, name, size, 'failed', reason, kind)
    }
  }

  app.post('/v1/uplink/file', routeOpts, async (req, reply) => {
    const body = parseBody(req.body)
    if (!body) {
      reply.code(400)
      return { error: 'invalid upload: sessionId, name, mime and dataBase64 are required' }
    }
    const session = sessions.get(body.sessionId)
    if (!session) {
      reply.code(404)
      return { error: 'unknown session' }
    }
    if (!BASE64_RE.test(body.dataBase64)) {
      reply.code(400)
      return { error: 'dataBase64 is not valid base64' }
    }

    const fileId = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const name = displayName(body.name)
    const bytes = Buffer.from(body.dataBase64, 'base64')
    const size = sizeDisplay(bytes.length)
    const kind = classify(body.name, body.mime)

    // Unsupported/over-limit: a 200 ack + a 'failed' frame, never a hard 4xx —
    // the SDK renders outcomes from frames, and its upload card must resolve.
    const failed = (reason: string) => {
      uploadStatus(session, fileId, name, size, 'failed', reason, kind ?? undefined)
      return { fileId, accepted: false, reason }
    }
    if (kind === null) {
      return failed(`Unsupported file type (${body.mime}) — upload a CSV or a PNG/JPEG/WebP image.`)
    }
    if (kind === 'csv' && bytes.length > CSV_MAX_BYTES) {
      return failed(`CSV too large (${size}) — the limit is 512 KB.`)
    }
    if (kind === 'image' && bytes.length > IMAGE_MAX_BYTES) {
      return failed(`Image too large (${size}) — the limit is 3 MB.`)
    }

    // Accepted: record it durably (keyed by the session's EFFECTIVE userKey
    // at upload time — identity-aware, like memory), ack now, analyze
    // asynchronously over the session SSE.
    const uploadRecord: UploadedFile = {
      partnerId: session.partner.partnerId,
      fileId,
      userKey: userKey(session),
      name,
      sizeBytes: bytes.length,
      sizeDisplay: size,
      mime: body.mime.toLowerCase(),
      kind,
      status: 'analyzing',
      createdAt: Date.now(),
    }
    record(files.insert(uploadRecord), fileId)
    void analyze(session, fileId, name, size, kind, body.mime, bytes, body.dataBase64).catch(
      (err) => log.error({ err, fileId }, 'upload pipeline failed'),
    )
    reply.code(202)
    return { fileId }
  })

  // The "Files" library: everything this user has uploaded, newest first.
  // Same session-possession auth as the upload POST (404 unknown session);
  // the effective userKey is resolved PER REQUEST, so a signin/signout is
  // reflected by the very next fetch with no extra wiring. Plain JSON (not a
  // frame) — a pull surface like the upload POST itself.
  app.get(
    '/v1/uplink/files',
    deps.rateLimit ? { preHandler: deps.rateLimit } : {},
    async (req, reply) => {
      const { session: sessionId } = req.query as { session?: string }
      const session = sessionId ? sessions.get(sessionId) : null
      if (!session) {
        reply.code(404)
        return { error: 'unknown session' }
      }
      try {
        const rows = await files.listByUser(
          session.partner.partnerId,
          userKey(session),
          UPLOADED_FILES_LIST_CAP,
        )
        return {
          files: rows.map((f) => ({
            fileId: f.fileId,
            name: f.name,
            sizeDisplay: f.sizeDisplay,
            mime: f.mime,
            kind: f.kind,
            status: f.status,
            ...(f.reason ? { reason: f.reason } : {}),
            ...(f.summary ? { summary: f.summary } : {}),
            createdAt: f.createdAt,
          })),
        }
      } catch (err) {
        log.error({ err }, 'uploaded_files list failed')
        reply.code(503)
        return { error: 'file library temporarily unavailable' }
      }
    },
  )
}
