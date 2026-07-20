#!/usr/bin/env bash
# Go/no-go smoke for a running Hippo stack — automates the curl-able steps of
# DEPLOY.md §3 (health, session-auth posture, a full research turn). The UI
# steps (§3.2 admin login / §3.5 portal claim) still need a human.
#
# Usage:
#   scripts/smoke.sh                     # local stack (pnpm dev): all services on localhost
#   GATEWAY_URL=https://gw.example scripts/smoke.sh   # remote: only the gateway loop
#
# Env:
#   GATEWAY_URL        gateway base (default http://localhost:8788)
#   PARTNER_KEY        embed key for the session mint (default pk_demo)
#   EXPECT_DEV         "1" = expect anonymous sessions to succeed (HIPPO_DEV=1);
#                      "0" = expect 401 without a JWT (prod). Default "1".
#   CHECK_SERVICES     "1" = also health-check the non-gateway services on their
#                      localhost ports (default "1"; set "0" for a remote gateway
#                      whose peers are private-only).
#   INTELLIGENCE_URL MARKET_DATA_URL MEMORY_URL SEAM_URL ADMIN_URL PORTAL_URL
#                      override individual health targets (default localhost ports)
set -uo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:8788}"
PARTNER_KEY="${PARTNER_KEY:-pk_demo}"
EXPECT_DEV="${EXPECT_DEV:-1}"
CHECK_SERVICES="${CHECK_SERVICES:-1}"

pass=0 fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
info() { printf '\033[1m%s\033[0m\n' "$1"; }

# health <name> <url> [expected-json-substring]
health() {
  local name="$1" url="$2" want="${3:-\"ok\":true}"
  local body
  body="$(curl -fsS -m 8 "$url/health" 2>/dev/null)"
  if [ $? -ne 0 ] || [ -z "$body" ]; then
    bad "$name /health unreachable ($url)"; return
  fi
  if printf '%s' "$body" | grep -q "$want"; then
    ok "$name /health — $(printf '%s' "$body" | head -c 120)"
  else
    bad "$name /health responded but missing '$want' — $body"
  fi
}

info "1 · Health checks"
health gateway "$GATEWAY_URL"
if [ "$CHECK_SERVICES" = "1" ]; then
  health intelligence "${INTELLIGENCE_URL:-http://localhost:8791}"
  health market-data  "${MARKET_DATA_URL:-http://localhost:8790}"
  health memory       "${MEMORY_URL:-http://localhost:8792}"
  health seam         "${SEAM_URL:-http://localhost:8793}"
  health admin        "${ADMIN_URL:-http://localhost:8794}"
  health portal       "${PORTAL_URL:-http://localhost:8795}"

  # Quality gates: the two silent-degradation traps DEPLOY.md warns about.
  intel="$(curl -fsS -m 8 "${INTELLIGENCE_URL:-http://localhost:8791}/health" 2>/dev/null)"
  if printf '%s' "$intel" | grep -q '"mode":"llm"'; then
    ok "intelligence in llm mode — $(printf '%s' "$intel" | grep -o '"model":"[^"]*"')"
  else
    bad "intelligence NOT in llm mode (serving mock briefs?) — $intel"
  fi
  md="$(curl -fsS -m 8 "${MARKET_DATA_URL:-http://localhost:8790}/health" 2>/dev/null)"
  if printf '%s' "$md" | grep -q '"mode":"live"'; then
    ok "market-data live"
  else
    bad "market-data NOT live (serving fixtures?) — $md"
  fi
fi

info "2 · Session auth posture (EXPECT_DEV=$EXPECT_DEV)"
sess="$(curl -sS -m 8 -o /tmp/hippo_smoke_sess.json -w '%{http_code}' \
  -X POST "$GATEWAY_URL/v1/session" -H 'content-type: application/json' \
  -d "{\"partnerKey\":\"$PARTNER_KEY\"}" 2>/dev/null)"
SID=""
if [ "$EXPECT_DEV" = "0" ]; then
  if [ "$sess" = "401" ]; then
    ok "anonymous /v1/session → 401 (prod dev-mode off, as expected)"
  else
    bad "expected 401 without a JWT (HIPPO_DEV=0) but got HTTP $sess"
  fi
else
  if [ "$sess" = "200" ]; then
    SID="$(python3 -c 'import json,sys;print(json.load(open("/tmp/hippo_smoke_sess.json")).get("sessionId",""))' 2>/dev/null)"
    [ -n "$SID" ] && ok "anonymous /v1/session → 200 ($SID)" || bad "session minted but no sessionId in body"
  else
    bad "expected 200 anonymous session (HIPPO_DEV=1) but got HTTP $sess"
  fi
fi

if [ -n "$SID" ]; then
  info "3 · Research turn (streamed brief)"
  sse=/tmp/hippo_smoke_sse.log; : > "$sse"
  # Cloud LLMs (OpenRouter) can take 30s+ for a full brief; keep the window wide.
  BRIEF_TIMEOUT="${BRIEF_TIMEOUT:-45}"
  curl -sN -m "$((BRIEF_TIMEOUT + 5))" "$GATEWAY_URL/v1/stream?session=$SID" > "$sse" 2>/dev/null &
  spid=$!
  sleep 1
  ts="$(python3 -c 'import time;print(int(time.time()*1000))')"
  turn="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL/v1/turns" \
    -H 'content-type: application/json' \
    -d "{\"v\":1,\"ts\":$ts,\"kind\":\"user_text\",\"sessionId\":\"$SID\",\"text\":\"how is bitcoin doing\"}" 2>/dev/null)"
  [ "$turn" = "200" ] && ok "POST /v1/turns accepted" || bad "POST /v1/turns → HTTP $turn"
  for _ in $(seq 1 "$BRIEF_TIMEOUT"); do grep -q '"type":"research_brief"' "$sse" && break; sleep 1; done
  kill "$spid" 2>/dev/null; wait "$spid" 2>/dev/null
  if grep -q '"type":"research_brief"' "$sse"; then
    ok "research_brief frame received ($(grep -oc '"type":"brief_delta"' "$sse") streamed deltas)"
    model="$(grep -o '"model":"[^"]*"' "$sse" | head -1)"
    [ -n "$model" ] && ok "brief carries model provenance — $model" || info "  (no model tag on brief)"
  else
    bad "no research_brief frame within 20s — frames seen: $(grep -o '"type":"[a-z_]*"' "$sse" | sort -u | tr '\n' ' ')"
  fi
fi

echo
info "Manual (not automated): DEPLOY.md §3.2 admin login + create partner, §3.5 portal invite→claim→rotate, §3.6 audit row."
printf '\033[1m%s\033[0m\n' "Result: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
