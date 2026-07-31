/**
 * File-upload affordance — client-side limits, byte progress, and the
 * `POST /v1/uplink/file` call (the ONE uplink that isn't JSON-over-/v1/turns:
 * file bytes ride as base64 in a dedicated endpoint, per the pinned contract).
 *
 * Division of truth: the CLIENT owns only the byte-progress bar during the
 * HTTP POST (the wire has no 'uploading' phase by design); everything after
 * the 202 — received / analyzing / failed — arrives as `upload_status` frames
 * over the existing SSE, and the analysis answer itself is a normal
 * research_brief. Limits are enforced HERE before anything is sent: an
 * unsupported or oversized file surfaces a local error row and never leaves
 * the panel.
 */

import type { LocalUpload } from './state.js'
import { localUploads, sessionId } from './state.js'
import { gatewayUrl } from './transport.js'

/** Pinned HTTP contract limits — the gateway enforces the same numbers. */
export const CSV_MAX_BYTES = 512 * 1024
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp'])

export type UploadKind = 'csv' | 'image'
export type UploadCheck =
  | { ok: true; kind: UploadKind }
  | { ok: false; reason: 'too_large_csv' | 'too_large_image' | 'unsupported' }

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i + 1).toLowerCase()
}

/**
 * Client-side gate, run before a single byte is sent. Classification checks
 * the mime AND the extension — browsers report empty or vendor mimes for CSV
 * (e.g. application/vnd.ms-excel), so the extension is a first-class signal.
 */
export function checkUpload(name: string, mime: string, sizeBytes: number): UploadCheck {
  const ext = extOf(name)
  if (mime === 'text/csv' || ext === 'csv') {
    return sizeBytes <= CSV_MAX_BYTES
      ? { ok: true, kind: 'csv' }
      : { ok: false, reason: 'too_large_csv' }
  }
  if (IMAGE_MIMES.has(mime) || IMAGE_EXTS.has(ext)) {
    return sizeBytes <= IMAGE_MAX_BYTES
      ? { ok: true, kind: 'image' }
      : { ok: false, reason: 'too_large_image' }
  }
  return { ok: false, reason: 'unsupported' }
}

/** Presentation-only size label for the CLIENT progress row (frames carry the
 * server's own `sizeDisplay` — this never touches money, only bytes). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Byte progress as a clamped integer percent; 0 while the total is unknown. */
export function progressPct(loaded: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)))
}

/** Strip the data-URL prefix FileReader produces, leaving raw base64. */
export function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

/** The mime the contract body carries — the browser's when it gave one, else
 * derived from the classification (CSV files often arrive with no mime). */
