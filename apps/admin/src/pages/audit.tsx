import type { AuditEntry } from '@hippo/stores'
import { useEffect, useState } from 'preact/hooks'
import { get } from '../api.js'

export function AuditPage() {
  const [page, setPage] = useState<{ rows: AuditEntry[]; total: number }>({ rows: [], total: 0 })
  const [offset, setOffset] = useState(0)
  const limit = 50

  useEffect(() => {
    void get<typeof page>(`/v1/audit?offset=${offset}&limit=${limit}`)
      .then(setPage)
      .catch(() => {})
  }, [offset])

  return (
    <>
      <div class="page-head">
        <h1>Audit</h1>
        <span class="dim">{page.total} operator actions</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Operator</th>
            <th>Action</th>
            <th>Target</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.length === 0 && (
            <tr>
              <td colSpan={5} class="empty">
                No operator actions recorded yet.
              </td>
            </tr>
          )}
          {page.rows.map((e) => (
            <tr key={e.id}>
              <td class="dim">{new Date(e.ts).toLocaleString()}</td>
              <td>{e.operatorEmail}</td>
              <td class="mono">{e.action}</td>
              <td class="mono">{e.target}</td>
              <td class="mono dim">
                {Object.keys(e.detail).length ? JSON.stringify(e.detail) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="pager">
        <button
          class="btn ghost sm"
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - limit))}
        >
          ← Prev
        </button>
        <span>
          {page.total === 0 ? 0 : offset + 1}–{Math.min(offset + limit, page.total)} of {page.total}
        </span>
        <button
          class="btn ghost sm"
          type="button"
          disabled={offset + limit >= page.total}
          onClick={() => setOffset(offset + limit)}
        >
          Next →
        </button>
      </div>
    </>
  )
}
