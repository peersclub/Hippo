"use client"

import { Monitor, Moon, Sun } from "lucide-react"
import { useTheme } from "@/lib/theme/ThemeProvider"

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light"
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Theme: ${theme} (click for ${next})`}
      className="grid h-[34px] w-[34px] place-items-center rounded-aw-lg border border-aw-border bg-aw-bg-primary text-aw-text-secondary hover:bg-aw-bg-tertiary"
    >
      <Icon size={15} />
    </button>
  )
}
