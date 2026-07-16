import { useState } from 'preact/hooks'
import { ApiError, currentOperator, del, get, post } from '../api.js'
import { Busy, confirmAction, ErrorBanner, toast, useLoad } from '../ui.js'

type OperatorRow = { email: string; role: 'owner' | 'operator'; createdAt: number }

export function OperatorsPage() {
  const me = currentOperator.value
  const [rows, setRows] = useState<OperatorRow[]>([])
  const [draft, setDraft] = useState<{
    email: string
    password: string
    role: 'owner' | 'operator'
  } | null>(null)
  const [error, setError] = useState('')

  const state = useLoad(async () => {
    setRows(await get<OperatorRow[]>('/v1/operators'))
  })

  async function save(e: Event) {
    e.preventDefault()
    if (!draft) return
    setError('')
    try {
      await post('/v1/operators', draft)
      toast(`Operator ${draft.email} created`)
      setDraft(null)
      state.retry()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'create failed')
    }
  }

  async function remove(email: string) {
    const ok = await confirmAction({
      title: `Remove operator`,
      body: `${email} loses access. Their existing session stops working within 8h (token expiry).`,
      confirmLabel: 'Remove',
      typedPhrase: email,
    })
    if (!ok) return
    try {
      await del(`/v1/operators/${encodeURIComponent(email)}`)
      toast(`Operator ${email} removed`)
      state.retry()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'delete failed', 'err')
    }
  }

  if (me?.role !== 'owner')
    return (
      <>
        <div class="page-head">
          <h1>Operators</h1>
        </div>
        <div class="empty">Owner role required to manage operators.</div>
      </>
    )

  return (
    <>
      <div class="page-head">
        <h1>Operators</h1>
        <button
          class="btn"
          type="button"
          onClick={() => setDraft({ email: '', password: '', role: 'operator' })}
        >
          Add operator
        </button>
      </div>

      {state.error && <ErrorBanner message={state.error} retry={state.retry} />}
      {state.loading && <Busy rows={2} />}
      {!state.loading && !state.error && (
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.email}>
                <td>{o.email}</td>
                <td>
                  <span class={`badge ${o.role === 'owner' ? 'plan' : 'none'}`}>{o.role}</span>
                </td>
                <td class="dim">
                  {o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '—'}
                </td>
                <td style="text-align:right">
                  {o.email !== me.email && (
                    <button class="btn danger sm" type="button" onClick={() => remove(o.email)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {draft && (
        <>
          <button
            type="button"
            class="drawer-veil"
            aria-label="Close"
            onClick={() => setDraft(null)}
          />
          <div class="drawer">
            <h1>Add operator</h1>
            <form class="stack" onSubmit={save}>
              <label class="field">
                Email
                <input
                  type="email"
                  value={draft.email}
                  onInput={(e) =>
                    setDraft({ ...draft, email: (e.target as HTMLInputElement).value })
                  }
                  required
                />
              </label>
              <label class="field">
                Password (min 12 chars — share it out-of-band)
                <input
                  type="password"
                  value={draft.password}
                  minLength={12}
                  onInput={(e) =>
                    setDraft({ ...draft, password: (e.target as HTMLInputElement).value })
                  }
                  required
                />
              </label>
              <label class="field">
                Role
                <select
                  value={draft.role}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      role: (e.target as HTMLSelectElement).value as 'owner' | 'operator',
                    })
                  }
                >
                  <option value="operator">operator</option>
                  <option value="owner">owner</option>
                </select>
              </label>
              <div class="actions">
                <button class="btn" type="submit">
                  Create
                </button>
                <button class="btn ghost" type="button" onClick={() => setDraft(null)}>
                  Cancel
                </button>
              </div>
              {error && <div class="error">{error}</div>}
            </form>
          </div>
        </>
      )}
    </>
  )
}