export function uploadMime(kind: UploadKind, fileMime: string): string {
  if (fileMime) return fileMime
  return kind === 'csv' ? 'text/csv' : 'application/octet-stream'
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(dataUrlToBase64(String(reader.result)))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * POST the file per the pinned contract. XHR, not fetch — upload byte
 * progress only exists on XHR (`upload.onprogress`), and the progress bar is
 * the whole point of the client-side phase. Resolves null on ANY failure
 * (non-202, network, bad JSON) — the caller fails the row loudly.
 */
export function postFile(opts: {
  gateway: string
  sessionId: string
  name: string
  mime: string
  dataBase64: string
  onProgress: (pct: number) => void
}): Promise<{ fileId: string } | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${opts.gateway}/v1/uplink/file`)
    xhr.setRequestHeader('content-type', 'application/json')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress(progressPct(e.loaded, e.total))
    }
    xhr.onload = () => {
      if (xhr.status !== 202) return resolve(null)
      try {
        const data = JSON.parse(xhr.responseText) as { fileId?: unknown }
        resolve(typeof data.fileId === 'string' && data.fileId ? { fileId: data.fileId } : null)
      } catch {
        resolve(null)
      }
    }
    xhr.onerror = () => resolve(null)
    xhr.send(
      JSON.stringify({
        sessionId: opts.sessionId,
        name: opts.name,
        mime: opts.mime,
        dataBase64: opts.dataBase64,
      }),
    )
  })
}

let nextLocalId = 1

function patchUpload(id: number, patch: Partial<LocalUpload>) {
  localUploads.value = localUploads.value.map((u) => (u.id === id ? { ...u, ...patch } : u))
}

/** Remove a local row (error rows offer a ✕; success rows are cleared by the
 * first `upload_status` frame for their fileId — see state.ts). */
export function dismissUpload(id: number) {
  localUploads.value = localUploads.value.filter((u) => u.id !== id)
}

// ── sequential upload queue ─────────────────────────────────────────────────
// Multiple files may be picked at once, but only ONE is ever in flight: file
// bytes fan out to base64 + the network, and a serial queue keeps memory and
// the gateway's per-IP limiter sane. Each queued file already owns its own
// row (id → File held here), shown at 0% until its turn; the pump drains them
// oldest-first. Kept module-local (never a signal) — pure client plumbing.
const queue: Array<{ id: number; file: File; kind: UploadKind }> = []
let pumping = false

/** Encode + POST one accepted file, driving its row. Resolves when the row
 * reaches a terminal client state (accepted 202, or a retryable error). */
async function runUpload(id: number, file: File, kind: UploadKind): Promise<void> {
  patchUpload(id, { phase: 'sending', pct: 0, errorKey: undefined })
  const gateway = gatewayUrl()
  const sid = sessionId.value
  const fail = () =>
    patchUpload(id, { phase: 'error', errorKey: 'upload_send_failed', retry: true })
  if (!gateway || !sid) return fail()
  const dataBase64 = await fileToBase64(file).catch(() => null)
  if (dataBase64 === null) return fail()
  const res = await postFile({
    gateway,
    sessionId: sid,
    name: file.name,
    mime: uploadMime(kind, file.type),
    dataBase64,
    onProgress: (pct) => patchUpload(id, { pct }),
  })
  if (res === null) return fail()
  // Accepted — the server's upload_status frames take over from here.
  patchUpload(id, { pct: 100, fileId: res.fileId, retry: undefined })
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await runUpload(next.id, next.file, next.kind)
    }
  } finally {
    pumping = false
  }
}

/** Enqueue one accepted file (its row already exists) and kick the pump. */
function enqueue(id: number, file: File, kind: UploadKind): void {
  queue.push({ id, file, kind })
  void pump()
}

/**
 * The composer's whole flow: gate locally, show a progress row, then hand the
 * file to the sequential queue (encode + POST). On 202 the row holds (at 100%)
 * until the gateway's first `upload_status` frame for the returned fileId
 * clears it; on any failure the row flips to a retryable error — nothing
 * invented, nothing silently dropped. Locally-rejected files surface a
 * dismissible error and never enter the queue.
 */
export function startUpload(file: File): void {
  const id = nextLocalId++
  const base: LocalUpload = {
    id,
    name: file.name,
    sizeDisplay: formatBytes(file.size),
    pct: 0,
    phase: 'sending',
  }
  const check = checkUpload(file.name, file.type, file.size)
  if (!check.ok) {
    const errorKey =
      check.reason === 'too_large_csv'
        ? ('upload_too_large_csv' as const)
        : check.reason === 'too_large_image'
          ? ('upload_too_large_image' as const)
          : ('upload_unsupported' as const)
    // Local rejects are NOT retryable (re-POSTing the same oversized/unsupported
    // file would fail identically) — they only offer dismiss.
    localUploads.value = [...localUploads.value, { ...base, phase: 'error', errorKey }]
    return
  }
  localUploads.value = [...localUploads.value, { ...base, file }]
  enqueue(id, file, check.kind)
}

/** Pick every chosen file (multi-select). Each gets its own row/chip; the
 * queue runs them one at a time. */
export function startUploads(files: Iterable<File>): void {
  for (const file of files) startUpload(file)
}

/**
 * Re-POST a failed row's original file (network / send failures only —
 * local rejects have no file to retry). Reuses the SAME row so the thread
 * never gains a duplicate; re-enters the sequential queue.
 */
export function retryUpload(id: number): void {
  const row = localUploads.value.find((u) => u.id === id)
  if (!row?.file) return
  const check = checkUpload(row.file.name, row.file.type, row.file.size)
  if (!check.ok) return // shouldn't happen — a retryable row already passed the gate
  patchUpload(id, { phase: 'sending', pct: 0, errorKey: undefined, retry: undefined })
  enqueue(id, row.file, check.kind)
}
