/**
 * Full-surface overlays: the onboarding flow (baseline §5, the one hero
 * moment) and the ⚙ settings sheet. These are the ONLY surfaces where
 * backdrop-filter is allowed — the full-surface exception to the solid-
 * background rule.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { consentRows, HERO_QUERIES, type OnboardingStore } from './onboarding.js'
import { memoryOptIn, settingsOpen, venueName } from './state.js'
import { send } from './transport.js'

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

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
    void send({
      kind: 'consent',
      memoryOptIn: memory,
      l2Acknowledged: l2Row?.control === 'checkbox' ? l2Checked : true,
    })
    store.complete()
  }
  return (
    <div class="overlay">
      {step === 0 && <Confetti />}
      <div class="obcard">
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
              Agree &amp; start
            </button>
          </>
        )}
        <Dots step={step} />
        <button type="button" class="obnotnow" onClick={notNow}>
          Not now
        </button>
      </div>
    </div>
  )
}

/** Minimal ⚙ settings sheet: memory toggle + "Replay the intro". */
export function SettingsSheet({ onReplay }: { onReplay: () => void }) {
  const memory = memoryOptIn.value
  const toggle = (v: boolean) => {
    memoryOptIn.value = v
    void send({ kind: 'settings', memoryOptIn: v })
  }
  return (
    <div class="overlay">
      <div class="obcard sheet">
        <div class="shhd">
          <b>SETTINGS</b>
          <button
            type="button"
            aria-label="Close settings"
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
              <b>Personal memory</b>
              <p>Hippo remembers your preferences and past questions.</p>
            </div>
            <Toggle on={memory} onChange={toggle} label="Personal memory" />
          </div>
        </div>
        <button type="button" class="shitem" onClick={onReplay}>
          ↺ Replay the intro
        </button>
      </div>
    </div>
  )
}
