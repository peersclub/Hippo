"use client"

import { AWButton } from "@/components/ui/assetworks-ui"
import { approveHandoff, rejectHandoff } from "@/lib/venue/client"
import { useExchange } from "@/store/exchange"

// The host's OWN confirm dialog for the js_callback surface. When Hippo hands
// off an order, the venue SSE pushes a pending handoff and this pops — the
// trader approves on the HOST, not inside Hippo.
export function ConfirmModal() {
  const handoff = useExchange((s) => s.handoff)
  const setHandoff = useExchange((s) => s.setHandoff)
  if (!handoff) return null

  const rows = handoff.displayRows?.length
    ? handoff.displayRows
    : [
        { label: "Pair", value: handoff.place.pairName },
        { label: "Side", value: handoff.place.side.toUpperCase() },
        { label: "Qty", value: String(handoff.place.qty) },
      ]

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40">
      <div className="w-[340px] rounded-2xl border border-aw-border bg-aw-bg-primary p-6">
        <div className="text-[11px] font-bold uppercase tracking-wide text-aw-brand-accent">Assetworks Exchange · confirm order</div>
        <h3 className="mb-3.5 mt-1.5 text-[17px] font-semibold">
          {handoff.place.side === "sell" ? "Sell" : "Buy"} {handoff.place.qty} {handoff.place.pairName}
        </h3>
        <div className="mb-4 flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.label} className="flex justify-between text-[13px]">
              <span className="text-aw-text-tertiary">{r.label}</span>
              <span className="font-mono font-semibold">{r.value}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-2.5">
          <AWButton variant="outline" className="flex-1" onClick={() => { rejectHandoff(handoff.clientOrderId); setHandoff(null) }}>Decline</AWButton>
          <AWButton variant="primary" className="flex-1" onClick={() => { approveHandoff(handoff.clientOrderId); setHandoff(null) }}>Confirm &amp; place</AWButton>
        </div>
      </div>
    </div>
  )
}
