"use client"

import dynamic from "next/dynamic"
import { useState } from "react"
import { AdminDrawer } from "@/components/exchange/AdminDrawer"
import { Blotter } from "@/components/exchange/Blotter"
import { ConfirmModal } from "@/components/exchange/ConfirmModal"
import { Header } from "@/components/exchange/Header"
import { HippoEmbed } from "@/components/exchange/HippoEmbed"
import { OrderBook } from "@/components/exchange/OrderBook"
import { Tape } from "@/components/exchange/Tape"
import { Ticket } from "@/components/exchange/Ticket"
import { useLiveData } from "@/components/exchange/useLiveData"
import { AWCard } from "@/components/ui/assetworks-ui"

// ECharts touches window — load it client-only.
const Chart = dynamic(() => import("@/components/exchange/Chart").then((m) => m.Chart), { ssr: false })

export default function Page() {
  useLiveData()
  const [admin, setAdmin] = useState(false)

  return (
    <div className="flex h-screen flex-col">
      <Header onAdmin={() => setAdmin(true)} />
      <main className="grid min-h-0 flex-1 grid-cols-[1fr_260px_300px] grid-rows-[1fr_220px] gap-3 p-3">
        <AWCard title="Price" className="col-start-1 row-start-1"><Chart /></AWCard>
        <div className="col-start-2 row-start-1 min-h-0"><OrderBook /></div>
        <div className="col-start-3 row-start-1 min-h-0"><Tape /></div>
        <div className="col-start-3 row-start-2 min-h-0"><Ticket /></div>
        <div className="col-span-2 col-start-1 row-start-2 min-h-0"><Blotter /></div>
      </main>
      <AdminDrawer open={admin} onClose={() => setAdmin(false)} />
      <ConfirmModal />
      <HippoEmbed />
    </div>
  )
}
