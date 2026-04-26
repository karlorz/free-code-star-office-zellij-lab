#!/usr/bin/env bash
set -euo pipefail

SG01_TARGET="${SG01_TARGET:-sg01}"
LAB_ROOT="${LAB_ROOT:-/root/free-code-star-office-zellij-lab}"
ZELLIJ_SESSION_NAME="${ZELLIJ_SESSION_NAME:-main}"
BRIDGE_PORT="${BRIDGE_PORT:-4317}"

usage() {
  cat <<EOF
Usage: bash scripts/check-sg01-live-capture-readiness.sh

Runs read-only SSH checks for sg01 live capture readiness. It does not install
software, start services, create tmux sessions, or trigger Claude/free-code hooks.

Environment overrides:
  SG01_TARGET          Default: sg01
  LAB_ROOT             Default: /root/free-code-star-office-zellij-lab
  ZELLIJ_SESSION_NAME  Default: main
  BRIDGE_PORT          Default: 4317
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

ssh "${SG01_TARGET}" \
  SG01_LAB_ROOT="${LAB_ROOT}" \
  SG01_ZELLIJ_SESSION_NAME="${ZELLIJ_SESSION_NAME}" \
  SG01_BRIDGE_PORT="${BRIDGE_PORT}" \
  'bash -s' <<'REMOTE'
set -euo pipefail

LAB_ROOT="${SG01_LAB_ROOT}"
ZELLIJ_SESSION_NAME="${SG01_ZELLIJ_SESSION_NAME}"
BRIDGE_PORT="${SG01_BRIDGE_PORT}"

status() {
  local label="$1"
  local value="$2"
  printf '[sg01-readiness] %-28s %s\n' "${label}:" "${value}"
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

status "host" "$(hostname)"
status "time" "$(date -Is)"
status "arch" "$(uname -m)"

if [[ -d "${LAB_ROOT}" ]]; then
  status "lab repo" "present (${LAB_ROOT})"
else
  status "lab repo" "missing (${LAB_ROOT})"
fi

for cmd in bun node python3 zellij tmux git; do
  if has_command "${cmd}"; then
    status "${cmd}" "$(${cmd} --version 2>/dev/null | head -n 1 || command -v "${cmd}")"
  else
    status "${cmd}" "missing"
  fi
done

if has_command zellij; then
  if zellij list-sessions 2>/dev/null | grep -Fxq "${ZELLIJ_SESSION_NAME}"; then
    status "zellij session ${ZELLIJ_SESSION_NAME}" "present"
  else
    status "zellij session ${ZELLIJ_SESSION_NAME}" "missing"
  fi

  if zellij web --status >/tmp/sg01-zellij-web-status.txt 2>&1; then
    status "zellij web" "$(tr '\n' ' ' </tmp/sg01-zellij-web-status.txt | sed 's/[[:space:]]\+$//')"
  else
    status "zellij web" "status failed"
  fi
  rm -f /tmp/sg01-zellij-web-status.txt
fi

if ss -ltn 2>/dev/null | grep -q ':8082 '; then
  status "zellij listener :8082" "present"
else
  status "zellij listener :8082" "missing"
fi

if ss -ltn 2>/dev/null | grep -q ":${BRIDGE_PORT} "; then
  status "bridge listener :${BRIDGE_PORT}" "present"
else
  status "bridge listener :${BRIDGE_PORT}" "not running"
fi

if has_command claude; then
  status "claude" "$(claude --version 2>/dev/null | head -n 1 || command -v claude)"
else
  status "claude" "missing"
fi

if has_command free-code; then
  status "free-code" "$(free-code --version 2>/dev/null | head -n 1 || command -v free-code)"
else
  status "free-code" "missing"
fi

if [[ -d "${LAB_ROOT}" ]]; then
  if [[ -f "${LAB_ROOT}/package.json" ]]; then
    status "lab package" "present"
  else
    status "lab package" "missing package.json"
  fi
  if [[ -f "${LAB_ROOT}/plugins/claude-star-office-bridge/hooks/hooks.json" ]]; then
    status "plugin hooks" "present"
  else
    status "plugin hooks" "missing"
  fi
  if [[ -f "${LAB_ROOT}/scripts/run-interactive-notification-capture.sh" ]]; then
    status "interactive helper" "present"
  else
    status "interactive helper" "missing"
  fi
fi

status "next runtime need" "install/configure claude or free-code before live hook capture"
status "recommended shell" "tmux new-session -s claude-team inside Zellij web"
REMOTE
