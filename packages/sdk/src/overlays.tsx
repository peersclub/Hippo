/**
 * Full-surface overlays: the onboarding flow (baseline §5, the one hero
 * moment), the ⚙ settings sheet, and the ↗ share card (baseline §6).
 * These are the ONLY surfaces where backdrop-filter is allowed — the
 * full-surface exception to the solid-background rule.
 */
import type { ResearchBrief } from '@hippo/protocol'
import { useEffect, useRef, useState } from 'preact/hooks'
import { fileGlyph, SparklineSvg } from './cards.js'
import { filesOpen, filesView, type LibraryFile, loadFiles, relativeTime } from './files.js'
import { t } from './i18n.js'
import { signOutUplink } from './identity.js'
import { IdentityForm } from './identity-card.js'
import { consentRows, HERO_QUERIES, type OnboardingStore } from './onboarding.js'
import { dispatch } from './outbox.js'
import {
  type ClearMemoryEvent,
  type ClearMemoryState,
  clearLearnedMemoryUplink,
  clearMemoryTransition,
  groupLearnedFacts,
  LANGUAGE_OPTIONS,
  learnedMemoryOptInUplink,
  showLearnedFacts,
  showLearnedMemoryToggle,
} from './settings.js'
import { briefClipboardText, COPIED_FLASH_MS, shareCardView } from './share.js'
import {
  entitlements,
  glass,
  identityUsername,
  learnedFacts,
  learnedMemoryOptIn,
  locale,
  memoryOptIn,
  persistGlass,
  persistLocale,
  settingsOpen,
  shareFrame,
  venueName,
} from './state.js'
import { send } from './transport.js'

/** Feedback window on the learned-memory clear button: it disables briefly so
 * the tap registers, then the empty `learned_memory` frame the server sends
 * empties the whole section. Purely cosmetic — the server is authoritative. */
const LEARNED_CLEAR_FLASH_MS = 1200

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Dialog behavior for full-surface overlays: focus the first control on
 * mount, keep Tab cycling inside the card. NOTE: inside a closed shadow
 * root, document.activeElement only sees the host — the element's own
 * getRootNode() is the ShadowRoot whose activeElement is real.
 */
function useTrapFocus() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const focusables = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])'),
      ).filter((f) => !f.hasAttribute('disabled'))
    focusables()[0]?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) return
      const rootNode = el.getRootNode() as ShadowRoot | Document
      const active = rootNode.activeElement as HTMLElement | null
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first?.focus()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [])
  return ref
}

/** Hand-rolled confetti burst — one canvas, ~40 lines, no library. */
function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || reducedMotion()) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.offsetWidth
    const h = canvas.offsetHeight
    canvas.width = w
    canvas.height = h
    const colors = ['#F0B94A', '#2EC48D', '#FF8585', '#E9EBF0']
    const parts = Array.from({ length: 90 }, () => ({
      x: w / 2 + (Math.random() - 0.5) * 70,
      y: h * 0.45,
      vx: (Math.random() - 0.5) * 7,
      vy: -(2.5 + Math.random() * 7),
      s: 3 + Math.random() * 4,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      c: colors[Math.floor(Math.random() * colors.length)] as string,
    }))
    let frame = 0
    let raf = 0
    const tick = () => {
      ctx.clearRect(0, 0, w, h)
      for (const p of parts) {
        p.vy += 0.12
        p.x += p.vx
        p.y += p.vy
        p.r += p.vr
        ctx.save()
        ctx.globalAlpha = Math.max(0, 1 - frame / 150)
        ctx.translate(p.x, p.y)
        ctx.rotate(p.r)
        ctx.fillStyle = p.c
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.62)
        ctx.restore()
      }
      frame += 1
      if (frame < 150) raf = requestAnimationFrame(tick)
      else ctx.clearRect(0, 0, w, h)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas class="confetti" ref={ref} />
}

/** Glowing chat bar cycling real queries. Degrades to whole-query cycling
 * under prefers-reduced-motion. */
