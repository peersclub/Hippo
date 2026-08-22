/**
 * Hash router — no dependency. Routes are '#/partners',
 * '#/users/:partnerId/:userId', etc. `route` is a signal; pages re-render
 * on hashchange.
 */
import { type Signal, signal } from '@preact/signals'

export type Route = { page: string; params: string[] }

export type HashRouter = {
  route: Signal<Route>
  navigate: (to: string) => void
}

function parse(defaultPage: string): Route {
  const hash = location.hash.replace(/^#\/?/, '')
  const [page = defaultPage, ...params] = hash.split('/').map(decodeURIComponent)
  return { page: page || defaultPage, params }
}

export function createHashRouter(defaultPage: string): HashRouter {
  const route = signal<Route>(parse(defaultPage))

  window.addEventListener('hashchange', () => {
    route.value = parse(defaultPage)
  })

  function navigate(to: string): void {
    location.hash = to.startsWith('#') ? to : `#/${to}`
  }

  return { route, navigate }
}
