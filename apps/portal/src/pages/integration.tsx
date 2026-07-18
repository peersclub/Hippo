import { useState } from 'preact/hooks'
import { currentAdmin, get, patch, post } from '../api.js'
import { Busy, confirmAction, ErrorBanner, toast, useLoad } from '../ui.js'

type Integration = {
  partnerKey: string
  venueName: string
  locales: string[]
  suggestedQueries: string[]
  embedSnippet: string
}

export function IntegrationPage() {
  const [data, setData] = useState<Integration | null>(null)
  const [venueName, setVenueName] = useState('')
  const [queries, setQueries] = useState('')
  const [rotated, setRotated] = useState<string | null>(null)
  const readOnly = currentAdmin.value?.role !== 'admin'

  const state = useLoad(async () => {
    const d = await get<Integration>('/portal/integration')
    setData(d)
    setVenueName(d.venueName)
    setQueries(d.suggestedQueries.join('\n'))
  })

  async function save(e: Event) {
    e.preventDefault()
    try {
      const d = await patch<Integration>('/portal/integration', {
        venueName,
        suggestedQueries: queries
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 8),
      })
      setData(d)
      toast('Integration updated')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'update failed', 'err')
    }
  }

  async function rotate() {
    const ok = await confirmAction({
      title: 'Rotate JWT secret?',
      body: 'Your token signer must switch to the new secret. The old secret stops working for new sessions immediately. The new value is shown exactly once.',
      confirmLabel: 'Rotate secret',
      typedPhrase: 'rotate',
      danger: true,
    })
    if (!ok) return
    try {
      const res = await post<{ jwtSecret: string }>('/portal/integration/rotate-secret')
      setRotated(res.jwtSecret)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'rotation failed', 'err')
    }
  }

  if (state.error) return <ErrorBanner message={state.error} retry={state.retry} />
  if (state.loading && !data) return <Busy rows={4} />
  if (!data) return null

  return (
    <>
      <div class="page-head">
        <h1>Integration</h1>
      </div>

      <div class="kv">
        <span class="dim">Embed key</span>
        <code class="mono">{data.partnerKey}</code>
      </div>
      <div class="kv">
        <span class="dim">Embed tag</span>
        <code class="mono">{data.embedSnippet}</code>
        <button
          class="btn"
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(data.embedSnippet)
            toast('Embed tag copied')
          }}
        >
          Copy
        </button>
      </div>

      <form class="stack" onSubmit={save}>
        <label class="field">
          Venue name
          <input
            value={venueName}
            onInput={(e) => setVenueName((e.target as HTMLInputElement).value)}
            disabled={readOnly}
            required
          />
        </label>
        <label class="field">
          Suggested queries (one per line, max 8)
          <textarea
            rows={5}
            value={queries}
            onInput={(e) => setQueries((e.target as HTMLTextAreaElement).value)}
            disabled={readOnly}
          />
        </label>
        {!readOnly && (
          <button class="btn" type="submit">
            Save changes
          </button>
        )}
      </form>

      {!readOnly && (
        <div class="stack">
          <h2>JWT secret</h2>
          <p class="dim">
            The shared secret your backend signs user tokens with. It is never shown here — rotating
            it is the only way to get a new value.
          </p>
          {rotated ? (
            <div class="alert">
              <strong>New secret (copy now — shown once):</strong>
              <code class="mono">{rotated}</code>
              <button
                class="btn"
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(rotated)
                  toast('Secret copied — store it in your vault')
                }}
              >
                Copy
              </button>
            </div>
          ) : (
            <button class="btn" type="button" onClick={rotate}>
              Rotate secret…
            </button>
          )}
        </div>
      )}
    </>
  )
}
