/**
 * The "Files" view — a WhatsApp-style list of everything this trader has
 * uploaded. Server truth, no client cache: the overlay refetches
 * `GET /v1/uplink/files` on every open, so after a signin/signout it simply
 * reflects the new effective user (the gateway resolves the key per request).
 *
 * This module owns the fetch + view state; overlays.tsx renders it. Kept
 * dependency-free (fetch + signals) like the rest of the SDK.
 */
import { signal } from '@preact/signals'
import { sessionId } from './state.js'
import { gatewayUrl } from './transport.js'

/** One row as the list API returns it (plain JSON, not a protocol frame). */
export type LibraryFile = {
  fileId: string
  name: string
  sizeDisplay: string
  mime: string
  kind: 'csv' | 'image'
  status: 'analyzing' | 'analyzed' | 'failed'
  reason?: string
  summary?: string
  createdAt: number
}

export type FilesView =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'list'; files: LibraryFile[] }

/** Whether the Files overlay is open (header button ⇄ close/Esc). */
export const filesOpen = signal(false)

/** The current view state — refetched on each open, never cached across opens. */
export const filesView = signal<FilesView>({ phase: 'loading' })

/** Parse the list payload defensively — only well-formed rows survive, so a
 * malformed server response degrades to an empty/partial list, never a throw. */
export function parseFiles(raw: unknown): LibraryFile[] {
  if (typeof raw !== 'object' || raw === null) return []
  const list = (raw as { files?: unknown }).files
  if (!Array.isArray(list)) return []
  const out: LibraryFile[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    if (
      typeof r.fileId !== 'string' ||
      typeof r.name !== 'string' ||
      typeof r.sizeDisplay !== 'string' ||
      typeof r.mime !== 'string' ||
      (r.kind !== 'csv' && r.kind !== 'image') ||
      (r.status !== 'analyzing' && r.status !== 'analyzed' && r.status !== 'failed') ||
      typeof r.createdAt !== 'number'
    ) {
      continue
    }
    out.push({
      fileId: r.fileId,
      name: r.name,
      sizeDisplay: r.sizeDisplay,
      mime: r.mime,
      kind: r.kind,
      status: r.status,
      ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
      ...(typeof r.summary === 'string' ? { summary: r.summary } : {}),
      createdAt: r.createdAt,
    })
  }
  return out
}

/**
 * Fetch the library and drive `filesView`. Sets `loading` first, then `list`
 * or `error`. Safe to call on every open (the whole point — no cache).
 */
export async function loadFiles(): Promise<void> {
  filesView.value = { phase: 'loading' }
  const gateway = gatewayUrl()
  const sid = sessionId.value
  if (!gateway || !sid) {
    filesView.value = { phase: 'error' }
    return
  }
  try {
    const res = await fetch(`${gateway}/v1/uplink/files?session=${encodeURIComponent(sid)}`)
    if (!res.ok) {
      filesView.value = { phase: 'error' }
      return
    }
    filesView.value = { phase: 'list', files: parseFiles(await res.json()) }
  } catch {
    filesView.value = { phase: 'error' }
  }
}

/** Open the overlay and (re)load — a single entry point for the header button. */
export function openFiles(): void {
  filesOpen.value = true
  void loadFiles()
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Compact relative time ("just now", "3m", "5h", "2d", then a date). Locale-
 * agnostic short forms so the list stays scannable and RTL-safe; `now` is
 * injectable for tests.
 */
export function relativeTime(createdAt: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - createdAt)
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`
  return new Date(createdAt).toISOString().slice(0, 10)
}
