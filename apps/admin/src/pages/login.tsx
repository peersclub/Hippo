import { useState } from 'preact/hooks'
import { ApiError, currentOperator, type Operator, post } from '../api.js'
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
      const me = await post<Operator>('/auth/login', { email, password })
      currentOperator.value = me
      navigate('dashboard')
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
          <span class="dot">H</span>Hippo <span class="sub">Admin</span>
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
            minLength={8}
          />
        </label>
        <button class="btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <div class="error">{error}</div>}
      </form>
    </div>
  )
}
