#!/usr/bin/env bash
# Hard-check install/.env (or GRID_ENV_FILE) before Compose / install.sh.
# No override flag — incomplete production config exits 1.
#
#   ./install/check-env.sh
#   GRID_ENV_FILE=/etc/grid/grid.env ./install/check-env.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${GRID_ENV_FILE:-${SCRIPT_DIR}/.env}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE — copy install/.env.example → install/.env and fill required values"

# shellcheck disable=SC1090
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

problems=()

require() {
  local name="$1"
  local val="${!name:-}"
  if [[ -z "${val// }" ]]; then
    problems+=("$name is required in $ENV_FILE")
  fi
}

require GRID_AUTH_ADMIN_EMAIL
require GRID_AUTH_ADMIN_PASSWORD
require GRID_GITOPS_REPO_URL
require GRID_MODULE_BANK
require GRID_MODULE_BANK_REF
require GRID_TF_BACKEND

pw="${GRID_AUTH_ADMIN_PASSWORD:-}"
if [[ "$pw" =~ ^(change-me|changeme|password|admin|change-me-before-production)$ ]]; then
  problems+=("GRID_AUTH_ADMIN_PASSWORD is still a placeholder")
fi

bank="${GRID_MODULE_BANK:-}"
if [[ ! "$bank" =~ ^(https?://|git@|git::) ]]; then
  problems+=("GRID_MODULE_BANK must be a git URL (got: ${bank:-empty})")
fi

ref="${GRID_MODULE_BANK_REF:-}"
if [[ ! "$ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  problems+=("GRID_MODULE_BANK_REF must be a release tag like v0.1.0 (got: ${ref:-empty})")
fi

backend="$(echo "${GRID_TF_BACKEND:-}" | tr '[:upper:]' '[:lower:]')"
case "$backend" in
  s3)
    require GRID_TF_STATE_BUCKET
    require GRID_TF_LOCK_TABLE
    require GRID_TF_STATE_REGION
    ;;
  gcs)
    require GRID_TF_STATE_BUCKET
    ;;
  azurerm)
    require GRID_TF_AZURE_RESOURCE_GROUP
    require GRID_TF_AZURE_STORAGE_ACCOUNT
    require GRID_TF_AZURE_CONTAINER
    ;;
  "")
    problems+=("GRID_TF_BACKEND must be s3|gcs|azurerm (missing)")
    ;;
  *)
    problems+=("GRID_TF_BACKEND must be s3|gcs|azurerm (got: ${GRID_TF_BACKEND})")
    ;;
esac

if ((${#problems[@]} > 0)); then
  printf 'ERROR: production install env refused — fix %s:\n' "$ENV_FILE" >&2
  for p in "${problems[@]}"; do
    printf '  - %s\n' "$p" >&2
  done
  printf '\nSee install/.env.example and grid-docs docs/install/remote-state.md\n' >&2
  exit 1
fi

echo "OK production env: $ENV_FILE (module-bank-ref=${GRID_MODULE_BANK_REF} state=${GRID_TF_BACKEND})"
