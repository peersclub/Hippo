import { useState } from 'preact/hooks'
import { get } from '../api.js'
import { Busy, ErrorBanner, useLoad } from '../ui.js'

type Entry = {
  id: number
  operatorEmail: string
  action: string
  target: string
  detail: Record<string, unknown>
  ts: number
}

const PAGE = 50

export function AuditPage() {
  const [rows, setRows] = useState<Entry[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)

  const state = useLoad(async () => {
    const page = await get<{ rows: Entry[]; total: number }>(
      `/portal/audit?offset=${offset}&limit=${PAGE}`,
    )
    setRows(page.rows)
    setTotal(page.total)
  }, [offset])

  if (state.error) return <ErrorBanner message={state.error} retry={state.retry} />

  return (
    <>
      <div class="page-head">
        <h1>Activity</h1>
        <span class="dim">{total} entries · your team's portal actions</span>
      </div>
      {state.loading && rows.length === 0 ? (
        <Busy rows={4} />
      ) : rows.length === 0 ? (
        <div class="empty">Nothing yet — actions your team takes here show up in this trail.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.ts).toLocaleString()}</td>
                <td class="mono">{e.operatorEmail}</td>
                <td>
                  <span class="chip">{e.action}</span>
                </td>
                <td class="mono">{e.target}</td>
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
