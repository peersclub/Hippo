import type { ComponentChildren } from 'preact'

export function PageHead({
  title,
  extra,
}: {
  title: ComponentChildren
  extra?: ComponentChildren
}) {
  return (
    <div class="page-head">
      <h1>{title}</h1>
      {extra}
    </div>
  )
}
