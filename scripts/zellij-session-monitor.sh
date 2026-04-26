#!/usr/bin/env bash
# Zellij Session Monitor - shell-based fallback for session-bridge WASM plugin
# Polls Zellij state via CLI and POSTs changes to the Star Office Bridge
#
# The WASM plugin requires interactive WebAccess permission grant via Zellij web UI,
# which cannot be automated over SSH. This script provides the same functionality
# using zellij CLI actions polled at a configurable interval.
set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:4317}"
HOOK_PATH="${HOOK_PATH:-/hook/claude}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"
SESSION_NAME="${ZELLIJ_SESSION_NAME:-}"

if [[ -z "$SESSION_NAME" ]]; then
  echo 'ZELLIJ_SESSION_NAME is required' >&2
  exit 1
fi

last_pane_count=0
last_tab_count=0
last_tabs=''

post_event() {
  local json_body="$1"
  curl -sfS -X POST "${BRIDGE_URL}${HOOK_PATH}" \
    -H 'Content-Type: application/json' \
    -d "$json_body" >/dev/null 2>&1 || true
}

echo "[zellij-monitor] watching session: ${SESSION_NAME} interval: ${POLL_INTERVAL}s bridge: ${BRIDGE_URL}"

while true; do
  # Get pane count
  pane_output="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-panes 2>/dev/null || echo '')"
  if [[ -n "$pane_output" ]]; then
    pane_count="$(echo "$pane_output" | grep -c '^terminal_' || true)"
    if [[ "$pane_count" -ne "$last_pane_count" ]]; then
      focused="$(echo "$pane_output" | grep 'terminal_' | head -1 | awk '{print $3}' | sed 's/"//g')"
      post_event "{\"hook_event_name\":\"FileChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"/\",\"zellij_event\":\"pane_update\",\"total_panes\":$pane_count,\"focused_titles\":[\"$focused\"]}"
      last_pane_count="$pane_count"
    fi
  fi

  # Get tab info
  tab_output="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-tabs 2>/dev/null || echo '')"
  if [[ -n "$tab_output" ]]; then
    tab_count="$(echo "$tab_output" | wc -l | tr -d ' ')"
    if [[ "$tab_count" -ne "$last_tab_count" || "$tab_output" != "$last_tabs" ]]; then
      active="$(echo "$tab_output" | grep -oP '(?<=\[active\]) \S+' | head -1 || echo '')"
      post_event "{\"hook_event_name\":\"CwdChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"/\",\"zellij_event\":\"tab_update\",\"tab_count\":$tab_count,\"active_tab\":\"$active\"}"
      last_tab_count="$tab_count"
      last_tabs="$tab_output"
    fi
  fi

  sleep "$POLL_INTERVAL"
done
