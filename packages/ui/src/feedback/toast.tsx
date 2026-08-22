import { signal } from '@preact/signals'

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
