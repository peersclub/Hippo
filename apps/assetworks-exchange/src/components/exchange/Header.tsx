"use client"

import { Settings } from "lucide-react"
import { fmtPx } from "@/lib/format"
import { PAIRS, useExchange } from "@/store/exchange"
import { ThemeToggle } from "./ThemeToggle"

export function Header({ onAdmin }: { onAdmin: () => void }) {
  const { pair, setPair, lastPrice, changePct, hostUp, wsUp } = useExchange()
  return (
    <header className="flex h-14 flex-shrink-0 items-center gap-5 border-b border-aw-border bg-aw-bg-primary px-4">
      <div className="flex items-center gap-2.5 text-base font-bold tracking-tight">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-aw-brand-primary text-sm font-extrabold text-aw-bg-primary">A</span>
        Assetworks <span className="text-xs font-medium text-aw-text-tertiary">Exchange</span>
      </div>
      <nav className="flex gap-1 text-[13px]">
        {["Trade", "Markets", "Portfolio", "Wallet"].map((n, i) => (
          <span key={n} className={i === 0 ? "rounded-md bg-aw-bg-tertiary px-2.5 py-1.5 font-semibold text-aw-text-primary" : "cursor-pointer px-2.5 py-1.5 text-aw-text-tertiary"}>
            {n}
          </span>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-4">
        <div className="flex items-center gap-1.5 font-mono text-[10px]">
          <span className={`rounded px-2 py-1 font-semibold ${hostUp ? "bg-aw-up/15 text-aw-up" : "bg-aw-down/15 text-aw-down"}`}>HOST</span>
          <span className={`rounded px-2 py-1 font-semibold ${wsUp ? "bg-aw-up/15 text-aw-up" : "bg-aw-down/15 text-aw-down"}`}>BINANCE</span>
        </div>
        <div className="flex gap-1 rounded-aw-lg bg-aw-bg-tertiary p-[3px]">
          {PAIRS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPair(p)}
              className={`rounded-md px-2.5 py-1.5 font-mono text-xs font-semibold ${p === pair ? "bg-aw-bg-primary text-aw-text-primary shadow-sm" : "text-aw-text-tertiary"}`}
            >
              {p}
            </button>
          ))}
        </div>
        <span className="font-mono text-lg font-semibold" style={{ color: changePct >= 0 ? "var(--aw-up)" : "var(--aw-down)" }}>
          {lastPrice ? fmtPx(lastPrice) : "—"}
        </span>
        <span className="font-mono text-xs font-semibold" style={{ color: changePct >= 0 ? "var(--aw-up)" : "var(--aw-down)" }}>
          {changePct ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%` : ""}
        </span>
        <ThemeToggle />
        <button type="button" onClick={onAdmin} title="Venue admin" className="grid h-[34px] w-[34px] place-items-center rounded-aw-lg border border-aw-border bg-aw-bg-primary text-aw-text-secondary hover:bg-aw-bg-tertiary">
          <Settings size={15} />
        </button>
      </div>
    </header>
  )
}
