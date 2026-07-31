/**
 * Client for the intelligence service's file-analysis endpoint
 * (POST {INTEL}/v1/analyze-file). Separate from the IntelligenceClient in
 * ../orchestrator/intelligence.ts on purpose: the upload pipeline is additive
 * and must not widen the shared orchestrator contract that other tracks build
 * against. Same base URL, same never-throw-into-the-route posture (callers
 * catch and emit an honest upload_status 'failed' frame).
 *
 * Wire contract (pinned with services/intelligence):
 *   POST /v1/analyze-file
 *     { kind:'csv',   name, digest, language? }
 *   | { kind:'image', name, mime, dataBase64, language? }
 *   → BriefResponse | DeclineResponse (same shapes as /v1/respond)
 */
import type { RespondResult } from '../orchestrator/intelligence.js'
import type { CsvDigest } from './csv.js'

const INTELLIGENCE_URL = process.env.INTELLIGENCE_URL ?? 'http://localhost:8791'

/** Vision + CSV analysis share the research budget (30s), not the intent one. */
const ANALYZE_TIMEOUT_MS = 30_000

export type FileAnalysisRequest =
  | { kind: 'csv'; name: string; digest: CsvDigest; language?: string }
  | { kind: 'image'; name: string; mime: string; dataBase64: string; language?: string }

export interface FileAnalysisClient {
  /** Rejects on timeout, network error or non-2xx — the route's failed path. */
  analyzeFile(req: FileAnalysisRequest): Promise<RespondResult>
}

export function createFileAnalysisClient(baseUrl = INTELLIGENCE_URL): FileAnalysisClient {
  return {
    async analyzeFile(req) {
      const res = await fetch(`${baseUrl}/v1/analyze-file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`intelligence ${res.status} for ${baseUrl}/v1/analyze-file`)
      return (await res.json()) as RespondResult
    },
  }
}
