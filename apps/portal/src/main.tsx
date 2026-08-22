/**
 * Partner portal shell: login/claim gate → sidebar layout → hash-routed
 * pages. Everything rendered here is already scoped to the signed-in
 * partner by the service — the SPA never handles a partner id.
 */
import { AppShell } from '@hippo/ui'
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

import '@hippo/ui/spa.css'

const NAV = [
  { key: 'overview', label: 'Overview' },
  { key: 'users', label: 'Users' },
  { key: 'integration', label: 'Integration' },
  { key: 'plan', label: 'Plan' },
  { key: 'audit', label: 'Activity' },
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
    <AppShell
      sub={admin.venueName}
      nav={NAV}
      page={page}
      email={admin.email}
      role={admin.role === 'admin' ? 'admin' : 'read-only'}
      onSignOut={() => {
        void post('/auth/logout').finally(() => {
          currentAdmin.value = null
          navigate('login')
        })
      }}
    >
      <Page />
    </AppShell>
  )
}

const root = document.getElementById('root')
if (root) render(<Shell />, root)
