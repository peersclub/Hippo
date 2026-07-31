#!/usr/bin/env bash
# Cross-process rotate/suspend enforcement E2E — three services, one Postgres:
#   admin  (create throwaway partner, invite a portal seat, suspend)
#   portal (claim seat, login, rotate the partner secret)
#   gateway(JWT session mints — the enforcement point)
#
# PASS = the gateway rejects the OLD secret and accepts the NEW one on the
# mint immediately after the portal's rotation, and rejects everything after
# the admin's suspend. Run against the live stack or the compose stack:
#
#   ADMIN_URL=https://hippo-admin-six.vercel.app/api \
#   PORTAL_URL=https://hippo-partner-portal.vercel.app/api \
#   GATEWAY_URL=https://gateway-production-2a3c.up.railway.app \
#   ADMIN_EMAIL=… ADMIN_PASSWORD=… scripts/rotate-suspend-e2e.sh
#
#   # compose (deploy/docker-compose.yml --profile services):
#   ADMIN_URL=http://localhost:8794 PORTAL_URL=http://localhost:8795 \
#   GATEWAY_URL=http://localhost:8788 ADMIN_EMAIL=… ADMIN_PASSWORD=… \
#   scripts/rotate-suspend-e2e.sh
#
# The throwaway partner (e2e-rotate-<epoch>) is left SUSPENDED — inert, and
# an audit-visible record that the check ran. Verified against the live
# stack 2026-07-31: 200 → rotate → 401/200 → suspend → 401.
set -euo pipefail

: "${ADMIN_URL:?set ADMIN_URL (e.g. https://hippo-admin-six.vercel.app/api)}"
: "${PORTAL_URL:?set PORTAL_URL}"
: "${GATEWAY_URL:?set GATEWAY_URL}"
: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD}"

P="e2e-rotate-$(date +%s)"
S1=$(openssl rand -hex 32)
SEAT_EMAIL="ops@${P}.test"
SEAT_PASS="E2e!$(openssl rand -hex 8)"
fail() { echo "FAIL: $*" >&2; exit 1; }

b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() { # jwt <secret> → HS256 {iss,sub,iat,exp}
  local now h p sig
  now=$(date +%s)
  h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64)
  p=$(printf '{"iss":"%s","sub":"e2e-user","iat":%s,"exp":%s}' "$P" "$now" $((now + 900)) | b64)
  sig=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$1" -binary | b64)
  printf '%s.%s.%s' "$h" "$p" "$sig"
}
mint() { # mint <secret> → http status
  curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL/v1/session" \
    -H "Authorization: Bearer $(jwt "$1")" -H 'content-type: application/json' -d '{"v":1}'
}
cookie_of() { grep -i '^set-cookie' | sed 's/set-cookie: //I;s/;.*//' | tr -d '\r'; }

echo "── operator login"
AC=$(curl -s -D- -o /dev/null -X POST "$ADMIN_URL/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | cookie_of)
[ -n "$AC" ] || fail "operator login"

echo "── create throwaway partner $P"
KEY="pk_$(echo "$P" | tr -c 'A-Za-z0-9_\n' '_')"
curl -sf -X POST "$ADMIN_URL/v1/partners" -H "cookie: $AC" -H 'content-type: application/json' \
  -d "{\"partnerId\":\"$P\",\"partnerKey\":\"$KEY\",\"jwtSecret\":\"$S1\",\"venueName\":\"E2E Rotate\",\"locales\":[\"en\"],\"suggestedQueries\":[]}" >/dev/null || fail "partner create"

[ "$(mint "$S1")" = 200 ] || fail "baseline mint with S1 should be 200"
echo "   mint S1 → 200"

echo "── portal seat: invite → claim → login"
INV=$(curl -s -X POST "$ADMIN_URL/v1/partners/$P/admins" -H "cookie: $AC" -H 'content-type: application/json' \
  -d "{\"email\":\"$SEAT_EMAIL\",\"role\":\"admin\"}" | jq -r .inviteToken)
[ "$INV" != null ] || fail "invite mint"
curl -sf -X POST "$PORTAL_URL/auth/claim" -H 'content-type: application/json' \
  -d "{\"token\":\"$INV\",\"password\":\"$SEAT_PASS\"}" >/dev/null || fail "claim"
PC=$(curl -s -D- -o /dev/null -X POST "$PORTAL_URL/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$SEAT_EMAIL\",\"password\":\"$SEAT_PASS\"}" | cookie_of)
[ -n "$PC" ] || fail "portal login"

echo "── rotate via portal (process A) → enforce at gateway (process B)"
S2=$(curl -s -X POST "$PORTAL_URL/portal/integration/rotate-secret" -H "cookie: $PC" | jq -r .jwtSecret)
[ ${#S2} -ge 32 ] || fail "rotate returned no secret"
[ "$(mint "$S1")" = 401 ] || fail "OLD secret must 401 after rotation"
echo "   mint S1 → 401 (rotation enforced cross-process)"
[ "$(mint "$S2")" = 200 ] || fail "NEW secret must mint"
echo "   mint S2 → 200"

echo "── suspend via admin (process C) → enforce at gateway"
curl -sf -X POST "$ADMIN_URL/v1/partners/$P/suspend" -H "cookie: $AC" >/dev/null || fail "suspend"
CODE=$(mint "$S2")
[ "$CODE" != 200 ] || fail "suspended partner must not mint"
echo "   mint after suspend → $CODE"

echo "PASS — rotate + suspend enforced across processes. Partner $P left suspended."
