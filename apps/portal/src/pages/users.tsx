import { useState } from 'preact/hooks'
import { currentAdmin, get, post } from '../api.js'
import { Busy, confirmAction, ErrorBanner, toast, useLoad } from '../ui.js'

type UserRow = {
  partnerId: string
  userId: string
  firstSeen: number
  lastSeen: number
  status: 'active' | 'blocked'
}

const PAGE = 50

export function UsersPage() {
  const [rows, setRows] = useState<UserRow[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [q, setQ] = useState('')
  const readOnly = currentAdmin.value?.role !== 'admin'

  const state = useLoad(async () => {
    const page = await get<{ rows: UserRow[]; total: number }>(
      `/portal/users?offset=${offset}&limit=${PAGE}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    )
    setRows(page.rows)
    setTotal(page.total)
  }, [offset, q])

  async function toggle(u: UserRow) {
    const verb = u.status === 'blocked' ? 'unblock' : 'block'
    if (
      verb === 'block' &&
      !(await confirmAction({
        title: `Block ${u.userId}?`,
        body: 'They will not be able to open Hippo on your venue until unblocked.',
        confirmLabel: 'Block user',
        danger: true,
      }))
    )
      return
    try {
      await post(`/portal/users/${encodeURIComponent(u.userId)}/${verb}`)
      toast(`${u.userId} ${verb}ed`)
      state.retry()
    } catch (err) {
      toast(err instanceof Error ? err.message : `${verb} failed`, 'err')
    }
  }

  if (state.error) return <ErrorBanner message={state.error} retry={state.retry} />

  return (
    <>
      <div class="page-head">
        <h1>Users</h1>
        <span class="dim">{total} total</span>
      </div>
      <div class="toolbar">
        <input
          class="search-box"
          placeholder="Search user id…"
          value={q}
          onInput={(e) => {
            setOffset(0)
            setQ((e.target as HTMLInputElement).value)
          }}
        />
      </div>
      {state.loading && rows.length === 0 ? (
        <Busy rows={4} />
      ) : rows.length === 0 ? (
        <div class="empty">No users yet — they appear on their first authenticated session.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>First seen</th>
              <th>Last seen</th>
              <th>Status</th>
              {!readOnly && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.userId}>
                <td class="mono">{u.userId}</td>
                <td>{new Date(u.firstSeen).toLocaleDateString()}</td>
                <td>{new Date(u.lastSeen).toLocaleString()}</td>
                <td>
                  <span class={`badge ${u.status}`}>{u.status}</span>
                </td>
                {!readOnly && (
                  <td>
                    <button class="btn" type="button" onClick={() => toggle(u)}>
                      {u.status === 'blocked' ? 'Unblock' : 'Block'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {total > PAGE && (
        <div class="pager">
          <button
            class="btn"
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Prev
          </button>
          <span class="dim">
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </span>
          <button
            class="btn"
            type="button"
            disabled={offset + PAGE >= total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </button>
        </div>
      )}
    </>
  )
}
