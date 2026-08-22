import { signal } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'

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

  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      confirmReq.value = null
      setTyped('')
      req.resolve(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req])

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
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="hippo-confirm-title">
        <h1 id="hippo-confirm-title">{req.title}</h1>
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
