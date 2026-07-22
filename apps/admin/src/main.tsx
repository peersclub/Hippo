/**
 * Admin panel shell: login gate → sidebar layout → hash-routed pages.
 */
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
import { PlansPage } from './pages/plans.js'
import { SessionsPage } from './pages/sessions.js'
import { UserDetailPage, UsersPage } from './pages/users.js'
import { navigate, route } from './router.js'
import { ConfirmHost, Toasts } from './ui.js'

const NAV = [
  ['dashboard', 'Dashboard'],
  ['partners', 'Partners'],
  ['plans', 'Plans'],
  ['users', 'Users'],
  ['sessions', 'Sessions'],
  ['memory', 'Memory'],
  ['memory-config', 'Memory Config'],
  ['operators', 'Operators'],
  ['audit', 'Audit'],
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
    // Resume an existing cookie session on load.
    get<{ email: string; role: 'owner' | 'operator' }>('/auth/me')
      .then((me) => {
        currentOperator.value = me
      })
      .catch(() => {
        currentOperator.value = null
        navigate('login')
      })
  }, [])

  if (!op) return <LoginPage />

  return (
    <div class="layout">
      <aside class="sidebar">
        <div class="logo">
          <span class="dot">H</span>Hippo <span class="sub">Admin</span>
        </div>
        <nav class="nav">
          {NAV.map(([key, label]) => (
            <a key={key} href={`#/${key}`} class={page === key ? 'on' : ''}>
              {label}
            </a>
          ))}
        </nav>
        <div class="foot">
          <div>{op.email}</div>
          <div class="dim">{op.role}</div>
          <button
            type="button"
            onClick={() => {
              void post('/auth/logout').finally(() => {
                currentOperator.value = null
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