function Typewriter({ queries }: { queries: string[] }) {
  const [text, setText] = useState(() => (reducedMotion() ? (queries[0] ?? '') : ''))
  useEffect(() => {
    if (reducedMotion()) {
      let i = 0
      const t = setInterval(() => {
        i = (i + 1) % queries.length
        setText(queries[i] ?? '')
      }, 2600)
      return () => clearInterval(t)
    }
    let qi = 0
    let ci = 0
    let deleting = false
    let t = 0
    const step = () => {
      const q = queries[qi] ?? ''
      if (!deleting) {
        ci += 1
        setText(q.slice(0, ci))
        if (ci >= q.length) {
          deleting = true
          t = window.setTimeout(step, 1500)
          return
        }
        t = window.setTimeout(step, 46)
      } else {
        ci -= 1
        setText(q.slice(0, ci))
        if (ci <= 0) {
          deleting = false
          qi = (qi + 1) % queries.length
          t = window.setTimeout(step, 380)
          return
        }
        t = window.setTimeout(step, 22)
      }
    }
    t = window.setTimeout(step, 350)
    return () => clearTimeout(t)
  }, [queries])
  return (
    <div class="tybar" aria-hidden="true">
      <span>{text}</span>
      <span class="caret" />
    </div>
  )
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      class={`tgl${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span class="knob" />
    </button>
  )
}

function Dots({ step }: { step: number }) {
  return (
    <div class="obdots" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span class={i === step ? 'on' : ''} key={i} />
      ))}
    </div>
  )
}

export function OnboardingOverlay({
  store,
  onNotNow,
}: {
  store: OnboardingStore
  onNotNow: () => void
}) {
  const step = store.step.value
  const venue = venueName.value
  const rows = consentRows(venue)
  const [memory, setMemory] = useState(rows.find((r) => r.id === 'memory')?.defaultOn ?? true)
  const [l2Checked, setL2Checked] = useState(false)
  const notNow = () => {
    // Genuinely closes: nothing persisted, panel minimizes back to the pill.
    store.dismiss()
    onNotNow()
  }
  const agree = () => {
    memoryOptIn.value = memory
    const l2Row = rows.find((r) => r.id === 'l2')
    void dispatch({
      kind: 'consent',
      memoryOptIn: memory,
      l2Acknowledged: l2Row?.control === 'checkbox' ? l2Checked : true,
    })
    store.complete()
  }
  const cardRef = useTrapFocus()
  return (
    <div class="overlay">
      {step === 0 && <Confetti />}
      <div
        class="obcard"
        role="dialog"
        aria-modal="true"
        aria-label={t(locale.value, 'intro_dialog')}
        ref={cardRef}
      >
        {step === 0 && (
          <>
            <div class="obeyebrow">{t(locale.value, 'ob_welcome_to')}</div>
            <h2>{t(locale.value, 'ob_future_title')}</h2>
            <p>{t(locale.value, 'ob_tagline', { venue })}</p>
            <button type="button" class="obcta" onClick={() => store.next()}>
              {t(locale.value, 'ob_show_more')}
            </button>
          </>
        )}
        {step === 1 && (
          <>
            <span class="obmark">H</span>
            <h2>{t(locale.value, 'ob_ask_anything')}</h2>
            <Typewriter queries={HERO_QUERIES} />
            <button type="button" class="obcta" onClick={() => store.next()}>
              {t(locale.value, 'ob_next')}
            </button>
          </>
        )}
        {step === 2 && (
          <>
            <h2>{t(locale.value, 'ob_data_plain_words')}</h2>
            <div class="obrows">
              {/* Row titles/bodies are counsel-owned consent copy, authored in
                  one place and passed in — not catalog keys. See the note in
                  i18n.ts. */}
              {rows.map((r) => (
                <div class="obrow" key={r.id}>
                  <span class="obicon">{r.icon}</span>
                  <div>
                    <b>{r.title}</b>
                    <p>{r.body}</p>
                  </div>
                  {r.control === 'toggle' && (
                    <Toggle on={memory} onChange={setMemory} label={r.title} />
                  )}
                  {r.control === 'checkbox' && (
                    <input
                      type="checkbox"
                      class="obcheck"
                      checked={l2Checked}
                      aria-label={r.title}
                      onChange={(e) => setL2Checked((e.target as HTMLInputElement).checked)}
                    />
                  )}
                </div>
              ))}
            </div>
            <button type="button" class="obcta" onClick={() => store.next()}>
              {t(locale.value, 'ob_next')}
            </button>
          </>
        )}
        {step === 3 && (
          <>
            <h2>Ground rules</h2>
            <div class="obrows">
              <div class="obrow">
                <span class="obicon">◇</span>
                <div>
                  <b>Hippo explains, never advises</b>
                  <p>Anyone who gives trading calls inside a chat isn't on your side.</p>
                </div>
              </div>
              <div class="obrow">
                <span class="obicon">✓</span>
                <div>
                  <b>You stay in control</b>
                  <p>Nothing executes without your explicit confirm on {venue}.</p>
                </div>
              </div>
            </div>
            <button type="button" class="obcta" onClick={agree}>
              {t(locale.value, 'ob_agree_start')}
            </button>
          </>
        )}
        <Dots step={step} />
        <button type="button" class="obnotnow" onClick={notNow}>
          {t(locale.value, 'ob_not_now')}
        </button>
      </div>
    </div>
  )
}

/** One file row in the library — icon, name, size · date, status badge, and
 * the summary excerpt expandable on tap (only when there is one). */
function FileRow({ file }: { file: LibraryFile }) {
  const L = locale.value
  const [open, setOpen] = useState(false)
  const hasSummary = Boolean(file.summary)
  const badge =
    file.status === 'analyzed'
      ? t(L, 'upload_analyzed')
      : file.status === 'failed'
        ? t(L, 'upload_failed')
        : t(L, 'upload_analyzing')
  return (
    <div class={`filerow ${file.status}`}>
      <button
        type="button"
        class="filehd"
        aria-expanded={hasSummary ? open : undefined}
        disabled={!hasSummary}
        onClick={() => hasSummary && setOpen((v) => !v)}
      >
        <span class="fileicon" aria-hidden="true">
          {fileGlyph(file.kind)}
        </span>
        <span class="filemeta">
          <span class="filename">{file.name}</span>
          <span class="filesub">
            {file.sizeDisplay} · {relativeTime(file.createdAt)}
          </span>
        </span>
        <span class={`filebadge ${file.status}`}>{badge}</span>
      </button>
      {open && file.summary && <p class="filesummary">{file.summary}</p>}
      {file.status === 'failed' && file.reason && <p class="filereason">{file.reason}</p>}
    </div>
  )
}

/**
 * Files overlay — the WhatsApp-style library of everything this trader has
 * uploaded. Refetched on every open (server truth, no client cache): loading,
 * error (with retry), an honest empty state, or the newest-first list. Mirrors
 * the SettingsSheet overlay construction (focus trap, obcard sheet, ✕ close).
 */
export function FilesSheet() {
  const L = locale.value
  const view = filesView.value
  const cardRef = useTrapFocus()
  const close = () => {
    filesOpen.value = false
  }
  return (
    <div class="overlay">
      <div
        class="obcard sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t(L, 'files_open')}
        ref={cardRef}
      >
        <div class="shhd">
          <b>{t(L, 'files_title')}</b>
          <button type="button" aria-label={t(L, 'files_close')} onClick={close}>
            ✕
          </button>
        </div>
        {view.phase === 'loading' && (
          <div class="filestate" role="status">
            {t(L, 'files_loading')}
          </div>
        )}
        {view.phase === 'error' && (
          <div class="filestate err" role="status">
            <p>{t(L, 'files_error')}</p>
            <button type="button" class="shitem" onClick={() => void loadFiles()}>
              ↻ {t(L, 'files_retry')}
            </button>
          </div>
        )}
        {view.phase === 'list' && view.files.length === 0 && (
          <div class="filestate empty" role="status">
            {t(L, 'files_empty')}
          </div>
        )}
        {view.phase === 'list' && view.files.length > 0 && (
          <div class="filelist">
            {view.files.map((f) => (
              <FileRow file={f} key={f.fileId} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Share overlay (baseline §6) — a live, co-branded card, not a screenshot.
 * Renders entirely from the brief's frame data: the server's LIVE flag, the
 * server's headline, EVERY server paragraph. No short link is drawn (see
 * share.ts) and the copy action puts the brief's own prose on the clipboard,
 * never a fabricated address.
 */
export function ShareOverlay({ frame }: { frame: ResearchBrief }) {
  const L = locale.value
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const view = shareCardView(frame)
  const close = () => {
    shareFrame.value = null
  }
  const copy = () => {
    // Clipboard can be unavailable (permissions, non-secure host) — the
    // button simply doesn't confirm. Same text as the brief's ⧉ COPY.
    void navigator.clipboard?.writeText(briefClipboardText(frame)).catch(() => {})
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), COPIED_FLASH_MS)
  }
  const cardRef = useTrapFocus()
  return (
    <div class="overlay">
      <div
        class="shrcard"
        role="dialog"
        aria-modal="true"
        aria-label={t(L, 'share_card')}
        ref={cardRef}
      >
        <div class="shrbrand">
          <span class="shrmark">H</span>
          <b>Hippo</b>
          <span class="on">{t(L, 'share_on', { venue: venueName.value })}</span>
          {/* Same gate as the in-thread brief card: LIVE is the server's
              flag, so a stale brief never exports as live. */}
          {view.live && <span class="shrlive">● {t(L, 'badge_live')}</span>}
        </div>
        <h3>{view.headline}</h3>
        {/* The WHOLE brief travels — a caveat in paragraph 2 is part of the
            claim. A long brief scrolls inside the card; nothing is cut. */}
        <div class="shrprose">
          {view.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
        {frame.spark && <SparklineSvg points={frame.spark.points} />}
        <div class="shrfoot">
          <span>{frame.liveBar?.asOf}</span>
        </div>
        {/* NON-NEGOTIABLE: printed on the card itself so viral distribution
            never crosses the advice line (baseline §6). Do not remove. */}
        <div class="shrdisc">MARKET INFORMATION · NOT INVESTMENT ADVICE</div>
        <button type="button" class="obcta" onClick={copy}>
          {copied ? t(L, 'copied') : t(L, 'copy_brief')}
        </button>
        <button type="button" class="shrx" aria-label={t(L, 'close_share')} onClick={close}>
          ✕
        </button>
      </div>
    </div>
  )
}

/**
 * Identity in settings — signed in: the username + a Sign out action (the
 * server answers with a `signed_out` frame, which unbinds the sticky
 * username and flips this section back to the claim form). Not signed in:
 * the same claim/sign-in form as the first-run card. Sign-out goes straight
 * through transport `send` (never the outbox — an auth action fired minutes
 * later without the trader present would be wrong) and fails loud.
 */
function IdentitySection() {
  const L = locale.value
  const username = identityUsername.value
  const [signOutFailed, setSignOutFailed] = useState(false)
  const signOut = async () => {
    setSignOutFailed(false)
    const ok = await send(signOutUplink()).catch(() => false)
    if (!ok) setSignOutFailed(true)
  }
  if (!username) return <IdentityForm />
  return (
    <>
      <div class="obrow">
        <span class="obicon">◉</span>
        <div>
          <b>{t(L, 'id_signed_in_as', { username })}</b>
        </div>
        <button type="button" class="idout" onClick={() => void signOut()}>
          {t(L, 'id_sign_out')}
        </button>
      </div>
      {signOutFailed && (
        <div class="idmsg err" role="status">
          {t(L, 'action_failed')}
        </div>
      )}
    </>
  )
}

/**
 * ⚙ settings sheet (baseline §6): memory toggle + clear, the data rows
 * restated in plain language, answer language (with RTL preview via عربي),
 * and "Replay the intro". Language taps relabel the chrome instantly (the
 * locale signal) AND tell the server via the settings uplink — content
 * language stays a generation parameter, never client translation.
 */
export function SettingsSheet({ onReplay }: { onReplay: () => void }) {
  const L = locale.value
  const memory = memoryOptIn.value
  const [clear, setClear] = useState<ClearMemoryState>({ phase: 'idle' })
  const cardRef = useTrapFocus()
  const toggle = (v: boolean) => {
    memoryOptIn.value = v
    void dispatch({ kind: 'settings', memoryOptIn: v })
  }
  // Frosted-glass panel — pure client presentation (no uplink); persisted so
  // the trader's choice survives reloads, like locale.
  const glassOn = glass.value
  const pickLanguage = (opt: (typeof LANGUAGE_OPTIONS)[number]) => {
    locale.value = opt.locale
    persistLocale(opt.locale)
    void dispatch({ kind: 'settings', language: opt.uplink })
  }
  const clearEvt = (event: ClearMemoryEvent) => {
    const { state: next, uplink } = clearMemoryTransition(clear, event)
    setClear(next)
    if (uplink) void dispatch({ kind: 'settings', clearMemory: true })
  }
  // "What Hippo remembers about you" — the SECTION (with its "Remember my
  // preferences" toggle) shows whenever the plan grants memoryLab; the FACT
  // LIST additionally needs the server to have pushed facts.
  const showToggle = showLearnedMemoryToggle(entitlements.value)
  const learned = groupLearnedFacts(learnedFacts.value)
  // "Remember my preferences" — reflect the server's optIn, but show the tapped
  // state immediately for feedback until the next learned_memory frame confirms
  // it (we never persist the choice locally). `pending === signal` clears it.
  const optIn = learnedMemoryOptIn.value
  const [pendingOptIn, setPendingOptIn] = useState<boolean | null>(null)
  useEffect(() => {
    if (pendingOptIn !== null && pendingOptIn === optIn) setPendingOptIn(null)
  }, [optIn, pendingOptIn])
  const shownOptIn = pendingOptIn ?? optIn
  const showFacts = showLearnedFacts(entitlements.value, learnedFacts.value, shownOptIn)
  const toggleLearned = (v: boolean) => {
    setPendingOptIn(v)
    void dispatch(learnedMemoryOptInUplink(v))
  }
  const [clearingLearned, setClearingLearned] = useState(false)
  const clearLearned = () => {
    // Signal intent only — the server re-emits an empty learned_memory frame,
    // which empties the section. We never hand-clear the set client-side.
    setClearingLearned(true)
    void dispatch(clearLearnedMemoryUplink())
    window.setTimeout(() => setClearingLearned(false), LEARNED_CLEAR_FLASH_MS)
  }
  // Counsel-owned copy stays single-sourced: the same rows onboarding shows,
  // restated read-only (controls stripped) as the in-place data explainer.
  const rows = consentRows(venueName.value)
  return (
    <div class="overlay">
      <div
        class="obcard sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t(L, 'settings')}
        ref={cardRef}
      >
        <div class="shhd">
          <b>{t(L, 'settings')}</b>
          <button
            type="button"
            aria-label={t(L, 'close_settings')}
            onClick={() => {
              settingsOpen.value = false
            }}
          >
            ✕
          </button>
        </div>
        <div class="obrows">
          <div class="obrow">
            <span class="obicon">◎</span>
            <div>
              <b>{t(L, 'settings_memory_title')}</b>
              <p>{t(L, 'settings_memory_body')}</p>
            </div>
            <Toggle on={memory} onChange={toggle} label={t(L, 'settings_memory_title')} />
          </div>
          <div class="obrow">
            <span class="obicon">◇</span>
            <div>
              <b>{t(L, 'settings_glass_title')}</b>
              <p>{t(L, 'settings_glass_body')}</p>
            </div>
            <Toggle on={glassOn} onChange={persistGlass} label={t(L, 'settings_glass_title')} />
          </div>
          {rows
            .filter((r) => r.id !== 'memory')
            .map((r) => (
              <div class="obrow" key={r.id}>
                <span class="obicon">{r.icon}</span>
                <div>
                  <b>{r.title}</b>
                  <p>{r.body}</p>
                </div>
              </div>
            ))}
        </div>
        <div class="setlab">{t(L, 'id_section')}</div>
        <IdentitySection />
        <div class="setlab">{t(L, 'settings_language')}</div>
        <div class="langrow">
          {LANGUAGE_OPTIONS.map((opt) => (
            <button
              type="button"
              aria-pressed={L === opt.locale}
              class={`lang${L === opt.locale ? ' on' : ''}`}
              key={opt.locale}
              onClick={() => pickLanguage(opt)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {showToggle && (
          <div class="mem">
            <div class="setlab">{t(L, 'learned_memory_title')}</div>
            <div class="obrow">
              <span class="obicon">◎</span>
              <div>
                <b>{t(L, 'learned_toggle_title')}</b>
              </div>
              <Toggle
                on={shownOptIn}
                onChange={toggleLearned}
                label={t(L, 'learned_toggle_title')}
              />
            </div>
            {!shownOptIn && <p class="memoff">{t(L, 'learned_off')}</p>}
            {showFacts && (
              <>
                {learned.remembered.length > 0 && (
                  <div class="memgrp">
                    <div class="memgrplab">{t(L, 'learned_group_remembered')}</div>
                    <div class="memfacts">
                      {learned.remembered.map((f) => (
                        <span class="memfact" key={`${f.type}:${f.value}`}>
                          {f.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {learned.session.length > 0 && (
                  <div class="memgrp">
                    <div class="memgrplab">{t(L, 'learned_group_session')}</div>
                    <div class="memfacts">
                      {learned.session.map((f) => (
                        <span class="memfact" key={`${f.type}:${f.value}`}>
                          {f.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  class="shitem danger"
                  disabled={clearingLearned}
                  onClick={clearLearned}
                >
                  ⌫ {t(L, 'learned_clear')}
                </button>
              </>
            )}
          </div>
        )}
        {clear.phase === 'idle' && (
          <button type="button" class="shitem" onClick={() => clearEvt({ type: 'request' })}>
            ⌫ {t(L, 'clear_memory')}
          </button>
        )}
        {clear.phase === 'confirming' && (
          <div class="confirmrow">
            <button
              type="button"
              class="shitem danger"
              onClick={() => clearEvt({ type: 'confirm' })}
            >
              {t(L, 'clear_memory_confirm')}
            </button>
            <button type="button" class="shitem" onClick={() => clearEvt({ type: 'cancel' })}>
              {t(L, 'clear_memory_cancel')}
            </button>
          </div>
        )}
        {clear.phase === 'done' && (
          <div class="cleared" role="status">
            {t(L, 'clear_memory_done')}
          </div>
        )}
        <button type="button" class="shitem" onClick={onReplay}>
          ↺ {t(L, 'ob_replay')}
        </button>
      </div>
    </div>
  )
}
