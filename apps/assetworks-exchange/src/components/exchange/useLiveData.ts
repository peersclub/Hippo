"use client"

import { useEffect } from "react"
import { subscribeVenue } from "@/lib/venue/client"
import { BinanceStream } from "@/lib/ws/binance"
import { useExchange } from "@/store/exchange"

/** Wires the two live sources: Binance market data (per pair) + the venue SSE
 *  (orders/positions/balances/config/handoffs). Mount once at the page root. */
export function useLiveData() {
  const pair = useExchange((s) => s.pair)

  // Binance — re-subscribed whenever the pair changes.
  useEffect(() => {
    const s = useExchange.getState()
    const stream = new BinanceStream(pair)
    let dead = false
    stream.seedCandles().then((c) => !dead && s.seedCandles(c)).catch(() => {})
    stream.connect({
      onKline: (c) => useExchange.getState().pushCandle(c),
      onBook: (bids, asks) => useExchange.getState().setBook(bids, asks),
      onTrade: (t) => useExchange.getState().pushTrade(t),
      onTicker: (t) => useExchange.getState().setTicker(t.last, t.changePct),
      onStatus: (up) => useExchange.getState().setWsUp(up),
    })
    return () => {
      dead = true
      stream.close()
    }
  }, [pair])

  // Venue SSE — subscribed once for the session.
  useEffect(() => {
    const s = useExchange.getState()
    return subscribeVenue(
      (e) => {
        const st = useExchange.getState()
        switch (e.type) {
          case "snapshot":
            st.setSnapshot(e)
            break
          case "order":
          case "fill":
            st.upsertOrder(e.order)
            break
          case "balances":
            st.setBalances(e.balances)
            break
          case "positions":
            st.setPositions(e.positions)
            break
          case "config":
            st.setConfig(e.config)
            break
          case "handoff":
            st.setHandoff(e.handoff.state === "pending" ? e.handoff : null)
            break
        }
      },
      (up) => s.setHostUp(up),
    )
  }, [])
}
