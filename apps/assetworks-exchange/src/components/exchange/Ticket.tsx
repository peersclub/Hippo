"use client"

import { useState } from "react"
import { AWButton, AWCard, AWSegmented } from "@/components/ui/assetworks-ui"
import { fmt } from "@/lib/format"
import { placeOrder } from "@/lib/venue/client"
import { useExchange } from "@/store/exchange"

export function Ticket() {
  const { ticket, patchTicket, lastPrice, pair } = useExchange()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const perp = ticket.market === "perp"
  const limit = ticket.kind === "limit"
  const buy = ticket.side === "buy"
  const px = limit ? ticket.limitPrice ?? lastPrice : lastPrice
  const estVal = (ticket.qty || 0) * (px || 0)

  const submit = async () => {
    if (!ticket.qty || !lastPrice) return
    setBusy(true)
    setErr(null)
    const r = await placeOrder({ ...ticket, pair }, lastPrice)
    if (!r.ok) setErr(r.error ?? "rejected")
    setBusy(false)
  }

  const field = "rounded-aw-lg border border-aw-border bg-aw-bg-primary px-2.5 py-2 font-mono text-[13px] text-aw-text-primary focus:border-aw-brand-accent focus:outline-none"

  return (
    <AWCard title="Order ticket">
      <div className="flex flex-col gap-2.5 overflow-y-auto p-3.5">
        <AWSegmented value={ticket.market} onChange={(v) => patchTicket({ market: v })} options={[{ value: "spot", label: "Spot" }, { value: "perp", label: "Futures" }]} />
        <AWSegmented value={ticket.side} onChange={(v) => patchTicket({ side: v })} tone={(v) => (v === "buy" ? "up" : "down")} options={[{ value: "buy", label: perp ? "Long" : "Buy" }, { value: "sell", label: perp ? "Short" : "Sell" }]} />
        <AWSegmented value={ticket.kind} onChange={(v) => patchTicket({ kind: v })} options={[{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }]} />

        <label className="flex flex-col gap-1 text-[11px] font-medium text-aw-text-tertiary">
          Size (base)
          <input className={field} type="number" step="0.0001" value={ticket.qty} onChange={(e) => patchTicket({ qty: +e.target.value })} />
        </label>

        {limit && (
          <label className="flex flex-col gap-1 text-[11px] font-medium text-aw-text-tertiary">
            Limit price
            <input className={field} type="number" step="0.01" value={ticket.limitPrice ?? ""} onChange={(e) => patchTicket({ limitPrice: +e.target.value })} />
          </label>
        )}

        {perp && (
          <>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-aw-text-tertiary">
              Leverage <span className="font-mono text-aw-text-primary">{ticket.leverage}x</span>
              <input type="range" min={1} max={50} value={ticket.leverage} onChange={(e) => patchTicket({ leverage: +e.target.value })} style={{ accentColor: "var(--aw-brand-accent)" }} />
            </label>
            <AWSegmented value={ticket.marginMode} onChange={(v) => patchTicket({ marginMode: v })} options={[{ value: "isolated", label: "Isolated" }, { value: "cross", label: "Cross" }]} />
            <label className="flex items-center justify-between text-[12px] font-medium text-aw-text-secondary">
              Reduce only
              <input type="checkbox" checked={ticket.reduceOnly} onChange={(e) => patchTicket({ reduceOnly: e.target.checked })} />
            </label>
          </>
        )}

        <div className="flex justify-between pt-0.5 text-xs text-aw-text-tertiary">
          {perp ? "Notional" : "Est. value"} <b className="font-mono text-aw-text-primary">{estVal ? `${fmt(estVal)} USDT` : "—"}</b>
        </div>
        {perp && (
          <div className="flex justify-between text-xs text-aw-text-tertiary">
            Margin <b className="font-mono text-aw-text-primary">{estVal ? `${fmt(estVal / ticket.leverage)} USDT` : "—"}</b>
          </div>
        )}
        {err && <div className="rounded-aw-md bg-aw-down/10 px-2 py-1.5 text-[11px] text-aw-down">{err}</div>}
        <AWButton variant={buy ? "up" : "down"} disabled={busy || !lastPrice} onClick={submit}>
          {busy ? "Placing…" : `Place ${buy ? (perp ? "Long" : "Buy") : perp ? "Short" : "Sell"}`}
        </AWButton>
      </div>
    </AWCard>
  )
}
