"use client"

import { AWCard } from "@/components/ui/assetworks-ui"
import { fmtPx } from "@/lib/format"
import { useExchange } from "@/store/exchange"

export function Tape() {
  const trades = useExchange((s) => s.trades)
  return (
    <AWCard title="Trades">
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[11.5px]">
        {trades.map((t, i) => (
          <div key={`${t.t}-${i}`} className="flex justify-between px-3.5 py-[3px]">
            <span style={{ color: t.sell ? "var(--aw-down)" : "var(--aw-up)" }}>{fmtPx(t.price)}</span>
            <span className="text-aw-text-tertiary">{t.qty.toFixed(4)}</span>
            <span className="text-aw-text-light">{new Date(t.t).toLocaleTimeString("en-US", { hour12: false })}</span>
          </div>
        ))}
      </div>
    </AWCard>
  )
}
