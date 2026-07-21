/**
 * Full-surface overlays: the onboarding flow (baseline §5, the one hero
 * moment), the ⚙ settings sheet, and the ↗ share card (baseline §6).
 * These are the ONLY surfaces where backdrop-filter is allowed — the
 * full-surface exception to the solid-background rule.
 */
import type { ResearchBrief } from '@hippo/protocol'
import { useEffect, useRef, useState } from 'preact/hooks'
import { SparklineSvg } from './cards.js'
import { t } from './i18n.js'
import { consentRows, HERO_QUERIES, type OnboardingStore } from './onboarding.js'
import { dispatch } from './outbox.js'
import {
  type ClearMemoryEvent,
  type ClearMemoryState,
  clearMemoryTransition,
  LANGUAGE_OPTIONS,
} from './settings.js'
import { COPIED_FLASH_MS, shareLink } from './share.js'
import {
  glass,
  locale,
  memoryOptIn,
  persistGlass,
  persistLocale,
  settingsOpen,
  shareFrame,
  venueName,
} from './state.js'

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
            <div class="obeyebrow">WELCOME TO</div>
            <h2>The Future of Trading</h2>
            <p>Hippo — your conversational trading agent, built for {venue}.</p>
            <button type="button" class="obcta" onClick={() => store.next()}>
              Show me more
            </button>
          </>
        )}
        {step === 1 && (
          <>
            <span class="obmark">H</span>
            <h2>Ask your market anything.</h2>
            <Typewriter queries={HERO_QUERIES} />
            <button type="button" class="obcta" onClick={() => store.next()}>
              Next
            </button>
          </>
        )}
        {step === 2 && (
          <>
            <h2>Your data, in plain words</h2>
            <div class="obrows">
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
              Next
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

/**
 * Share overlay (baseline §6) — a live, co-branded card, not a screenshot.
 * Renders entirely from the brief's frame data; the short link is a
 * placeholder until the share backend exists.
 */
export function ShareOverlay({ frame }: { frame: ResearchBrief }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const link = shareLink(frame.id)
  const close = () => {
    shareFrame.value = null
  }
  const copy = () => {
    // Clipboard can be unavailable (permissions, non-secure host) — the
    // link stays visible on the card either way.
    void navigator.clipboard?.writeText(link).catch(() => {})
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
        aria-label={t(locale.value, 'share_card')}
        ref={cardRef}
      >
        <div class="shrbrand">
          <span class="shrmark">H</span>
          <b>Hippo</b>
          <span class="on">on {venueName.value}</span>
          <span class="shrlive">● LIVE</span>
        </div>
        <h3>{frame.headline}</h3>
        {frame.paragraphs[0] && <p>{frame.paragraphs[0]}</p>}
        {frame.spark && <SparklineSvg points={frame.spark.points} />}
        <div class="shrfoot">
          <span>{frame.liveBar?.asOf}</span>
          <span class="lnk">{link}</span>
        </div>
        {/* NON-NEGOTIABLE: printed on the card itself so viral distribution
            never crosses the advice line (baseline §6). Do not remove. */}
        <div class="shrdisc">MARKET INFORMATION · NOT INVESTMENT ADVICE</div>
        <button type="button" class="obcta" onClick={copy}>
          {copied ? 'COPIED ✓' : 'Copy link'}
        </button>
        <button
          type="button"
          class="shrx"
          aria-label={t(locale.value, 'close_share')}
          onClick={close}
        >
          ✕
        </button>
      </div>
    </div>
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
