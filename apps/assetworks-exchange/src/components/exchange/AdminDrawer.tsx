"use client"

import { X } from "lucide-react"
import { setConfig } from "@/lib/venue/client"
import type { ConfirmSurface } from "@/lib/venue/types"
import { useExchange } from "@/store/exchange"

export function AdminDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useExchange((s) => s.config)

  const surfaces: { v: ConfirmSurface; t: string; d: string }[] = [
    { v: "api", t: "API — Hippo places directly", d: "The parasite confirms in its own panel and places with the scoped key. The order appears here after placement." },
    { v: "js_callback", t: "Host confirm modal (js_callback)", d: "The parasite hands off; THIS host renders the confirm dialog; we place on your approval." },
  ]

  return (
    <>
      <div onClick={onClose} className={`fixed inset-0 z-40 bg-black/30 transition-opacity ${open ? "opacity-100" : "pointer-events-none opacity-0"}`} />
      <div className={`fixed right-0 top-0 bottom-0 z-50 flex w-[340px] flex-col border-l border-aw-border bg-aw-bg-primary transition-transform ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-center justify-between border-b border-aw-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-bold"><span className="grid h-5 w-5 place-items-center rounded bg-aw-brand-primary text-[11px] font-extrabold text-aw-bg-primary">A</span>Venue admin</div>
          <button type="button" onClick={onClose} className="text-aw-text-tertiary"><X size={16} /></button>
        </div>
        <div className="flex flex-col gap-5 overflow-y-auto p-4">
          <div>
            <h6 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-aw-text-tertiary">Confirm surface <span className="text-aw-text-light">(Open Decision #6)</span></h6>
            <div className="flex flex-col gap-2">
              {surfaces.map((s) => {
                const on = config?.confirmSurface === s.v
                return (
                  <button key={s.v} type="button" onClick={() => setConfig({ confirmSurface: s.v })} className={`rounded-aw-lg border p-3 text-left ${on ? "border-aw-brand-accent bg-aw-accent-soft" : "border-aw-border"}`}>
                    <div className="text-[13px] font-semibold text-aw-text-primary">{s.t}</div>
                    <div className="mt-0.5 text-[11px] text-aw-text-tertiary">{s.d}</div>
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <h6 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-aw-text-tertiary">Fill behaviour</h6>
            <label className="mb-3 flex items-center justify-between text-[13px] font-medium text-aw-text-secondary">
              Partial fills
              <input type="checkbox" checked={!!config?.partialFills} onChange={(e) => setConfig({ partialFills: e.target.checked })} />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-aw-text-tertiary">
              Working window (ms) — ≥ 2000
              <input type="number" step={250} defaultValue={config?.workingWindowMs ?? 2500} onBlur={(e) => setConfig({ workingWindowMs: +e.target.value })} className="rounded-aw-lg border border-aw-border bg-aw-bg-primary px-2.5 py-2 font-mono text-[13px] text-aw-text-primary" />
            </label>
          </div>
          <p className="text-[11px] text-aw-text-light">The parasite reads this switch live from <code>/admin/config</code> at confirm time — no redeploy.</p>
        </div>
      </div>
    </>
  )
}
