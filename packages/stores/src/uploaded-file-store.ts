/**
 * Durable upload records (migration 016) — the lasting trace of every ACCEPTED
 * file upload, behind the SDK's "Files" view. Rows are keyed by the session's
 * effective user key at upload time (`id:<username_lower>` when an in-panel
 * identity is active, else the host-minted sub / anonymous session id), so a
 * trader's library travels with the person like memory does. Only the record
 * is durable — file bytes are never stored.
 */
import type pg from 'pg'

export type UploadedFileStatus = 'analyzing' | 'analyzed' | 'failed'

export type UploadedFile = {
  partnerId: string
  fileId: string
  /** Effective per-user key at upload time (identity-aware, like memory). */
  userKey: string
  /** Display filename — already server-sanitized by the upload route. */
  name: string
  sizeBytes: number
  sizeDisplay: string
  mime: string
  kind: 'csv' | 'image'
  status: UploadedFileStatus
  /** Server-authored failure reason (status 'failed'). */
  reason?: string
  /** Short plain-text excerpt of the analysis answer (status 'analyzed'). */
  summary?: string
  createdAt: number
}

/** The list API's hard cap — a library view, not an export surface. */
export const UPLOADED_FILES_LIST_CAP = 50

export interface UploadedFileStore {
  /** Record an accepted upload (status 'analyzing'). Idempotent per fileId. */
  insert(file: UploadedFile): Promise<void>
  /** Analysis answered — flip to 'analyzed' with a short summary. */
  markAnalyzed(partnerId: string, fileId: string, summary: string): Promise<void>
  /** Analysis failed — flip to 'failed' with the server-authored reason. */
  markFailed(partnerId: string, fileId: string, reason: string): Promise<void>
  /** One user's files, newest first, capped (default UPLOADED_FILES_LIST_CAP). */
  listByUser(partnerId: string, userKey: string, limit?: number): Promise<UploadedFile[]>
}

const key = (partnerId: string, fileId: string) => `${partnerId}:${fileId}`

export class InMemoryUploadedFileStore implements UploadedFileStore {
  private files = new Map<string, UploadedFile>()

  async insert(file: UploadedFile): Promise<void> {
    const k = key(file.partnerId, file.fileId)
    if (this.files.has(k)) return
    this.files.set(k, { ...file })
  }

  async markAnalyzed(partnerId: string, fileId: string, summary: string): Promise<void> {
    const file = this.files.get(key(partnerId, fileId))
    if (!file) return
    file.status = 'analyzed'
    file.summary = summary
    delete file.reason
  }

  async markFailed(partnerId: string, fileId: string, reason: string): Promise<void> {
    const file = this.files.get(key(partnerId, fileId))
    if (!file) return
    file.status = 'failed'
    file.reason = reason
    delete file.summary
  }

  async listByUser(
    partnerId: string,
    userKey: string,
    limit = UPLOADED_FILES_LIST_CAP,
  ): Promise<UploadedFile[]> {
    return [...this.files.values()]
      .filter((f) => f.partnerId === partnerId && f.userKey === userKey)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((f) => ({ ...f }))
  }
}

function rowToFile(r: Record<string, unknown>): UploadedFile {
  return {
    partnerId: r.partner_id as string,
    fileId: r.file_id as string,
    userKey: r.user_key as string,
    name: r.name as string,
    sizeBytes: Number(r.size_bytes),
    sizeDisplay: r.size_display as string,
    mime: r.mime as string,
    kind: r.kind as 'csv' | 'image',
    status: r.status as UploadedFileStatus,
    ...(r.reason ? { reason: r.reason as string } : {}),
    ...(r.summary ? { summary: r.summary as string } : {}),
    createdAt: Number(r.created_at),
  }
}

export class PostgresUploadedFileStore implements UploadedFileStore {
  constructor(private readonly pool: pg.Pool) {}

  async insert(file: UploadedFile): Promise<void> {
    await this.pool.query(
      `INSERT INTO uploaded_files
         (partner_id, file_id, user_key, name, size_bytes, size_display, mime, kind, status, reason, summary, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (partner_id, file_id) DO NOTHING`,
      [
        file.partnerId,
        file.fileId,
        file.userKey,
        file.name,
        file.sizeBytes,
        file.sizeDisplay,
        file.mime,
        file.kind,
        file.status,
        file.reason ?? null,
        file.summary ?? null,
        file.createdAt,
      ],
    )
  }

  async markAnalyzed(partnerId: string, fileId: string, summary: string): Promise<void> {
    await this.pool.query(
      `UPDATE uploaded_files SET status = 'analyzed', summary = $3, reason = NULL
       WHERE partner_id = $1 AND file_id = $2`,
      [partnerId, fileId, summary],
    )
  }

  async markFailed(partnerId: string, fileId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE uploaded_files SET status = 'failed', reason = $3, summary = NULL
       WHERE partner_id = $1 AND file_id = $2`,
      [partnerId, fileId, reason],
    )
  }

  async listByUser(
    partnerId: string,
    userKey: string,
    limit = UPLOADED_FILES_LIST_CAP,
  ): Promise<UploadedFile[]> {
    const res = await this.pool.query(
      `SELECT * FROM uploaded_files
       WHERE partner_id = $1 AND user_key = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [partnerId, userKey, limit],
    )
    return res.rows.map(rowToFile)
  }
}
