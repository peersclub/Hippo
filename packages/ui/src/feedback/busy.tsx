export function Busy({ rows = 3 }: { rows?: number }) {
  return (
    <div class="busy" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} class="skeleton" />
      ))}
    </div>
  )
}
