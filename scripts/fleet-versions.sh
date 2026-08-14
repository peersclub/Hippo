#!/usr/bin/env bash
# Which build is each deployed service actually running? Prints sha/builtAt
# (and LLM provider mode where the service reports one) side by side from the
# public /health endpoints — the outside-in proof that a deploy landed.
#
# Usage:
#   scripts/fleet-versions.sh
#
# URL table source: deploy/README.md (Railway project `Hippo`, env
# `production`). seam/memory/intelligence/market-data are *.railway.internal
# only — they have no public /health, so they are listed as such rather than
# silently omitted. Verify those via `railway logs` or through the gateway.
set -uo pipefail

SERVICES=(
  "gateway|https://gateway-production-2a3c.up.railway.app"
  "admin|https://admin-production-9c9f.up.railway.app"
  "portal|https://portal-production-735a.up.railway.app"
  "host-venue|https://host-venue-production.up.railway.app"
  "seam|"
  "memory|"
  "intelligence|"
  "market-data|"
)

printf '%-14s %-42s %-26s %-6s %s\n' SERVICE SHA BUILT_AT LLM MODEL
for row in "${SERVICES[@]}"; do
  name="${row%%|*}"
  url="${row#*|}"
  if [ -z "$url" ]; then
    printf '%-14s %s\n' "$name" "(internal-only — no public /health)"
    continue
  fi
  body="$(curl -fsS --max-time 10 "$url/health" 2>/dev/null)" || {
    printf '%-14s %s\n' "$name" "(unreachable: $url/health)"
    continue
  }
  printf '%s' "$body" | python3 -c '
import json, sys
name = sys.argv[1]
try:
    h = json.load(sys.stdin)
except json.JSONDecodeError:
    print(f"{name:<14} (non-JSON /health body)")
    raise SystemExit(0)
# "-" marks a field the service did not report; nothing here is invented.
sha = h.get("sha", "-")
built = h.get("builtAt", "-")
llm = h.get("llm", h.get("providerMode", "-"))
model = h.get("model", "-")
print(f"{name:<14} {sha:<42} {built:<26} {llm:<6} {model}")
' "$name"
done
