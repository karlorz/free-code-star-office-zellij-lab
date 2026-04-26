#!/usr/bin/env bash
# Zellij Session Monitor - shell-based fallback for session-bridge WASM plugin
# Polls Zellij state via CLI (--json mode) and POSTs changes to the Star Office Bridge
#
# The WASM plugin requires interactive WebAccess permission grant via Zellij web UI,
# which cannot be automated over SSH. This script provides the same functionality
# using zellij CLI actions polled at a configurable interval.
set -euo pipefail

# Graceful shutdown on SIGTERM/SIGINT
_running=true
trap '_running=false' TERM INT

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
last_tab_names=''
last_floating_count=0

post_event() {
  local json_body="$1"
  curl -sfS -X POST "${BRIDGE_URL}${HOOK_PATH}" \
    -H 'Content-Type: application/json' \
    -d "$json_body" >/dev/null 2>&1 || true
}

echo "[zellij-monitor] watching session: ${SESSION_NAME} interval: ${POLL_INTERVAL}s bridge: ${BRIDGE_URL}"

# Single-pass pane metadata extraction — outputs shell key=value pairs
# Key=value format: simple scalars are bare, JSON arrays/objects are JSON-encoded
extract_pane_metadata() {
  python3 -c '
import json, sys
try:
  d = json.loads(sys.stdin.read())
except json.JSONDecodeError:
  d = []
terminals = [p for p in d if not p.get("is_plugin")]
focused = [p for p in terminals if p.get("is_focused")]
exited = [{"id":p["id"],"exit_status":p.get("exit_status"),"is_held":p.get("is_held",False),"title":p.get("title","")} for p in terminals if p.get("exited")]
fc = focused[0] if focused else {}
print("pane_count=" + str(len(terminals)))
print("focused_titles=" + json.dumps([p["title"] for p in focused]))
print("focused_cwd=" + fc.get("pane_cwd",""))
print("focused_command=" + (fc.get("terminal_command") or fc.get("pane_command") or ""))
print("exited_panes=" + json.dumps(exited))
print("floating_count=" + str(sum(1 for p in terminals if p.get("is_floating"))))
' 2>/dev/null
}

# Single-pass tab metadata extraction — outputs shell key=value pairs
extract_tab_metadata() {
  python3 -c '
import json, sys
try:
  d = json.loads(sys.stdin.read())
except json.JSONDecodeError:
  d = []
active = ""
for t in d:
  if t.get("active"):
    active = t.get("name","")
    break
else:
  if d:
    active = d[0].get("name","")
print("tab_count=" + str(len(d)))
print("active_tab=" + active)
print("tab_names=" + json.dumps([t.get("name","") for t in d]))
' 2>/dev/null
}

# Read key=value output into associative array
declare -A _meta
read_kv() {
  _meta=()
  local line key value
  while IFS= read -r line; do
    key="${line%%=*}"
    value="${line#*=}"
    _meta["$key"]="$value"
  done
}

# Push initial state on startup
pane_json="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-panes --json 2>/dev/null)"
if [[ -n "$pane_json" ]]; then
  read_kv < <(echo "$pane_json" | extract_pane_metadata)
  pane_count="${_meta[pane_count]:-0}"
  focused_titles="${_meta[focused_titles]:-[]}"
  focused_cwd="${_meta[focused_cwd]:-}"
  focused_command="${_meta[focused_command]:-}"
  exited_panes="${_meta[exited_panes]:-[]}"
  floating_count="${_meta[floating_count]:-0}"

  last_pane_count="$pane_count"
  last_focused_titles="$focused_titles"
  last_focused_cwd="$focused_cwd"
  last_focused_command="$focused_command"
  last_floating_count="$floating_count"
  post_event "{\"hook_event_name\":\"FileChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"${focused_cwd}\",\"zellij_event\":\"pane_update\",\"total_panes\":$pane_count,\"focused_titles\":$focused_titles,\"terminal_command\":\"${focused_command}\",\"exited_panes\":$exited_panes,\"floating_count\":$floating_count}"
fi

