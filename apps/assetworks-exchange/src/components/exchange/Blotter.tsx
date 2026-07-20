"use client"

import { useState } from "react"
import { AWCard } from "@/components/ui/assetworks-ui"
import { fmt, fmtPx, fmtSigned } from "@/lib/format"
import { cancelOrder } from "@/lib/venue/client"
import { ORDER_STATUS_LABEL } from "@/lib/venue/types"
import { useExchange } from "@/store/exchange"

type Tab = "orders" | "positions" | "balances"

export function Blotter() {
  const { orders, positions, balances, lastPrice } = useExchange()
  const [tab, setTab] = useState<Tab>("orders")
  const open = orders.filter((o) => o.status === 10 || o.status === 30)

  const th = "sticky top-0 bg-aw-panel px-3 py-1.5 text-left text-[10.5px] font-medium uppercase tracking-wide text-aw-text-light"
  const td = "border-t border-aw-border-light px-3 py-1.5 font-mono text-[12px]"

  return (
    <AWCard>
      <div className="flex gap-4 px-4">
        {(["orders", "positions", "balances"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`border-b-2 py-2.5 text-xs font-semibold capitalize ${tab === t ? "border-aw-brand-accent text-aw-text-primary" : "border-transparent text-aw-text-tertiary"}`}
          >
            {t === "orders" ? "Open orders" : t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {tab === "orders" &&
          (open.length ? (
            <table className="w-full border-collapse">
              <thead><tr><th className={th}>ID</th><th className={th}>Pair</th><th className={th}>Type</th><th className={th}>Side</th><th className={th}>Qty</th><th className={th}>Price</th><th className={th}>Status</th><th className={th} /></tr></thead>
              <tbody>
                {open.map((o) => {
                  const [lbl] = ORDER_STATUS_LABEL[o.status] ?? ["?"]
                  const sell = o.side === "sell"
                  return (
                    <tr key={o.id}>
                      <td className={td}>{o.id}</td>
                      <td className={td}>{o.pairName}{o.market === "perp" ? ` ·${o.leverage}x` : ""}</td>
                      <td className={td}>{o.kind.toUpperCase()}</td>
                      <td className={td} style={{ color: sell ? "var(--aw-down)" : "var(--aw-up)" }}>{sell ? "SELL" : "BUY"}</td>
                      <td className={td}>{o.qty}</td>
                      <td className={td}>{fmtPx(o.rate)}</td>
                      <td className={td}>{lbl}</td>
                      <td className={td}><button type="button" onClick={() => cancelOrder(o.id)} className="rounded-aw-sm border border-aw-border px-2 py-0.5 text-[11px] text-aw-text-tertiary hover:bg-aw-bg-tertiary">Cancel</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <Empty>No open orders. Place one from the ticket — or ask Hippo.</Empty>
          ))}

        {tab === "positions" &&
          (positions.length ? (
            <table className="w-full border-collapse">
              <thead><tr><th className={th}>Pair</th><th className={th}>Side</th><th className={th}>Size</th><th className={th}>Entry</th><th className={th}>Mark</th><th className={th}>Lev</th><th className={th}>Liq.</th><th className={th}>uPnL</th></tr></thead>
              <tbody>
                {positions.map((p) => {
                  const long = p.direction === "long"
                  const pnl = lastPrice ? (long ? lastPrice - p.entry : p.entry - lastPrice) * p.size : 0
                  return (
                    <tr key={p.pairName}>
                      <td className={td}>{p.pairName}</td>
                      <td className={td} style={{ color: long ? "var(--aw-up)" : "var(--aw-down)" }}>{p.direction.toUpperCase()}</td>
                      <td className={td}>{p.size}</td>
                      <td className={td}>{fmtPx(p.entry)}</td>
                      <td className={td}>{lastPrice ? fmtPx(lastPrice) : "—"}</td>
                      <td className={td}>{p.leverage}x</td>
                      <td className={td}>{fmtPx(p.liquidation)}</td>
                      <td className={td} style={{ color: pnl >= 0 ? "var(--aw-up)" : "var(--aw-down)" }}>{fmtSigned(pnl)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <Empty>No open positions.</Empty>
          ))}

        {tab === "balances" &&
          (balances.length ? (
            <table className="w-full border-collapse">
              <thead><tr><th className={th}>Asset</th><th className={th}>Amount</th></tr></thead>
              <tbody>
                {balances.map((b) => (
                  <tr key={b.currencyName}><td className={td}>{b.currencyName}</td><td className={td}>{fmt(b.amount, b.currencyName === "USDT" ? 2 : 6)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No balances.</Empty>
          ))}
      </div>
    </AWCard>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-7 text-center text-xs text-aw-text-light">{children}</div>
}
