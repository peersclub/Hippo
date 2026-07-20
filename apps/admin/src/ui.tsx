/**
 * Shared UX kit: toasts, typed-confirmation modal, loading skeleton, error
 * banner. Signal-backed, dependency-free, one file — house style.
 */
import { signal } from '@preact/signals'
import { useCallback, useEffect, useState } from 'preact/hooks'

// ── toasts ───────────────────────────────────────────────────────────────────

type Toast = { id: number; msg: string; kind: 'ok' | 'err' }
const toasts = signal<Toast[]>([])
let nextToastId = 1

export function toast(msg: string, kind: 'ok' | 'err' = 'ok'): void {
  const id = nextToastId++
  toasts.value = [...toasts.value, { id, msg, kind }]
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, 4000)
}

export function Toasts() {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`} role="status">
          {t.msg}
        </div>
      ))}
    </div>
  )
}

// ── typed-confirmation modal ─────────────────────────────────────────────────

type ConfirmRequest = {
  title: string
  body: string
  confirmLabel: string
  /** When set, the user must type this exact phrase to enable Confirm. */
  typedPhrase?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

const confirmReq = signal<ConfirmRequest | null>(null)

/** Promise-based confirm — replaces window.confirm. */
export function confirmAction(opts: {
  title: string
  body: string
  confirmLabel?: string
  typedPhrase?: string
  danger?: boolean
}): Promise<boolean> {
  return new Promise((resolve) => {
    confirmReq.value = {
      title: opts.title,
      body: opts.body,
      confirmLabel: opts.confirmLabel ?? 'Confirm',
      danger: opts.danger ?? true,
      resolve,
      ...(opts.typedPhrase !== undefined ? { typedPhrase: opts.typedPhrase } : {}),
    }
  })
}

export function ConfirmHost() {
  const req = confirmReq.value
  const [typed, setTyped] = useState('')
  if (!req) return null

  const armed = !req.typedPhrase || typed === req.typedPhrase
  const done = (ok: boolean) => {
    confirmReq.value = null
    setTyped('')
    req.resolve(ok)
  }

  return (
    <>
      <button type="button" class="drawer-veil" aria-label="Cancel" onClick={() => done(false)} />
      <div class="modal" role="dialog" aria-modal="true">
        <h1>{req.title}</h1>
        <p class="modal-body">{req.body}</p>
        {req.typedPhrase && (
          <label class="field">
            Type <span class="mono">{req.typedPhrase}</span> to confirm
            <input
              value={typed}
              onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
              autofocus
            />
          </label>
        )}
        <div class="actions">
          <button
            type="button"
            class={`btn ${req.danger ? 'danger' : ''}`}
            disabled={!armed}
            onClick={() => done(true)}
          >
            {req.confirmLabel}
          </button>
          <button type="button" class="btn ghost" onClick={() => done(false)}>
            Cancel
          </button>
        </div>
      </div>
    </>
  )
}

// ── empty state ──────────────────────────────────────────────────────────────

/** Friendly zero-row state: what's missing + the action that fixes it. */
export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div class="empty-state">
      <div class="empty-title">{title}</div>
      {hint && <div class="empty-hint">{hint}</div>}
    </div>
  )
}

// ── loading + error ──────────────────────────────────────────────────────────

export function Busy({ rows = 3 }: { rows?: number }) {
  return (
    <div class="busy" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} class="skeleton" />
      ))}
    </div>
  )
}

/** Page-load lifecycle in one hook: loading skeleton → data or ErrorBanner. */
export function useLoad(
  fn: () => Promise<void>,
  deps: unknown[] = [],
): { loading: boolean; error: string; retry: () => void } {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const retry = useCallback(() => {
    setLoading(true)
    setError('')
    fn()
      .catch((e) => setError(e instanceof Error ? e.message : 'request failed'))
      .finally(() => setLoading(false))
  }, deps)
  useEffect(() => {
    retry()
  }, [retry])
  return { loading, error, retry }
}

export function ErrorBanner({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div class="error-banner" role="alert">
      <span>{message}</span>
      {retry && (
        <button type="button" class="btn ghost sm" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  )
}
