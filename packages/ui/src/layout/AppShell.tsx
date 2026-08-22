import type { ComponentChildren } from 'preact'
import { ConfirmHost } from '../feedback/confirm.js'
import { Toasts } from '../feedback/toast.js'

export type NavItem = { key: string; label: string }

export function AppShell({
  brand = 'Hippo',
  sub,
  nav,
  page,
  email,
  role,
  onSignOut,
  children,
}: {
  brand?: string
  sub: string
  nav: readonly NavItem[]
  page: string
  email: string
  role: string
  onSignOut: () => void
  children: ComponentChildren
}) {
  return (
    <div class="layout">
      <aside class="sidebar">
        <div class="logo">
          <span class="dot">H</span>
          {brand} <span class="sub">{sub}</span>
        </div>
        <nav class="nav">
          {nav.map((item) => (
            <a key={item.key} href={`#/${item.key}`} class={page === item.key ? 'on' : ''}>
              {item.label}
            </a>
          ))}
        </nav>
        <div class="foot">
          <div>{email}</div>
          <div class="dim">{role}</div>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main class="main">{children}</main>
      <Toasts />
      <ConfirmHost />
    </div>
  )
}
