import { useEffect, useState } from 'preact/hooks'
import { ApiError, currentOperator, del, get, post } from '../api.js'

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

  const load = () =>
    get<OperatorRow[]>('/v1/operators')
      .then(setRows)
      .catch((e) =>
        setError(
          e instanceof ApiError && e.status === 403 ? 'Owner role required.' : String(e.message),
        ),
      )
  useEffect(() => {
    void load()
  }, [])

  async function save(e: Event) {
    e.preventDefault()
    if (!draft) return
    setError('')
    try {
      await post('/v1/operators', draft)
      setDraft(null)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'create failed')
    }
  }

  async function remove(email: string) {
    if (!confirm(`Remove operator ${email}? Their session stops working within 8h (token expiry).`))
      return
    try {
      await del(`/v1/operators/${encodeURIComponent(email)}`)
      await load()
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'delete failed')
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
              <td class="dim">{o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '—'}</td>
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
      {error && <div class="error">{error}</div>}

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
