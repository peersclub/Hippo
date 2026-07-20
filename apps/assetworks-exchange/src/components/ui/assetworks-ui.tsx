"use client"

// AssetWorks branded UI layer (ported from assetwork-ai-web/components/ui/
// assetworks-ui.tsx) — same variant/token vocabulary so components stay
// portable with the Assetworks product. Uses the aw-* utilities from globals.css.
import type React from "react"
import { cn } from "@/lib/utils"

interface AWButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "outline" | "up" | "down"
  size?: "sm" | "default" | "lg"
}

export function AWButton({ variant = "primary", size = "default", className, children, ...props }: AWButtonProps) {
  const base =
    "inline-flex items-center justify-center font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-aw-bg-primary disabled:opacity-50 disabled:pointer-events-none"
  const variants: Record<string, string> = {
    primary: "bg-aw-brand-primary text-aw-bg-primary hover:opacity-90 focus:ring-aw-brand-accent",
    secondary: "bg-aw-bg-primary text-aw-text-primary border border-aw-border hover:bg-aw-bg-tertiary",
    ghost: "text-aw-text-primary hover:bg-aw-bg-tertiary",
    outline: "border border-aw-border text-aw-text-primary hover:bg-aw-bg-tertiary",
    up: "bg-aw-up text-white hover:opacity-90",
    down: "bg-aw-down text-white hover:opacity-90",
  }
  const sizes: Record<string, string> = {
    sm: "h-8 px-3 text-xs rounded-aw-md",
    default: "h-10 px-4 text-sm rounded-aw-lg",
    lg: "h-12 px-6 text-base rounded-aw-lg",
  }
  return (
    <button type="button" className={cn(base, variants[variant], sizes[size], className)} {...props}>
      {children}
    </button>
  )
}

export function AWCard({ className, children, title, right }: { className?: string; children: React.ReactNode; title?: string; right?: React.ReactNode }) {
  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-aw-xl border border-aw-border bg-aw-panel", className)}>
      {title && (
        <div className="flex items-center justify-between px-4 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wider text-aw-text-tertiary">
          <span>{title}</span>
          {right}
        </div>
      )}
      {children}
    </div>
  )
}

/** Segmented control (Spot/Perp, Buy/Sell, Market/Limit) in the aw idiom. */
export function AWSegmented<T extends string>({ value, onChange, options, tone }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; tone?: (v: T) => "up" | "down" | undefined }) {
  return (
    <div className="flex gap-1 rounded-aw-lg bg-aw-bg-tertiary p-[3px]">
      {options.map((o) => {
        const on = o.value === value
        const t = on ? tone?.(o.value) : undefined
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "flex-1 rounded-aw-md px-2 py-1.5 text-xs font-semibold transition-colors",
              on
                ? t === "up"
                  ? "bg-aw-up text-white"
                  : t === "down"
                    ? "bg-aw-down text-white"
                    : "bg-aw-panel text-aw-text-primary shadow-sm"
                : "text-aw-text-tertiary hover:text-aw-text-secondary",
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
