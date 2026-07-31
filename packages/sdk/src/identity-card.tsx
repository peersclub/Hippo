/**
 * Identity surfaces — the first-run "claim a username" card (panel chrome)
 * and the claim/sign-in form the settings sheet shares. Pure-logic siblings
 * live in identity.ts; everything here only draws and sends.
 *
 * The PIN never exists outside component state and the uplink body: masked
 * boxes (type=password), autocomplete off, and nothing here ever logs it.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { t } from './i18n.js'
import {
  type IdentityMode,
  type IdentityStatus,
  identityClaimUplink,
  PIN_LENGTH,
  statusMessageKey,
  validateClaim,
} from './identity.js'
import { identityFirstRunDismissed, identityStatus, identityUsername, locale } from './state.js'
import { send } from './transport.js'

/** Four masked digit boxes — inputmode numeric, focus advances on entry,
 * Backspace on an empty box steps back. Value is the joined digit string. */
function PinInput({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const L = locale.value
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const setDigit = (i: number, raw: string) => {
    const d = raw.replace(/\D/g, '').slice(-1)
    const chars = value.split('')
    while (chars.length < i) chars.push('')
    chars[i] = d
    onChange(chars.join('').slice(0, PIN_LENGTH))
    if (d && i < PIN_LENGTH - 1) refs.current[i + 1]?.focus()
  }
  return (
    <div class="pinrow">
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          class="pinbox"
          type="password"
          inputMode="numeric"
          autocomplete="off"
          maxLength={1}
          value={value[i] ?? ''}
          disabled={disabled}
          aria-label={`${t(L, 'id_pin_label')} ${i + 1}/${PIN_LENGTH}`}
          onInput={(e) => setDigit(i, (e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !(e.target as HTMLInputElement).value && i > 0) {
              refs.current[i - 1]?.focus()
            }
          }}
        />
      ))}
    </div>
  )
}

/**
 * The claim/sign-in form. Validates locally against the uplink regexes (an
 * invalid claim never leaves the panel), then waits for the server's
 * `identity` frame — every status renders: ok flips the host surface to its
 * signed-in state (via the sticky identityUsername signal + onSignedIn),
 * taken/wrong_pin/invalid report inline (server `note` wins over chrome
 * copy), and rate_limited disables submit with a countdown-free line until
 * the trader edits a field (a fresh try — the server stays the limiter).
 */
export function IdentityForm({ onSignedIn }: { onSignedIn?: (username: string) => void }) {
  const L = locale.value
  const [mode, setMode] = useState<IdentityMode>('create')
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState(false) // failed LOCAL validation
  const [sendFailed, setSendFailed] = useState(false)
  // The server status shown by THIS form — set only in response to our own
  // submit, so a stale frame from a previous attempt can't haunt a fresh open.
  const [serverStatus, setServerStatus] = useState<IdentityStatus | null>(null)
  const awaiting = useRef(false)
  const frame = identityStatus.value
  useEffect(() => {
    if (!awaiting.current || !frame) return
    awaiting.current = false
    setBusy(false)
    setServerStatus(frame.status)
    if (frame.status === 'ok') onSignedIn?.(frame.username ?? username)
  }, [frame])
  const locked = serverStatus === 'rate_limited'
  const edited = () => {
    setInvalid(false)
    setSendFailed(false)
    if (serverStatus !== null) setServerStatus(null)
  }
  const submit = async (e?: Event) => {
    e?.preventDefault()
    if (busy || locked) return
    const u = username.trim()
    if (!validateClaim(u, pin)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setSendFailed(false)
    setBusy(true)
    awaiting.current = true
    const ok = await send(identityClaimUplink(mode, u, pin))
    if (!ok) {
      awaiting.current = false
      setBusy(false)
      setSendFailed(true)
    }
  }
  const statusKey = serverStatus === 'ok' ? null : statusMessageKey(serverStatus)
  const note = statusKey && frame?.status === serverStatus ? frame?.note : undefined
  return (
    <form class="idform" onSubmit={submit}>
      <div class="idmodes">
        {(['create', 'signin'] as const).map((m) => (
          <button
            type="button"
            key={m}
            class={`idmode${mode === m ? ' on' : ''}`}
            aria-pressed={mode === m}
            onClick={() => {
              setMode(m)
              edited()
            }}
          >
            {t(L, m === 'create' ? 'id_mode_create' : 'id_mode_signin')}
          </button>
        ))}
      </div>
      <label class="dfield">
        <span class="dlab">{t(L, 'id_username_label')}</span>
        <input
          type="text"
          value={username}
          maxLength={24}
          autocomplete="off"
          spellcheck={false}
          disabled={busy}
          onInput={(e) => {
            setUsername((e.target as HTMLInputElement).value)
            edited()
          }}
        />
      </label>
      <div class="dfield">
        <span class="dlab">{t(L, 'id_pin_label')}</span>
        <PinInput
          value={pin}
          disabled={busy}
          onChange={(v) => {
            setPin(v)
            edited()
          }}
        />
      </div>
      {invalid && <div class="idmsg err">{t(L, 'id_invalid')}</div>}
      {statusKey && (
        <div class="idmsg err" role="status">
          {note ?? t(L, statusKey)}
        </div>
      )}
      {sendFailed && (
        <div class="idmsg err" role="status">
          {t(L, 'action_failed')}
        </div>
      )}
      <button type="submit" class="obcta" disabled={busy || locked} aria-busy={busy}>
        {busy
          ? t(L, 'id_checking')
          : t(L, mode === 'create' ? 'id_submit_create' : 'id_submit_signin')}
      </button>
    </form>
  )
}

/**
 * First-run nudge — shown until an `ok` identity binds this session OR the
 * trader dismisses it (session-scoped signal; it re-offers next visit). A
 * claim completed FROM this card holds a success row until dismissed, so the
 * moment lands instead of the card just vanishing.
 */
export function IdentityFirstRunCard() {
  const L = locale.value
  const [open, setOpen] = useState(false)
  const [claimed, setClaimed] = useState<string | null>(null)
  if (identityFirstRunDismissed.value) return null
  const dismiss = () => {
    identityFirstRunDismissed.value = true
  }
  if (claimed) {
    return (
      <div class="idcard ok" role="status">
        <span>{t(L, 'id_signed_in_as', { username: claimed })} ✓</span>
        <button type="button" class="idx" aria-label={t(L, 'dismiss')} onClick={dismiss}>
          ✕
        </button>
      </div>
    )
  }
  // Already signed in (resumed/claimed elsewhere) — nothing to nudge about.
  if (identityUsername.value) return null
  return (
    <div class="idcard">
      <div class="idhead">
        <b>{t(L, 'id_firstrun_title')}</b>
        <button type="button" class="idx" aria-label={t(L, 'dismiss')} onClick={dismiss}>
          ✕
        </button>
      </div>
      {open ? (
        <IdentityForm onSignedIn={(u) => setClaimed(u)} />
      ) : (
        <button type="button" class="idcta" onClick={() => setOpen(true)}>
          {t(L, 'id_firstrun_cta')}
        </button>
      )}
    </div>
  )
}
