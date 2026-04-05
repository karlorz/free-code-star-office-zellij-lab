#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${1:-${ZELLIJ_SESSION_NAME:-free-code-lab}}"
WORKDIR="${2:-${FREE_CODE_ROOT:-/Users/karlchow/Desktop/code/free-code}}"
ENABLE_WEB="${ZELLIJ_ENABLE_WEB:-1}"

if ! command -v zellij >/dev/null 2>&1; then
  echo "zellij is not installed or not on PATH" >&2
  exit 1
fi

if [[ ! -d "${WORKDIR}" ]]; then
  echo "workdir does not exist: ${WORKDIR}" >&2
  exit 1
fi

if [[ "${ENABLE_WEB}" == "1" ]]; then
  if ! zellij web --status >/dev/null 2>&1; then
    zellij web --daemonize >/dev/null
  fi
fi

cd "${WORKDIR}"
exec zellij attach -c "${SESSION_NAME}"
