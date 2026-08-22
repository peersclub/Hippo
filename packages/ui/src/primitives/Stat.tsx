import type { ComponentChildren } from 'preact'

export function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: ComponentChildren
  hint?: ComponentChildren
}) {
  return (
    <div class="stat">
      <span class="dim">{label}</span>
      <strong>{value}</strong>
      {hint && <span class="dim">{hint}</span>}
    </div>
  )
}
