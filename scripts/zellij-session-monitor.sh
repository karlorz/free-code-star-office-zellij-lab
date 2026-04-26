#!/usr/bin/env bash
# Zellij Session Monitor - shell-based fallback for session-bridge WASM plugin
# Polls Zellij state via CLI (--json mode) and POSTs changes to the Star Office Bridge
#
# The WASM plugin requires interactive WebAccess permission grant via Zellij web UI,
# which cannot be automated over SSH. This script provides the same functionality
# using zellij CLI actions polled at a configurable interval.
set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:4317}"
HOOK_PATH="${HOOK_PATH:-/hook/zellij}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"
SESSION_NAME="${ZELLIJ_SESSION_NAME:-}"

if [[ -z "$SESSION_NAME" ]]; then
  echo 'ZELLIJ_SESSION_NAME is required' >&2
  exit 1
fi

last_pane_count=0
last_tab_count=0
last_active_tab=''

post_event() {
  local json_body="$1"
  curl -sfS -X POST "${BRIDGE_URL}${HOOK_PATH}" \
    -H 'Content-Type: application/json' \
    -d "$json_body" >/dev/null 2>&1 || true
}

echo "[zellij-monitor] watching session: ${SESSION_NAME} interval: ${POLL_INTERVAL}s bridge: ${BRIDGE_URL}"

while true; do
  # Get pane info via JSON
  pane_json="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-panes --json 2>/dev/null || echo '[]')"
  if [[ "$pane_json" != '[]' ]]; then
    pane_count="$(echo "$pane_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(1 for p in d if not p.get("is_plugin")))')"
    if [[ "$pane_count" -ne "$last_pane_count" ]]; then
      focused="$(echo "$pane_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
titles = [p["title"] for p in d if not p.get("is_plugin") and p.get("is_focused")]
print(json.dumps(titles))
' 2>/dev/null || echo '[]')"
      post_event "{\"hook_event_name\":\"FileChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"/\",\"zellij_event\":\"pane_update\",\"total_panes\":$pane_count,\"focused_titles\":$focused}"
      last_pane_count="$pane_count"
    fi
  fi

  # Get tab info via JSON
  tab_json="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-tabs --json 2>/dev/null || echo '[]')"
  if [[ "$tab_json" != '[]' ]]; then
    tab_count="$(echo "$tab_json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
    active_tab="$(echo "$tab_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for t in d:
    if t.get("active"):
        print(t.get("name",""))
        break
else:
    print("")
' 2>/dev/null || echo '')"
    if [[ "$tab_count" -ne "$last_tab_count" || "$active_tab" != "$last_active_tab" ]]; then
      tab_names="$(echo "$tab_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(json.dumps([t.get("name","") for t in d]))
' 2>/dev/null || echo '[]')"
      post_event "{\"hook_event_name\":\"CwdChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"/\",\"zellij_event\":\"tab_update\",\"tab_count\":$tab_count,\"tabs\":$tab_names,\"active_tab\":\"$active_tab\"}"
      last_tab_count="$tab_count"
      last_active_tab="$active_tab"
    fi
  fi

  sleep "$POLL_INTERVAL"
done
