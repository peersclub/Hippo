/** Friendly zero-row state: what's missing + the action that fixes it. */
export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div class="empty-state">
      <div class="empty-title">{title}</div>
      {hint && <div class="empty-hint">{hint}</div>}
    </div>
  )
}
