/**
 * Hash router in ~30 lines — no dependency. Routes are '#/partners',
 * '#/users/:partnerId/:userId', etc. `route` is a signal; pages re-render
 * on hashchange.
 */
import { signal } from '@preact/signals'

export type Route = { page: string; params: string[] }

function parse(): Route {
  const hash = location.hash.replace(/^#\/?/, '')
  const [page = 'dashboard', ...params] = hash.split('/').map(decodeURIComponent)
  return { page: page || 'dashboard', params }
}

export const route = signal<Route>(parse())

window.addEventListener('hashchange', () => {
  route.value = parse()
})

export function navigate(to: string): void {
  location.hash = to.startsWith('#') ? to : `#/${to}`
}
