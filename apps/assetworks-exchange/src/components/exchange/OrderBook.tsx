"use client"

import { AWCard } from "@/components/ui/assetworks-ui"
import { fmtPx } from "@/lib/format"
import { useExchange } from "@/store/exchange"

export function OrderBook() {
  const { bids, asks } = useExchange()
  const top = (arr: typeof bids) => arr.slice(0, 11)
  const max = Math.max(...top(bids).concat(top(asks)).map((l) => l.qty), 1)
  const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : 0

  const Row = ({ price, qty, side }: { price: number; qty: number; side: "ask" | "bid" }) => (
    <div className="relative flex justify-between px-3.5 py-[3px]">
      <span className="absolute right-0 top-0 bottom-0 opacity-10" style={{ width: `${(qty / max) * 100}%`, background: side === "ask" ? "var(--aw-down)" : "var(--aw-up)" }} />
      <span className="relative z-10" style={{ color: side === "ask" ? "var(--aw-down)" : "var(--aw-up)" }}>{fmtPx(price)}</span>
      <span className="relative z-10 text-aw-text-tertiary">{qty.toFixed(4)}</span>
    </div>
  )

  return (
    <AWCard title="Order book">
      <div className="flex min-h-0 flex-1 flex-col justify-center font-mono text-[11.5px]">
        <div>{top(asks).slice().reverse().map((l) => <Row key={`a${l.price}`} {...l} side="ask" />)}</div>
        <div className="border-y border-aw-border-light py-1.5 text-center font-mono text-xs font-semibold text-aw-text-tertiary">
          {spread ? `spread ${fmtPx(Math.abs(spread))}` : "—"}
        </div>
        <div>{top(bids).map((l) => <Row key={`b${l.price}`} {...l} side="bid" />)}</div>
      </div>
    </AWCard>
  )
}
