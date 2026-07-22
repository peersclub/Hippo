/**
 * Memory Config (super-admin / owner only) — the freeform memory documents
 * that layer into the prompt: PLATFORM RULES (global, binding) → VENUE
 * (host) → USER. A textarea editor per scope; the gateway composes them in
 * authority order. Session scope + the "what was sent" inspector arrive with
 * the composition work.
 */
import { useState } from 'preact/hooks'
import { ApiError, get, put } from '../api.js'
import { Busy, ErrorBanner, toast, useLoad } from '../ui.js'

type Scope = 'global' | 'host' | 'user'
type Doc = { body: string; updatedAt: number }

const SCOPES: { key: Scope; label: string; blurb: string }[] = [
  {
    key: 'global',
    label: 'Platform',
    blurb: 'Binding rules applied to every partner and session — the outermost guardrail.',
  },
  {
    key: 'host',
    label: 'Venue',
    blurb: 'Context for one partner venue, applied to all its users.',
  },
  {
    key: 'user',
    label: 'User',
    blurb: 'A freeform note for one user, alongside their structured persona.',
  },
]

function pathFor(scope: Scope, partnerId: string, userId: string): string | null {
  if (scope === 'global') return '/v1/memory-config/global'
  if (scope === 'host')
    return partnerId ? `/v1/memory-config/host/${encodeURIComponent(partnerId)}` : null
  return partnerId && userId
    ? `/v1/memory-config/user/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`
    : null
}

export function MemoryConfigPage() {
  const [scope, setScope] = useState<Scope>('global')
  const [partnerId, setPartnerId] = useState('')
  const [userId, setUserId] = useState('')
  const [body, setBody] = useState('')
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const path = pathFor(scope, partnerId.trim(), userId.trim())

  const state = useLoad(async () => {
    if (!path) {
      setLoadedFrom(null)
      return
    }
    const doc = await get<Doc>(path)
    setBody(doc.body)
    setLoadedFrom(path)
  }, [path])

  async function save(e: Event) {
    e.preventDefault()
    if (!path) return
    setSaving(true)
    setError('')
    try {
      await put<Doc>(path, { body })
      toast('Memory saved')
      setLoadedFrom(path)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'save failed')
    } finally {
      setSaving(false)
    }
  }

  const needsIds =
    (scope === 'host' && !partnerId.trim()) ||
    (scope === 'user' && (!partnerId.trim() || !userId.trim()))
  const current = SCOPES.find((s) => s.key === scope)

  return (
    <div>
      <div class="page-head">
        <h1>Memory Config</h1>
      </div>
      <p class="dim">
        Freeform memory layered into the model prompt in authority order: Platform → Venue → User (→
        Session). Platform rules are binding.
      </p>

      <div class="chips">
        {SCOPES.map((s) => (
          <button
            type="button"
            key={s.key}
            class={`btn${scope === s.key ? '' : ' ghost'} sm`}
            onClick={() => setScope(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <p class="dim">{current?.blurb}</p>

      {(scope === 'host' || scope === 'user') && (
        <div class="stack">
          <label class="field">
            Partner ID
            <input
              value={partnerId}
              onInput={(e) => setPartnerId((e.target as HTMLInputElement).value)}
            />
          </label>
          {scope === 'user' && (
            <label class="field">
              User ID
              <input
                value={userId}
                onInput={(e) => setUserId((e.target as HTMLInputElement).value)}
              />
            </label>
          )}
        </div>
      )}

      {needsIds ? (
        <p class="dim">
          Enter the {scope === 'user' ? 'partner and user ids' : 'partner id'} to load its memory.
        </p>
      ) : state.loading ? (
        <Busy rows={4} />
      ) : state.error ? (
        <ErrorBanner message={state.error} retry={state.retry} />
      ) : (
        <form onSubmit={save} class="stack">
          <textarea
            rows={14}
            value={body}
            placeholder="Curated context for this scope. Plain text or markdown."
            onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
          />
          {error && <div class="error">{error}</div>}
          <div class="actions">
            <button type="submit" class="btn" disabled={saving || loadedFrom !== path}>
              {saving ? 'Saving…' : 'Save memory'}
            </button>
            <span class="dim mono">{body.length} chars</span>
          </div>
        </form>
      )}
    </div>
  )
}
