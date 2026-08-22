import type { ComponentChildren, JSX } from 'preact'

export type ButtonVariant = 'primary' | 'ghost' | 'danger'
export type ButtonSize = 'md' | 'sm'

export function Button({
  variant = 'primary',
  size = 'md',
  children,
  class: extra,
  ...rest
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  children?: ComponentChildren
  class?: string
} & JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const kind = variant === 'primary' ? '' : variant
  const cls = ['btn', kind, size === 'sm' ? 'sm' : '', extra].filter(Boolean).join(' ')
  return (
    <button type="button" class={cls} {...rest}>
      {children}
    </button>
  )
}
