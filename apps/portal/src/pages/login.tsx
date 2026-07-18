import { useState } from 'preact/hooks'
import { ApiError, currentAdmin, type PortalIdentity, post } from '../api.js'
import { navigate } from '../router.js'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: Event) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const me = await post<PortalIdentity>('/auth/login', { email, password })
      currentAdmin.value = me
      navigate('overview')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="login-wrap">
      <form class="login-card stack" onSubmit={submit}>
        <div class="logo">
          <span class="dot">H</span>Hippo <span class="sub">Partner Portal</span>
        </div>
        <label class="field">
          Email
          <input
            type="email"
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            required
          />
        </label>
        <label class="field">
          Password
          <input
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
            minLength={12}
          />
        </label>
        <button class="btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <div class="error">{error}</div>}
        <a href="#/claim" class="dim">
          Have an invite? Claim your account
        </a>
      </form>
    </div>
  )
}

export function ClaimPage() {
  const [token, setToken] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: Event) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await post<{ ok: true; email: string }>('/auth/claim', { token, password })
      setDone(res.email)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'claim failed')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div class="login-wrap">
        <div class="login-card stack">
          <div class="logo">
            <span class="dot">H</span>Hippo <span class="sub">Partner Portal</span>
          </div>
          <p>
            Account <strong>{done}</strong> is ready.
          </p>
          <a class="btn" href="#/login">
            Sign in
          </a>
        </div>
      </div>
    )
  }

  return (
    <div class="login-wrap">
      <form class="login-card stack" onSubmit={submit}>
        <div class="logo">
          <span class="dot">H</span>Hippo <span class="sub">Claim your account</span>
        </div>
        <label class="field">
          Invite token
          <input
            value={token}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
            required
            minLength={16}
          />
        </label>
        <label class="field">
          Choose a password (min 12 chars)
          <input
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
            minLength={12}
          />
        </label>
        <button class="btn" type="submit" disabled={busy}>
          {busy ? 'Claiming…' : 'Claim account'}
        </button>
        {error && <div class="error">{error}</div>}
        <a href="#/login" class="dim">
          Back to sign in
        </a>
      </form>
    </div>
  )
}
