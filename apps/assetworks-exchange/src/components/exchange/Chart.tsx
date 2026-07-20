"use client"

import ReactECharts from "echarts-for-react"
import { useMemo } from "react"
import { useTheme } from "@/lib/theme/ThemeProvider"
import { useExchange } from "@/store/exchange"

// Candlestick via ECharts (AssetWorks' charting lib). Recomputes options from
// the live 1m candle stream; colors follow the aw up/down + theme.
export function Chart() {
  const candles = useExchange((s) => s.candles)
  const pair = useExchange((s) => s.pair)
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"

  const option = useMemo(() => {
    const up = dark ? "#2ec48d" : "#10b981"
    const down = dark ? "#ff8585" : "#ef4444"
    const axis = dark ? "#222835" : "#e5e7eb"
    const label = dark ? "#8a8f9c" : "#6b7280"
    return {
      animation: false,
      grid: { left: 8, right: 56, top: 12, bottom: 24 },
      xAxis: {
        type: "category",
        data: candles.map((c) => new Date(c.t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })),
        axisLine: { lineStyle: { color: axis } },
        axisLabel: { color: label, fontSize: 10 },
        splitLine: { show: false },
      },
      yAxis: {
        scale: true,
        position: "right",
        axisLine: { show: false },
        axisLabel: { color: label, fontSize: 10 },
        splitLine: { lineStyle: { color: axis, opacity: 0.5 } },
      },
      tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
      series: [
        {
          type: "candlestick",
          data: candles.map((c) => [c.o, c.c, c.l, c.h]),
          itemStyle: { color: up, color0: down, borderColor: up, borderColor0: down },
        },
      ],
    }
  }, [candles, dark])

  return (
    <div className="min-h-0 flex-1">
      {candles.length > 1 ? (
        <ReactECharts option={option} style={{ height: "100%", width: "100%" }} notMerge lazyUpdate />
      ) : (
        <div className="grid h-full place-items-center text-xs text-aw-text-light">Loading {pair} candles from Binance…</div>
      )}
    </div>
  )
}
