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

# Wait for bridge to be available before polling
max_wait=30
waited=0
while ! curl -sf "${BRIDGE_URL}/health" >/dev/null 2>&1; do
  if [[ $waited -ge $max_wait ]]; then
    echo "[zellij-monitor] bridge not available after ${max_wait}s, exiting" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

last_pane_count=0
last_tab_count=0
last_active_tab=''
last_focused_titles=''
last_focused_cwd=''
last_focused_command=''
last_client_count=0

post_event() {
  local json_body="$1"
  curl -sfS -X POST "${BRIDGE_URL}${HOOK_PATH}" \
    -H 'Content-Type: application/json' \
    -d "$json_body" >/dev/null 2>&1 || true
}

echo "[zellij-monitor] watching session: ${SESSION_NAME} interval: ${POLL_INTERVAL}s bridge: ${BRIDGE_URL}"

# Helper: extract focused pane metadata from list-panes JSON
# Outputs: pane_count|focused_titles_json|focused_cwd|focused_terminal_command|exited_panes_json
extract_pane_metadata() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
terminals = [p for p in d if not p.get("is_plugin")]
pane_count = len(terminals)
focused = [p for p in terminals if p.get("is_focused")]
focused_titles = [p["title"] for p in focused]
focused_cwd = focused[0].get("pane_cwd","") if focused else ""
focused_cmd = focused[0].get("terminal_command","") or focused[0].get("pane_command","") if focused else ""
exited = [{"id":p["id"],"exit_status":p.get("exit_status"),"is_held":p.get("is_held",False),"title":p.get("title","")} for p in terminals if p.get("exited")]
floating = sum(1 for p in terminals if p.get("is_floating"))
print(json.dumps({
  "pane_count": pane_count,
  "focused_titles": focused_titles,
  "focused_cwd": focused_cwd,
  "focused_command": focused_cmd,
  "exited_panes": exited,
  "floating_count": floating
}))
' 2>/dev/null
}

# Push initial state on startup
pane_json="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-panes --json 2>/dev/null)"
if [[ -n "$pane_json" ]]; then
  meta="$(echo "$pane_json" | extract_pane_metadata)"
  pane_count="$(echo "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pane_count"])')"
  focused="$(echo "$meta" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["focused_titles"]))')"
  focused_cwd="$(echo "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["focused_cwd"])')"
  focused_cmd="$(echo "$meta" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["focused_command"])')"
  exited="$(echo "$meta" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["exited_panes"]))')"

  last_pane_count="$pane_count"
  last_focused_titles="$focused"
  last_focused_cwd="$focused_cwd"
  last_focused_command="$focused_cmd"
  post_event "{\"hook_event_name\":\"FileChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"${focused_cwd}\",\"zellij_event\":\"pane_update\",\"total_panes\":$pane_count,\"focused_titles\":$focused,\"terminal_command\":\"${focused_cmd}\",\"exited_panes\":$exited}"
fi
tab_json="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-tabs --json 2>/dev/null)"
if [[ -n "$tab_json" ]]; then
  tab_count="$(echo "$tab_json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
  active_tab="$(echo "$tab_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for t in d:
    if t.get("active"):
        print(t.get("name",""))
        break
else:
    if d:
        print(d[0].get("name",""))
    else:
        print("")
' 2>/dev/null || echo '')"
  tab_names="$(echo "$tab_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(json.dumps([t.get("name","") for t in d]))
' 2>/dev/null || echo '[]')"
  last_tab_count="$tab_count"
  last_active_tab="$active_tab"
  post_event "{\"hook_event_name\":\"CwdChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"/\",\"zellij_event\":\"tab_update\",\"tab_count\":$tab_count,\"tabs\":$tab_names,\"active_tab\":\"$active_tab\"}"
fi

while true; do
  # Get pane info via JSON with full metadata
  pane_json="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-panes --json 2>/dev/null)"
  if [[ -n "$pane_json" ]]; then
    meta="$(echo "$pane_json" | extract_pane_metadata)"
    pane_count="$(echo "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pane_count"])')"
    focused="$(echo "$meta" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["focused_titles"]))')"
    focused_cwd="$(echo "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["focused_cwd"])')"
    focused_cmd="$(echo "$meta" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["focused_command"])')"
    exited="$(echo "$meta" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["exited_panes"]))')"

    if [[ "$pane_count" -ne "$last_pane_count" || "$focused" != "$last_focused_titles" ]]; then
      post_event "{\"hook_event_name\":\"FileChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"${focused_cwd}\",\"zellij_event\":\"pane_update\",\"total_panes\":$pane_count,\"focused_titles\":$focused,\"terminal_command\":\"${focused_cmd}\",\"exited_panes\":$exited}"
      last_pane_count="$pane_count"
      last_focused_titles="$focused"
    fi
    if [[ "$focused_cwd" != "$last_focused_cwd" && -n "$focused_cwd" ]]; then
      post_event "{\"hook_event_name\":\"CwdChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"${focused_cwd}\",\"zellij_event\":\"cwd_change\",\"focused_titles\":$focused,\"terminal_command\":\"${focused_cmd}\"}"
      last_focused_cwd="$focused_cwd"
    fi
    if [[ "$focused_cmd" != "$last_focused_command" ]]; then
      post_event "{\"hook_event_name\":\"Setup\",\"session_id\":\"zellij-monitor\",\"cwd\":\"${focused_cwd}\",\"zellij_event\":\"command_change\",\"terminal_command\":\"${focused_cmd}\",\"focused_titles\":$focused}"
      last_focused_command="$focused_cmd"
    fi
    # Detect pane exits
    exited_count="$(echo "$exited" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
    if [[ "$exited_count" -gt 0 ]]; then
      # Post individual exit events
      echo "$exited" | python3 -c "
import json, sys
for p in json.load(sys.stdin):
    exit_status = p.get('exit_status')
    is_held = p.get('is_held', False)
    title = p.get('title', '')
    print(f'{p[\"id\"]}|{exit_status}|{is_held}|{title}')
" 2>/dev/null | while IFS='|' read -r pid estat held title; do
        post_event "{\"hook_event_name\":\"Stop\",\"session_id\":\"zellij-monitor\",\"cwd\":\"${focused_cwd}\",\"zellij_event\":\"pane_exit\",\"pane_id\":${pid},\"exit_status\":${estat:-null},\"is_held\":${held},\"title\":\"${title}\"}"
      done
    fi
  fi

  # Get tab info via JSON
  tab_json="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-tabs --json 2>/dev/null)"
  if [[ -n "$tab_json" ]]; then
    tab_count="$(echo "$tab_json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
    active_tab="$(echo "$tab_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for t in d:
    if t.get("active"):
        print(t.get("name",""))
        break
else:
    if d:
        print(d[0].get("name",""))
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

  # Get client count (tabular output, no --json)
  client_output="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-clients 2>/dev/null || true)"
  if [[ -n "$client_output" ]]; then
    client_count="$(echo "$client_output" | tail -n +2 | grep -c '.' || true)"
    client_count="${client_count// /}"
    client_count="${client_count:-0}"
  else
    client_count=0
  fi
  if [[ "$client_count" -ne "$last_client_count" ]]; then
    post_event "{\"hook_event_name\":\"Elicitation\",\"session_id\":\"zellij-monitor\",\"cwd\":\"/\",\"zellij_event\":\"client_update\",\"client_count\":$client_count}"
    last_client_count="$client_count"
  fi

  sleep "$POLL_INTERVAL"
done
