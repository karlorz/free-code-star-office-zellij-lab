#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FREE_CODE_ROOT="${FREE_CODE_ROOT:-/Users/karlchow/Desktop/code/free-code}"
FREE_CODE_ENTRYPOINT="${FREE_CODE_ENTRYPOINT:-${FREE_CODE_ROOT}/src/entrypoints/cli.tsx}"
PLUGIN_DIR="${CLAUDE_PLUGIN_DIR:-${REPO_ROOT}/plugins/claude-star-office-bridge}"
BRIDGE_HOST="${BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${BRIDGE_PORT:-4317}"
BRIDGE_DRY_RUN="${BRIDGE_DRY_RUN:-true}"
MAX_BRIDGE_PORT_ATTEMPTS="${MAX_BRIDGE_PORT_ATTEMPTS:-8}"
PERMISSION_MODE="${PERMISSION_MODE:-default}"
ZELLIJ_WEB_URL="${ZELLIJ_WEB_URL:-https://term.karldigi.dev/main}"
ZELLIJ_SESSION_NAME="${ZELLIJ_SESSION_NAME:-}"
ZELLIJ_WEB_TOKEN="${ZELLIJ_WEB_TOKEN:-}"
BRIDGE_URL="http://${BRIDGE_HOST}:${BRIDGE_PORT}"
EVENTS_LOG="${REPO_ROOT}/tmp/events.ndjson"
BRIDGE_LOG="${REPO_ROOT}/tmp/live-bridge.log"

if [[ -z "${LEADER_PROMPT:-}" ]]; then
  LEADER_PROMPT="Use the team tool now. Create a team named notif-capture. Then spawn one worker named worker-1 in that team with cwd set to ${REPO_ROOT}. Have the worker run a Bash tool call for: touch worker-permission-probe.txt. After dispatching the worker, do nothing else and wait so leader-side notifications can appear."
fi

usage() {
  cat <<EOF
Usage: ./scripts/run-interactive-notification-capture.sh [free-code args...]

Starts the lab bridge, wires the draft plugin into the local free-code runtime,
and launches an interactive leader session for notification capture.

This helper is intended to be run inside a pane-capable terminal environment
(such as tmux or iTerm2) so teammate execution can avoid the noninteractive
in-process fallback used by -p/--print runs.

Environment overrides:
  FREE_CODE_ROOT       Default: /Users/karlchow/Desktop/code/free-code
  FREE_CODE_ENTRYPOINT Default: <FREE_CODE_ROOT>/src/entrypoints/cli.tsx
  CLAUDE_PLUGIN_DIR    Default: <lab repo>/plugins/claude-star-office-bridge
  BRIDGE_HOST          Default: 127.0.0.1
  BRIDGE_PORT          Default: 4317
  BRIDGE_DRY_RUN       Default: true
  MAX_BRIDGE_PORT_ATTEMPTS Default: 8
  PERMISSION_MODE      Default: default
  CLAUDE_STAR_BRIDGE_SECRET Optional shared secret forwarded to the plugin hook handler
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS Default: 1
  LEADER_PROMPT        Optional prompt text to paste into the interactive leader session
  ZELLIJ_WEB_URL       Default: https://term.karldigi.dev/main
  ZELLIJ_SESSION_NAME  Optional expected session name in sg01 Zellij web
  ZELLIJ_WEB_TOKEN     Optional operator token; only set/unset status is printed
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ ! -d "${FREE_CODE_ROOT}" ]]; then
  echo "free-code root does not exist: ${FREE_CODE_ROOT}" >&2
  exit 1
fi

if [[ ! -f "${FREE_CODE_ENTRYPOINT}" ]]; then
  echo "free-code entrypoint does not exist: ${FREE_CODE_ENTRYPOINT}" >&2
  exit 1
fi

if [[ ! -d "${PLUGIN_DIR}" ]]; then
  echo "plugin dir does not exist: ${PLUGIN_DIR}" >&2
  exit 1
fi

