"use client"

import { useEffect } from "react"

// The ENTIRE parasite-side integration: one script tag, exactly as a real
// partner ships it. The loader + gateway URLs are configurable; defaults point
// at the local Hippo stack (loader served by host-demo :4000, gateway :8788).
// This component imports no Hippo code — it only injects a <script src>.
export function HippoEmbed() {
  useEffect(() => {
    if (document.getElementById("hippo-loader")) return
    const loaderUrl = process.env.NEXT_PUBLIC_HIPPO_LOADER_URL ?? "http://localhost:4000/loader.js"
    const gateway = process.env.NEXT_PUBLIC_HIPPO_GATEWAY ?? "http://localhost:8788"
    const s = document.createElement("script")
    s.id = "hippo-loader"
    s.src = loaderUrl
    s.async = true
    s.dataset.hippoKey = process.env.NEXT_PUBLIC_HIPPO_KEY ?? "pk_demo"
    s.dataset.hippoGateway = gateway
    document.body.appendChild(s)
  }, [])
  return null
}
