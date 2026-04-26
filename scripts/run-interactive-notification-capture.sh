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
CAPTURE_BATCH="${CAPTURE_BATCH:-safe-lifecycle}"
ALLOW_RISKY_CAPTURE="${ALLOW_RISKY_CAPTURE:-false}"
BRIDGE_URL="http://${BRIDGE_HOST}:${BRIDGE_PORT}"
EVENTS_LOG="${REPO_ROOT}/tmp/events.ndjson"
BRIDGE_LOG="${REPO_ROOT}/tmp/live-bridge.log"
POST_CAPTURE_CHECK="${POST_CAPTURE_CHECK:-true}"
POST_CAPTURE_REPORT="${POST_CAPTURE_REPORT:-${REPO_ROOT}/tmp/live-capture-report.md}"
CAPTURE_SSE_PROOF="${CAPTURE_SSE_PROOF:-false}"
SSE_PROOF_PATH="${SSE_PROOF_PATH:-${REPO_ROOT}/tmp/live-sse-proof.txt}"
REMOTE_BRIDGE="${REMOTE_BRIDGE:-false}"

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
  CAPTURE_BATCH        Default: safe-lifecycle; use --list-batches for options
  ALLOW_RISKY_CAPTURE  Default: false; required for risky trigger guidance
  POST_CAPTURE_CHECK   Default: true; run read-only artifact checker after runtime exits
  POST_CAPTURE_REPORT  Default: <lab repo>/tmp/live-capture-report.md
  CAPTURE_SSE_PROOF    Default: false; save a /events SSE transcript during runtime
  SSE_PROOF_PATH       Default: <lab repo>/tmp/live-sse-proof.txt
  REMOTE_BRIDGE        Default: false; skip local bridge startup, connect to existing bridge
EOF
}

list_batches() {
  cat <<EOF
Capture batches:
  safe-lifecycle
    Low-risk default. Targets PermissionRequest, Notification, SubagentStart,
    SubagentStop, TaskCreated, TaskCompleted, and TeammateIdle via an
    interactive team/worker flow.

  config-file-watch
    Low-risk operator batch. Targets Setup, CwdChanged, FileChanged,
    InstructionsLoaded, and ConfigChange. Requires a matching FileChanged hook.

  worktree
    Medium-risk local isolation batch. Targets WorktreeCreate and WorktreeRemove.
    Use only when temporary worktrees are acceptable.

  compaction
    Medium-risk session-management batch. Targets PreCompact and PostCompact.
    Use only when compaction is acceptable for the current session.

  risky-denial
    Risky batch. Targets PermissionDenied and StopFailure. Requires
    ALLOW_RISKY_CAPTURE=true and explicit operator judgment. Prefer documenting
    these as deferred instead of forcing dangerous or context-overflow triggers.
EOF
}

print_batch_guidance() {
  case "${CAPTURE_BATCH}" in
    safe-lifecycle)
      cat <<EOF
[interactive-capture] selected batch: safe-lifecycle
[interactive-capture] target events:
  - PermissionRequest
  - Notification
  - SubagentStart
  - SubagentStop
  - TaskCreated
  - TaskCompleted
  - TeammateIdle
[interactive-capture] trigger guidance:
  1. Create the team from the leader session.
  2. Spawn one worker.
  3. Have the worker run a harmless command that requires permission in default mode.
  4. Approve or deny only after the event appears in the bridge log.
EOF
      ;;
    config-file-watch)
      cat <<EOF
[interactive-capture] selected batch: config-file-watch
[interactive-capture] target events:
  - Setup
  - CwdChanged
  - FileChanged
  - InstructionsLoaded
  - ConfigChange
[interactive-capture] trigger guidance:
  1. Start a fresh session with the plugin enabled.
  2. Change cwd through the runtime/operator flow.
  3. Modify a non-secret scratch file covered by a FileChanged hook matcher.
  4. Change a safe runtime setting if ConfigChange coverage is needed.
