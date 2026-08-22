/**
 * Admin panel shell: login gate → sidebar layout → hash-routed pages.
 */
import { AppShell } from '@hippo/ui'
import { render } from 'preact'
import { useEffect } from 'preact/hooks'
import { currentOperator, get, post } from './api.js'
import { AuditPage } from './pages/audit.js'
import { DashboardPage } from './pages/dashboard.js'
import { LoginPage } from './pages/login.js'
import { MemoryConfigPage } from './pages/memory-config.js'
import { OperatorsPage } from './pages/operators.js'
import { PartnerDetailPage } from './pages/partner-detail.js'
import { PartnersPage } from './pages/partners.js'
import { PilotPage } from './pages/pilot.js'
import { PlansPage } from './pages/plans.js'
import { SessionsPage } from './pages/sessions.js'
import { TechPage } from './pages/tech.js'
import { UserDetailPage, UsersPage } from './pages/users.js'
import { navigate, route } from './router.js'

import '@hippo/ui/spa.css'

const NAV = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'pilot', label: 'Pilot' },
  { key: 'partners', label: 'Partners' },
  { key: 'plans', label: 'Plans' },
  { key: 'users', label: 'Users' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'tech', label: 'Tech' },
  { key: 'memory', label: 'Memory' },
  { key: 'memory-config', label: 'Memory Config' },
  { key: 'operators', label: 'Operators' },
  { key: 'audit', label: 'Audit' },
] as const

function Page() {
  const { page, params } = route.value
  switch (page) {
    case 'partners':
      return params.length >= 1 ? (
        <PartnerDetailPage partnerId={params[0] ?? ''} />
      ) : (
        <PartnersPage />
      )
    case 'plans':
      return <PlansPage />
    case 'operators':
      return <OperatorsPage />
    case 'users':
      return params.length >= 2 ? (
        <UserDetailPage partnerId={params[0] ?? ''} userId={params[1] ?? ''} />
      ) : (
        <UsersPage mode="users" />
      )
    case 'sessions':
      return <SessionsPage />
    case 'pilot':
      return <PilotPage />
    case 'tech':
      return <TechPage />
    case 'memory':
      return <UsersPage mode="memory" />
    case 'memory-config':
      return <MemoryConfigPage />
    case 'audit':
      return <AuditPage />
    default:
      return <DashboardPage />
  }
}

function Shell() {
  const { page } = route.value
  const op = currentOperator.value

  useEffect(() => {
    get<{ email: string; role: 'owner' | 'operator' }>('/auth/me')
      .then((me) => {
        currentOperator.value = me
      })
      .catch(() => {
        currentOperator.value = null
        navigate('login')
      })
  }, [])

  useEffect(() => {
    if (op && page === 'login') navigate('dashboard')
  }, [op, page])

  if (!op) return <LoginPage />

  return (
    <AppShell
      sub="Admin"
      nav={NAV}
      page={page}
      email={op.email}
      role={op.role}
      onSignOut={() => {
        void post('/auth/logout').finally(() => {
          currentOperator.value = null
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
