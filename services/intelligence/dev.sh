#!/usr/bin/env bash
# Dev runner: create the venv on first use, then uvicorn with reload.
# Env: PORT (8791), LLM_BASE_URL, LLM_MODEL, MARKET_DATA_URL — see README.md.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi

# Re-sync deps whenever requirements.txt changes (stamp = last installed copy),
# so a pulled requirements bump can't leave the venv stale.
if ! cmp -s requirements.txt .venv/.requirements-stamp; then
  .venv/bin/pip install -r requirements.txt
  cp requirements.txt .venv/.requirements-stamp
fi

# LOG_LEVEL drives both uvicorn's loggers and the app's (see main.py).
# uvicorn spells it "warning"; the fleet-wide convention (pino) is "warn".
UVICORN_LEVEL="$(echo "${LOG_LEVEL:-info}" | tr '[:upper:]' '[:lower:]')"
[ "$UVICORN_LEVEL" = "warn" ] && UVICORN_LEVEL=warning
exec .venv/bin/uvicorn main:app --reload --host :: --port "${PORT:-8791}" \
  --log-level "$UVICORN_LEVEL"