EOF
      ;;
    worktree)
      cat <<EOF
[interactive-capture] selected batch: worktree
[interactive-capture] target events:
  - WorktreeCreate
  - WorktreeRemove
[interactive-capture] trigger guidance:
  1. Start a temporary worktree through the runtime/operator flow.
  2. Exit and remove it after confirming capture.
  3. Do not use this batch if uncommitted work could be discarded.
EOF
      ;;
    compaction)
      cat <<EOF
[interactive-capture] selected batch: compaction
[interactive-capture] target events:
  - PreCompact
  - PostCompact
[interactive-capture] trigger guidance:
  1. Trigger manual compaction only when it is safe for the session.
  2. Confirm both pre- and post-compaction events in tmp/events.ndjson.
EOF
      ;;
    risky-denial)
      if [[ "${ALLOW_RISKY_CAPTURE}" != "true" ]]; then
        echo "risky-denial batch requires ALLOW_RISKY_CAPTURE=true" >&2
        exit 1
      fi
      cat <<EOF
[interactive-capture] selected batch: risky-denial
[interactive-capture] target events:
  - PermissionDenied
  - StopFailure
[interactive-capture] trigger guidance:
  1. Do not run destructive commands just to capture these events.
  2. Prefer a safe classifier-denied command or defer PermissionDenied.
  3. Prefer deferring StopFailure instead of forcing context overflow.
EOF
      ;;
    *)
      echo "unknown CAPTURE_BATCH: ${CAPTURE_BATCH}" >&2
      echo "run with --list-batches to see supported values" >&2
      exit 1
      ;;
  esac
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--list-batches" ]]; then
  list_batches
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
  if [[ -n "${SSE_PROOF_PID:-}" ]]; then
    kill "${SSE_PROOF_PID}" >/dev/null 2>&1 || true
    wait "${SSE_PROOF_PID}" >/dev/null 2>&1 || true
  fi
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

start_sse_proof_capture() {
  if [[ "${CAPTURE_SSE_PROOF}" != "true" ]]; then
    return 0
  fi

  : > "${SSE_PROOF_PATH}"
  python3 -u - "${BRIDGE_URL}" >"${SSE_PROOF_PATH}" 2>&1 <<'PY' &
import http.client
import sys

url_parts = sys.argv[1].replace("http://", "").split(":", 1)
host = url_parts[0]
port = int(url_parts[1])

conn = http.client.HTTPConnection(host, port)
conn.request("GET", "/events")
resp = conn.getresponse()
print(f"Status: {resp.status}", flush=True)
print(f"Content-Type: {resp.getheader('Content-Type')}", flush=True)
print(f"Cache-Control: {resp.getheader('Cache-Control')}", flush=True)

try:
    while True:
        chunk = resp.read(1)
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
except Exception:
    pass
finally:
    conn.close()
PY
  SSE_PROOF_PID=$!
  sleep 0.5
  if ! kill -0 "${SSE_PROOF_PID}" >/dev/null 2>&1; then
    echo "SSE proof capture failed to start" >&2
    cat "${SSE_PROOF_PATH}" >&2
    exit 1
  fi
}

stop_sse_proof_capture() {
  if [[ -z "${SSE_PROOF_PID:-}" ]]; then
    return 0
  fi
  kill "${SSE_PROOF_PID}" >/dev/null 2>&1 || true
  wait "${SSE_PROOF_PID}" >/dev/null 2>&1 || true
  unset SSE_PROOF_PID
}

mkdir -p "${REPO_ROOT}/tmp"
rm -f "${EVENTS_LOG}"

if [[ "${REMOTE_BRIDGE}" == "true" ]]; then
  # Skip local bridge startup — use an already-running bridge (e.g., systemd on sg01)
  if ! curl -fsS "${BRIDGE_URL}/health" >/dev/null 2>&1; then
    echo "remote bridge not reachable at ${BRIDGE_URL}" >&2
    exit 1
  fi
  echo "[interactive-capture] using remote bridge at ${BRIDGE_URL}"
