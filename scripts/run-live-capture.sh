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
LIVE_CAPTURE_PROFILE="${LIVE_CAPTURE_PROFILE:-default}"
MAX_BRIDGE_PORT_ATTEMPTS="${MAX_BRIDGE_PORT_ATTEMPTS:-8}"
BRIDGE_URL="http://${BRIDGE_HOST}:${BRIDGE_PORT}"
EVENTS_LOG="${REPO_ROOT}/tmp/events.ndjson"
BRIDGE_LOG="${REPO_ROOT}/tmp/live-bridge.log"

usage() {
  cat <<EOF
Usage: ./scripts/run-live-capture.sh [free-code args...]

Starts the lab bridge, wires the draft plugin into the local free-code runtime,
and captures raw hook traffic in tmp/events.ndjson.

If no free-code args are provided, the helper defaults to a short noninteractive
print-mode run that should emit real hook traffic without pausing for permissions.

Environment overrides:
  FREE_CODE_ROOT       Default: /Users/karlchow/Desktop/code/free-code
  FREE_CODE_ENTRYPOINT Default: <FREE_CODE_ROOT>/src/entrypoints/cli.tsx
  CLAUDE_PLUGIN_DIR    Default: <lab repo>/plugins/claude-star-office-bridge
  BRIDGE_HOST          Default: 127.0.0.1
  BRIDGE_PORT          Default: 4317
  BRIDGE_DRY_RUN       Default: true
  LIVE_CAPTURE_PROFILE Default: default (or team-notification)
  MAX_BRIDGE_PORT_ATTEMPTS Default: 8
  CLAUDE_STAR_BRIDGE_SECRET Optional shared secret forwarded to the plugin hook handler
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

build_default_runtime_args() {
  case "${LIVE_CAPTURE_PROFILE}" in
    team-notification)
      runtime_args=(
        -p
        "Use the team tool now. Create a team named notif-capture using the team tool. Then spawn one worker named worker-1 in that team with cwd set to the repo root. Have the worker run a simple Bash command that should require permission approval. After dispatching the worker, do nothing else and wait so leader-side notifications can appear."
        --permission-mode
        default
      )
      ;;
    default)
      runtime_args=(
        -p
        "Inspect the current directory, read package.json, and briefly report what this repo is for."
        --permission-mode
        bypassPermissions
      )
      ;;
    *)
      echo "unknown LIVE_CAPTURE_PROFILE: ${LIVE_CAPTURE_PROFILE}" >&2
      exit 1
      ;;
  esac
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
for arg in "$@"; do
  if [[ "${arg}" == "--plugin-dir" || "${arg}" == --plugin-dir=* ]]; then
    plugin_args=()
    break
  fi
done

runtime_args=("$@")
if [[ ${#runtime_args[@]} -eq 0 ]]; then
  build_default_runtime_args
fi

runtime_env=(
  "CLAUDE_STAR_BRIDGE_URL=${BRIDGE_URL}"
  "CLAUDE_STAR_BRIDGE_SECRET=${CLAUDE_STAR_BRIDGE_SECRET:-}"
)

if [[ "${LIVE_CAPTURE_PROFILE}" == "team-notification" ]]; then
  runtime_env+=("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-1}")
fi

echo "[live-capture] bridge: ${BRIDGE_URL}"
echo "[live-capture] plugin: ${PLUGIN_DIR}"
echo "[live-capture] events: ${EVENTS_LOG}"
echo "[live-capture] bridge log: ${BRIDGE_LOG}"

echo "[live-capture] free-code args: ${runtime_args[*]}"

(
  cd "${FREE_CODE_ROOT}"
  env "${runtime_env[@]}" \
    bun run "${FREE_CODE_ENTRYPOINT}" "${plugin_args[@]}" "${runtime_args[@]}"
)
