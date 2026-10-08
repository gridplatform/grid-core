#!/usr/bin/env bash
# Production-only Compose entrypoint: validate install/.env then up.
# No dev mode, no skip flags.
#
#   ./install/compose-up.sh
#   ./install/compose-up.sh release          # docker-compose.release.yml
#   ./install/compose-up.sh -- pull          # extra docker compose args after --

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

MODE="source"
ARGS=()
if [[ "${1:-}" == "release" ]]; then
  MODE="release"
  shift
fi
if [[ "${1:-}" == "--" ]]; then
  shift
fi
ARGS=("$@")

COMPOSE_FILE="install/docker-compose.yml"
if [[ "$MODE" == "release" ]]; then
  COMPOSE_FILE="install/docker-compose.release.yml"
fi

bash install/check-env.sh

if ((${#ARGS[@]} == 0)); then
  ARGS=(up -d --build --remove-orphans)
  if [[ "$MODE" == "release" ]]; then
    ARGS=(up -d --remove-orphans)
  fi
fi

exec docker compose -f "$COMPOSE_FILE" --env-file install/.env "${ARGS[@]}"
