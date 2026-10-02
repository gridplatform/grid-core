#!/usr/bin/env bash
# Smoke-check a running Grid control plane (Compose or native nginx).
#
#   ./install/verify.sh
#   GRID_URL=http://127.0.0.1:8080 ./install/verify.sh

set -euo pipefail

BASE="${GRID_URL:-http://127.0.0.1}"
BASE="${BASE%/}"

echo "==> GET ${BASE}/health"
code="$(curl -fsS -o /tmp/grid-health.json -w '%{http_code}' "${BASE}/health" || true)"
if [[ "$code" != "200" ]]; then
  # native nginx proxies /health; some setups only expose API on :3000
  echo "    (fallback :3000)"
  curl -fsS "http://127.0.0.1:3000/health" | tee /tmp/grid-health.json
else
  cat /tmp/grid-health.json
  echo
fi

echo "==> GET ${BASE}/ (UI)"
ui="$(curl -fsS -o /dev/null -w '%{http_code}' "${BASE}/" || true)"
if [[ "$ui" != "200" ]]; then
  echo "WARN: UI HTTP $ui — is the ui container / nginx up?"
else
  echo "OK UI"
fi

echo "==> Done. Open ${BASE}/ and sign in with GRID_AUTH_ADMIN_EMAIL / password."
