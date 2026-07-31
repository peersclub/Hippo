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
 *    session SSE: upload_status 'received' → 'analyzing' → a research_brief
 *    (or advice_decline — the no-advice guardrail applies to file answers
 *    too), or upload_status 'failed' + reason.
 *
 * File content is UNTRUSTED DATA end to end: CSV bytes are parsed server-side
 * into a bounded digest (never shipped raw into a prompt) and the intelligence
 * service places file content strictly in the user-content position beneath
 * its no-advice system prompt.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { RespondResult } from '../orchestrator/intelligence.js'
import { asOfDisplay } from '../orchestrator/market.js'
import type { Session, SessionStore } from '../plugins/auth.js'
import type { EmitFrame } from '../plugins/sse.js'
import type { FileAnalysisClient, FileAnalysisRequest } from './analysis.js'
import { buildCsvDigest } from './csv.js'

export const CSV_MAX_BYTES = 512 * 1024
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

type Log = {
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
}

export type FileUploadDeps = {
  sessions: SessionStore
  emit: EmitFrame
  analysis: FileAnalysisClient
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

export function registerFileUploadRoute(app: FastifyInstance, deps: FileUploadDeps): void {
  const { sessions, emit, analysis, log } = deps
  // Fastify's default 1MB bodyLimit would 413 a legitimate 3MB image before
  // the handler runs. 8MB comfortably covers the base64 form of every
  // in-limit file (3MB → ~4.2MB) AND the over-limit range we soft-fail with
  // a frame; only grossly oversized bodies still get the transport-level 413.
  const routeOpts = {
    bodyLimit: 8 * 1024 * 1024,
    ...(deps.rateLimit ? { preHandler: deps.rateLimit } : {}),
  }

  function uploadStatus(
    session: Session,
    fileId: string,
    name: string,
    size: string,
    phase: 'received' | 'analyzing' | 'failed',
    reason?: string,
  ): void {
    emit(session, {
      type: 'upload_status',
      fileId,
      name,
      sizeDisplay: size,
      phase,
      ...(reason ? { reason } : {}),
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
    uploadStatus(session, fileId, name, size, 'received')
    uploadStatus(session, fileId, name, size, 'analyzing')
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
      emitAnalysis(session, await analysis.analyzeFile(req))
    } catch (err) {
      log.error({ err, fileId, kind }, 'file analysis failed')
      uploadStatus(
        session,
        fileId,
        name,
        size,
        'failed',
        'Analysis is temporarily unavailable — your file was not stored. Try again in a moment.',
      )
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
      uploadStatus(session, fileId, name, size, 'failed', reason)
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

    // Accepted: ack now, analyze asynchronously over the session SSE.
    void analyze(session, fileId, name, size, kind, body.mime, bytes, body.dataBase64).catch(
      (err) => log.error({ err, fileId }, 'upload pipeline failed'),
    )
    reply.code(202)
    return { fileId }
  })
}
