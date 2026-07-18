/**
 * Partner portal shell: login/claim gate → sidebar layout → hash-routed
 * pages. Everything rendered here is already scoped to the signed-in
 * partner by the service — the SPA never handles a partner id.
 */
import { render } from 'preact'
import { useEffect } from 'preact/hooks'
import { currentAdmin, get, type PortalIdentity, post } from './api.js'
import { AuditPage } from './pages/audit.js'
import { IntegrationPage } from './pages/integration.js'
import { ClaimPage, LoginPage } from './pages/login.js'
import { OverviewPage } from './pages/overview.js'
import { PlanPage } from './pages/plan.js'
import { UsersPage } from './pages/users.js'
import { navigate, route } from './router.js'
import { ConfirmHost, Toasts } from './ui.js'

const NAV = [
  ['overview', 'Overview'],
  ['users', 'Users'],
  ['integration', 'Integration'],
  ['plan', 'Plan'],
  ['audit', 'Activity'],
] as const

function Page() {
  switch (route.value.page) {
    case 'users':
      return <UsersPage />
    case 'integration':
      return <IntegrationPage />
    case 'plan':
      return <PlanPage />
    case 'audit':
      return <AuditPage />
    default:
      return <OverviewPage />
  }
}

function Shell() {
  const { page } = route.value
  const admin = currentAdmin.value

  useEffect(() => {
    // Resume an existing cookie session on load.
    get<PortalIdentity>('/auth/me')
      .then((me) => {
        currentAdmin.value = me
      })
      .catch(() => {
        currentAdmin.value = null
        if (route.value.page !== 'claim') navigate('login')
      })
  }, [])

  if (!admin) return page === 'claim' ? <ClaimPage /> : <LoginPage />

  return (
    <div class="layout">
      <aside class="sidebar">
        <div class="logo">
          <span class="dot">H</span>Hippo <span class="sub">{admin.venueName}</span>
        </div>
        <nav class="nav">
          {NAV.map(([key, label]) => (
            <a key={key} href={`#/${key}`} class={page === key ? 'on' : ''}>
              {label}
            </a>
          ))}
        </nav>
        <div class="foot">
          <div>{admin.email}</div>
          <div class="dim">{admin.role === 'admin' ? 'admin' : 'read-only'}</div>
          <button
            type="button"
            onClick={() => {
              void post('/auth/logout').finally(() => {
                currentAdmin.value = null
                navigate('login')
              })
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main class="main">
        <Page />
      </main>
      <Toasts />
      <ConfirmHost />
    </div>
  )
}

const root = document.getElementById('root')
if (root) render(<Shell />, root)
