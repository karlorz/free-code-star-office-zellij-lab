#!/usr/bin/env bash
set -euo pipefail

SG01_TARGET="${SG01_TARGET:-sg01}"
LAB_ROOT="${LAB_ROOT:-/root/free-code-star-office-zellij-lab}"
ZELLIJ_SESSION_NAME="${ZELLIJ_SESSION_NAME:-main}"
BRIDGE_PORT="${BRIDGE_PORT:-4317}"
STRICT="false"
REPORT_PATH=""

usage() {
  cat <<EOF
Usage: bash scripts/check-sg01-live-capture-readiness.sh [--strict] [--report <path>]

Runs read-only SSH checks for sg01 live capture readiness. It does not install
software, start services, create tmux sessions, or trigger Claude/free-code hooks.

Options:
  --strict         Exit nonzero when live-capture blockers are present
  --report <path> Write a markdown readiness report

Environment overrides:
  SG01_TARGET          Default: sg01
  LAB_ROOT             Default: /root/free-code-star-office-zellij-lab
  ZELLIJ_SESSION_NAME  Default: main
  BRIDGE_PORT          Default: 4317
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --strict)
      STRICT="true"
      shift
      ;;
    --report)
      if [[ -z "${2:-}" ]]; then
        echo "[sg01-readiness] --report requires a path" >&2
        exit 1
      fi
      REPORT_PATH="$2"
      shift 2
      ;;
    --report=*)
      REPORT_PATH="${1#--report=}"
      shift
      ;;
    *)
      echo "[sg01-readiness] unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

OUTPUT="$({
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

if has_command curl; then
  if bridge_health="$(curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" 2>/dev/null)"; then
    status "bridge health" "${bridge_health}"
  else
    status "bridge health" "unreachable"
  fi
else
  status "bridge health" "curl missing"
fi

if has_command systemctl; then
  if systemctl list-unit-files star-office-bridge.service >/dev/null 2>&1; then
    status "bridge service" "$(systemctl is-active star-office-bridge.service 2>/dev/null || true)"
    status "bridge service enabled" "$(systemctl is-enabled star-office-bridge.service 2>/dev/null || true)"
  else
    status "bridge service" "missing"
  fi
else
  status "bridge service" "systemctl missing"
fi

if has_command claude; then
  CLAUDE_PRESENT="true"
  status "claude" "$(claude --version 2>/dev/null | head -n 1 || command -v claude)"
else
  CLAUDE_PRESENT="false"
  status "claude" "missing"