tab_json="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-tabs --json 2>/dev/null)"
if [[ -n "$tab_json" ]]; then
  read_kv < <(echo "$tab_json" | extract_tab_metadata)
  tab_count="${_meta[tab_count]:-0}"
  active_tab="${_meta[active_tab]:-}"
  tab_names="${_meta[tab_names]:-[]}"

  last_tab_count="$tab_count"
  last_active_tab="$active_tab"
  last_tab_names="$tab_names"
  post_event "{\"hook_event_name\":\"CwdChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"/\",\"zellij_event\":\"tab_update\",\"tab_count\":$tab_count,\"tabs\":$tab_names,\"active_tab\":\"$active_tab\"}"
fi

while true; do
  # Get pane info via JSON — single python3 pass
  pane_json="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-panes --json 2>/dev/null)"
  if [[ -n "$pane_json" ]]; then
    read_kv < <(echo "$pane_json" | extract_pane_metadata)
    pane_count="${_meta[pane_count]:-0}"
    focused_titles="${_meta[focused_titles]:-[]}"
    focused_cwd="${_meta[focused_cwd]:-}"
    focused_command="${_meta[focused_command]:-}"
    exited_panes="${_meta[exited_panes]:-[]}"
    floating_count="${_meta[floating_count]:-0}"

    if [[ "$pane_count" -ne "$last_pane_count" || "$focused_titles" != "$last_focused_titles" || "$floating_count" -ne "$last_floating_count" ]]; then
      post_event "{\"hook_event_name\":\"FileChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"${focused_cwd}\",\"zellij_event\":\"pane_update\",\"total_panes\":$pane_count,\"focused_titles\":$focused_titles,\"terminal_command\":\"${focused_command}\",\"exited_panes\":$exited_panes,\"floating_count\":$floating_count}"
      last_pane_count="$pane_count"
      last_focused_titles="$focused_titles"
      last_floating_count="$floating_count"
    fi
    if [[ "$focused_cwd" != "$last_focused_cwd" && -n "$focused_cwd" ]]; then
      post_event "{\"hook_event_name\":\"CwdChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"${focused_cwd}\",\"zellij_event\":\"cwd_change\",\"focused_titles\":$focused_titles,\"terminal_command\":\"${focused_command}\"}"
      last_focused_cwd="$focused_cwd"
    fi
    if [[ "$focused_command" != "$last_focused_command" ]]; then
      post_event "{\"hook_event_name\":\"Setup\",\"session_id\":\"zellij-monitor\",\"cwd\":\"${focused_cwd}\",\"zellij_event\":\"command_change\",\"terminal_command\":\"${focused_command}\",\"focused_titles\":$focused_titles}"
      last_focused_command="$focused_command"
    fi
    # Detect pane exits
    exited_count="$(echo "$exited_panes" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
    if [[ "$exited_count" -gt 0 ]]; then
      echo "$exited_panes" | python3 -c "
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

  # Get tab info via JSON — single python3 pass
  tab_json="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-tabs --json 2>/dev/null)"
  if [[ -n "$tab_json" ]]; then
    read_kv < <(echo "$tab_json" | extract_tab_metadata)
    tab_count="${_meta[tab_count]:-0}"
    active_tab="${_meta[active_tab]:-}"
    tab_names="${_meta[tab_names]:-[]}"

    if [[ "$tab_count" -ne "$last_tab_count" || "$active_tab" != "$last_active_tab" || "$tab_names" != "$last_tab_names" ]]; then
      post_event "{\"hook_event_name\":\"CwdChanged\",\"session_id\":\"zellij-monitor\",\"cwd\":\"/\",\"zellij_event\":\"tab_update\",\"tab_count\":$tab_count,\"tabs\":$tab_names,\"active_tab\":\"$active_tab\"}"
      last_tab_count="$tab_count"
      last_active_tab="$active_tab"
      last_tab_names="$tab_names"
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

  # Check for shutdown signal between poll cycles
  if [[ "$_running" != "true" ]]; then
    echo "[zellij-monitor] received shutdown signal, exiting" >&2
    exit 0
  fi

  sleep "$POLL_INTERVAL"
done