cleanup() {
  if [[ -n "${BRIDGE_PID:-}" ]]; then
    kill "${BRIDGE_PID}" >/dev/null 2>&1 || true
    wait "${BRIDGE_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

bridge_pid_alive() {
  [[ -n "${BRIDGE_PID:-}" ]] && kill -0 "${BRIDGE_PID}" >/dev/null 2>&1
}

port_in_use() {
  python3 - "$BRIDGE_HOST" "$1" <<'PY'
import socket
import sys
host = sys.argv[1]
port = int(sys.argv[2])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((host, port))
    except OSError:
        sys.exit(0)
    sys.exit(1)
PY
}

pick_bridge_port() {
  local candidate="${BRIDGE_PORT}"
  local attempts=0
  while (( attempts < MAX_BRIDGE_PORT_ATTEMPTS )); do
    if ! port_in_use "${candidate}"; then
      BRIDGE_PORT="${candidate}"
      BRIDGE_URL="http://${BRIDGE_HOST}:${BRIDGE_PORT}"
      return 0
    fi
    candidate="$((candidate + 1))"
    attempts="$((attempts + 1))"
  done

  echo "unable to find a free bridge port starting at ${BRIDGE_PORT}" >&2
  exit 1
}

bridge_ready() {
  grep -Fq "[bridge] listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}" "${BRIDGE_LOG}" && \
    curl -fsS "${BRIDGE_URL}/health" >/dev/null 2>&1
}

fail_bridge_start() {
  echo "bridge failed to start on ${BRIDGE_URL}" >&2
  cat "${BRIDGE_LOG}" >&2
  exit 1
}

mkdir -p "${REPO_ROOT}/tmp"
rm -f "${EVENTS_LOG}"
: > "${BRIDGE_LOG}"

pick_bridge_port

(
  cd "${REPO_ROOT}"
  BRIDGE_HOST="${BRIDGE_HOST}" \
  BRIDGE_PORT="${BRIDGE_PORT}" \
  BRIDGE_DRY_RUN="${BRIDGE_DRY_RUN}" \
  bun run src/index.ts >>"${BRIDGE_LOG}" 2>&1
) &
BRIDGE_PID=$!

for _ in $(seq 1 50); do
  if bridge_ready; then
    break
  fi
  if ! bridge_pid_alive; then
    fail_bridge_start
  fi
  sleep 0.1
done

if ! bridge_pid_alive || ! bridge_ready; then
  fail_bridge_start
fi

plugin_args=(--plugin-dir "${PLUGIN_DIR}")
permission_mode_seen=false
for arg in "$@"; do
  if [[ "${arg}" == "--plugin-dir" || "${arg}" == --plugin-dir=* ]]; then
    plugin_args=()
  fi
  if [[ "${arg}" == "--permission-mode" || "${arg}" == --permission-mode=* ]]; then
    permission_mode_seen=true
  fi
done

runtime_args=("$@")
if [[ "${permission_mode_seen}" == false ]]; then
  runtime_args=(--permission-mode "${PERMISSION_MODE}" "${runtime_args[@]}")
fi

runtime_env=(
  "CLAUDE_STAR_BRIDGE_URL=${BRIDGE_URL}"
  "CLAUDE_STAR_BRIDGE_SECRET=${CLAUDE_STAR_BRIDGE_SECRET:-}"
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-1}"
)

zellij_token_status="unset"
if [[ -n "${ZELLIJ_WEB_TOKEN}" ]]; then
  zellij_token_status="set (redacted)"
fi

zellij_session_label="not specified"
if [[ -n "${ZELLIJ_SESSION_NAME}" ]]; then
  zellij_session_label="${ZELLIJ_SESSION_NAME}"
fi

echo "[interactive-capture] bridge: ${BRIDGE_URL}"
echo "[interactive-capture] plugin: ${PLUGIN_DIR}"
echo "[interactive-capture] events: ${EVENTS_LOG}"
echo "[interactive-capture] bridge log: ${BRIDGE_LOG}"
echo "[interactive-capture] free-code args: ${runtime_args[*]}"
echo "[interactive-capture] sg01 Zellij web: ${ZELLIJ_WEB_URL}"
echo "[interactive-capture] sg01 Zellij session: ${zellij_session_label}"
echo "[interactive-capture] sg01 Zellij web token: ${zellij_token_status}"
echo "[interactive-capture] operator checklist:"
echo "  1. Open the sg01 Zellij web URL above."
echo "  2. Provide the Zellij web token in the browser/operator flow when prompted; do not paste it into this repo."
echo "  3. Attach to the expected session if one is configured."
echo "  4. Use the interactive leader session launched by this script."
echo "  5. Create the team from the leader session, not from -p/--print mode."
echo "  6. Trigger the worker permission probe: touch worker-permission-probe.txt."
echo "[interactive-capture] recommended leader prompt:"
printf '%s\n' "${LEADER_PROMPT}"

(
  cd "${FREE_CODE_ROOT}"
  env "${runtime_env[@]}" \
    bun run "${FREE_CODE_ENTRYPOINT}" "${plugin_args[@]}" "${runtime_args[@]}"
)

cat <<EOF
[interactive-capture] capture finished
[interactive-capture] review artifact: ${EVENTS_LOG}
[interactive-capture] success patterns to inspect:
  - Notification events for leader-side worker permission prompts
  - permission_request or PermissionRequest control-plane payloads
  - TaskCreated events that identify worker ownership
  - TaskCompleted or SubagentStop events that cleanly remove workers
[interactive-capture] bridge log: ${BRIDGE_LOG}
EOF