fi

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  status "claude auth" "ANTHROPIC_API_KEY set"
elif [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  status "claude auth" "CLAUDE_CODE_OAUTH_TOKEN set"
elif [[ -n "${CLAUDE_CODE_API_KEY_HELPER:-}" ]]; then
  status "claude auth" "CLAUDE_CODE_API_KEY_HELPER set"
elif [[ -f "${HOME}/.claude.json" ]] && grep -q 'hasCompletedOnboarding' "${HOME}/.claude.json" 2>/dev/null; then
  status "claude auth" "onboarding marker present; credential env not set"
else
  status "claude auth" "missing"
fi

if has_command free-code; then
  FREE_CODE_PRESENT="true"
  status "free-code" "$(free-code --version 2>/dev/null | head -n 1 || command -v free-code)"
else
  FREE_CODE_PRESENT="false"
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

if [[ "${CLAUDE_PRESENT}" == "true" || "${FREE_CODE_PRESENT}" == "true" ]]; then
  if [[ -n "${ANTHROPIC_API_KEY:-}" || -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" || -n "${CLAUDE_CODE_API_KEY_HELPER:-}" ]]; then
    status "next runtime need" "runtime and auth present; run focused live capture when ready"
  else
    status "next runtime need" "set ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or CLAUDE_CODE_API_KEY_HELPER before live capture"
  fi
else
  status "next runtime need" "install/configure claude or free-code before live hook capture"
fi
status "recommended shell" "tmux new-session -s claude-team inside Zellij web"
REMOTE
} 2>&1)"

printf '%s\n' "${OUTPUT}"

value_for() {
  local label="$1"
  printf '%s\n' "${OUTPUT}" | awk -v label="${label}:" '$0 ~ "\\[sg01-readiness\\]" && index($0, label) { sub(/^.*: +/, ""); print; exit }'
}

blockers=()
warnings=()

require_present() {
  local label="$1"
  local value
  value="$(value_for "${label}")"
  if [[ "${value}" == missing* || -z "${value}" ]]; then
    blockers+=("${label}: ${value:-missing}")
  fi
}

require_present "lab repo"
require_present "bun"
require_present "node"
require_present "python3"
require_present "zellij"
require_present "tmux"
require_present "git"
require_present "zellij listener :8082"
require_present "plugin hooks"
require_present "interactive helper"

bridge_health_value="$(value_for "bridge health")"
if [[ "${bridge_health_value}" == unreachable* || "${bridge_health_value}" == "curl missing" || -z "${bridge_health_value}" ]]; then
  blockers+=("bridge health: ${bridge_health_value:-unreachable}")
fi

bridge_service_value="$(value_for "bridge service")"
if [[ "${bridge_service_value}" != "active" ]]; then
  blockers+=("bridge service: ${bridge_service_value:-missing}")
fi

bridge_service_enabled_value="$(value_for "bridge service enabled")"
if [[ "${bridge_service_enabled_value}" != "enabled" ]]; then
  warnings+=("bridge service enabled: ${bridge_service_enabled_value:-unknown}")
fi

claude_value="$(value_for "claude")"
free_code_value="$(value_for "free-code")"
if [[ "${claude_value}" == missing* && "${free_code_value}" == missing* ]]; then
  blockers+=("runtime: claude and free-code are both missing")
fi

claude_auth_value="$(value_for "claude auth")"
if [[ "${claude_value}" != missing* && ( "${claude_auth_value}" == missing* || -z "${claude_auth_value}" ) ]]; then
  blockers+=("claude auth: ${claude_auth_value:-missing}")
elif [[ "${claude_auth_value}" == onboarding* ]]; then
  blockers+=("claude auth: credential env not set")
fi

zellij_session_value="$(value_for "zellij session ${ZELLIJ_SESSION_NAME}")"
if [[ "${zellij_session_value}" == missing* || -z "${zellij_session_value}" ]]; then
  warnings+=("zellij session ${ZELLIJ_SESSION_NAME}: ${zellij_session_value:-missing}")
fi

bridge_value="$(value_for "bridge listener :${BRIDGE_PORT}")"
if [[ "${bridge_value}" == "not running" || -z "${bridge_value}" ]]; then
  warnings+=("bridge listener :${BRIDGE_PORT}: ${bridge_value:-not running}")
fi

if (( ${#blockers[@]} == 0 )); then
  echo "[sg01-readiness] strict blockers: none"
else
  echo "[sg01-readiness] strict blockers:"
  for blocker in "${blockers[@]}"; do
    echo "[sg01-readiness]   - ${blocker}"
  done
fi

if (( ${#warnings[@]} > 0 )); then
  echo "[sg01-readiness] warnings:"
  for warning in "${warnings[@]}"; do
    echo "[sg01-readiness]   - ${warning}"
  done
fi

if [[ -n "${REPORT_PATH}" ]]; then
  mkdir -p "$(dirname "${REPORT_PATH}")"
  {
    echo "# sg01 Live Capture Readiness Report"
    echo
    echo "## TL;DR"
    echo
    if (( ${#blockers[@]} == 0 )); then
      echo "- Strict status: pass."
    else
      echo "- Strict status: blocked."
    fi
    echo "- Blockers: ${#blockers[@]}."
    echo "- Warnings: ${#warnings[@]}."
    echo "- This report is read-only and does not prove live hook emission."
    echo
    echo "## Raw Readiness Output"
    echo
    echo '```text'
    printf '%s\n' "${OUTPUT}"
    echo '```'
    echo
    echo "## Blockers"
    echo
    if (( ${#blockers[@]} == 0 )); then
      echo "- none"
    else
      for blocker in "${blockers[@]}"; do
        echo "- ${blocker}"
      done
    fi
    echo
    echo "## Warnings"
    echo
    if (( ${#warnings[@]} == 0 )); then
      echo "- none"
    else
      for warning in "${warnings[@]}"; do
        echo "- ${warning}"
      done
    fi
    echo
    echo "## Next Step"
    echo
    if (( ${#blockers[@]} == 0 )); then
      echo "Run the next focused live capture batch from a tmux session inside Zellij web, then inspect the generated artifact report."
    else
      echo "Resolve the listed blockers without pasting secrets into git or shell history, then rerun this checker before attempting CAPTURE_BATCH=safe-lifecycle."
    fi
  } >"${REPORT_PATH}"
  echo "[sg01-readiness] report: ${REPORT_PATH}"
fi

if [[ "${STRICT}" == "true" && ${#blockers[@]} -gt 0 ]]; then
  exit 1
fi
