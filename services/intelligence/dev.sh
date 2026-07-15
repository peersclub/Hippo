#!/usr/bin/env bash
# Dev runner: create the venv on first use, then uvicorn with reload.
# Env: PORT (8791), LLM_BASE_URL, LLM_MODEL, MARKET_DATA_URL — see README.md.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

exec .venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port "${PORT:-8791}"
