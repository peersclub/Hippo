import type { ComponentChildren } from 'preact'

export type BadgeTone = 'active' | 'suspended' | 'blocked' | 'plan' | 'none' | 'llm' | 'sandbox'

export function Badge({
  tone,
  children,
}: {
  tone: BadgeTone | string
  children: ComponentChildren
}) {
  return <span class={`badge ${tone}`}>{children}</span>
}