else
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

# Construct attach URL hint (token redacted)
zellij_attach_hint="N/A (no token)"
if [[ -n "${ZELLIJ_WEB_TOKEN}" && -n "${ZELLIJ_WEB_URL}" ]]; then
  zellij_attach_hint="${ZELLIJ_WEB_URL}?token=<redacted>"
fi

echo "[interactive-capture] bridge: ${BRIDGE_URL}"
echo "[interactive-capture] plugin: ${PLUGIN_DIR}"
echo "[interactive-capture] events: ${EVENTS_LOG}"
echo "[interactive-capture] bridge log: ${BRIDGE_LOG}"
echo "[interactive-capture] free-code args: ${runtime_args[*]}"
echo ""
echo "[interactive-capture] === sg01 Zellij Web Checklist ==="
echo "  Web URL:    ${ZELLIJ_WEB_URL}"
echo "  Session:    ${zellij_session_label}"
echo "  Token:      ${zellij_token_status}"
echo "  Attach:     ${zellij_attach_hint}"
echo ""
echo "[interactive-capture] operator checklist:"
echo "  1. Open the sg01 Zellij web URL above (or use the attach URL with your token)."
echo "  2. Provide the Zellij web token in the browser/operator flow when prompted; do not paste it into this repo."
echo "  3. Attach to the expected session if one is configured."
echo "  4. If using a remote bridge (REMOTE_BRIDGE=true), the dashboard is at ${BRIDGE_URL}/events/test"
echo "  5. Use the interactive leader session launched by this script."
echo "  6. Follow the selected capture batch guidance below."
echo ""
echo "[interactive-capture] worker permission probe:"
echo "  - Trigger: have a worker run a command requiring permission in default mode"
echo "  - Expected: PermissionRequest event in bridge log"
echo "  - After: approve or deny only after the event appears"
echo ""
print_batch_guidance
echo "[interactive-capture] recommended leader prompt:"
printf '%s\n' "${LEADER_PROMPT}"

start_sse_proof_capture

runtime_status=0
(
  cd "${FREE_CODE_ROOT}"
  env "${runtime_env[@]}" \
    bun run "${FREE_CODE_ENTRYPOINT}" "${plugin_args[@]}" "${runtime_args[@]}"
) || runtime_status=$?

stop_sse_proof_capture

cat <<EOF
[interactive-capture] capture finished
[interactive-capture] review artifact: ${EVENTS_LOG}
[interactive-capture] success patterns to inspect:
  - Notification events for leader-side worker permission prompts
  - permission_request or PermissionRequest control-plane payloads
  - TaskCreated events that identify worker ownership
  - TaskCompleted or SubagentStop events that cleanly remove workers
[interactive-capture] bridge log: ${BRIDGE_LOG}
[interactive-capture] report: ${POST_CAPTURE_REPORT}
EOF
if [[ "${CAPTURE_SSE_PROOF}" == "true" ]]; then
  echo "[interactive-capture] SSE proof: ${SSE_PROOF_PATH}"
fi

if [[ "${POST_CAPTURE_CHECK}" == "true" ]]; then
  echo "[interactive-capture] running read-only post-capture artifact check"
  checker_args=(--batch "${CAPTURE_BATCH}" --report "${POST_CAPTURE_REPORT}")
  if [[ "${CAPTURE_SSE_PROOF}" == "true" ]]; then
    checker_args+=(--sse-proof "${SSE_PROOF_PATH}")
  fi
  if ! bash "${SCRIPT_DIR}/check-live-capture-artifact.sh" "${checker_args[@]}" "${EVENTS_LOG}"; then
    echo "[interactive-capture] post-capture artifact check reported missing live events for batch: ${CAPTURE_BATCH}" >&2
  fi
fi

exit "${runtime_status}"
