#!/usr/bin/env bash
# Zellij Subscribe Stream — streams pane content via subscribe --format json
# Complements the shell monitor (structural events) with pane content events.
# Runs as a long-lived process, posting viewport changes to the bridge.
set -euo pipefail

_running=true
trap 'echo "[zellij-subscribe] received shutdown signal" >&2; _running=false' TERM INT

BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:4317}"
HOOK_PATH="${HOOK_PATH:-/hook/zellij}"
SESSION_NAME="${ZELLIJ_SESSION_NAME:-}"
PANE_IDS="${SUBSCRIBE_PANE_IDS:-}"
CONTENT_DEBOUNCE="${CONTENT_DEBOUNCE:-5}"

RECONNECT_BASE_DELAY="${RECONNECT_BASE_DELAY:-2}"
RECONNECT_MAX_DELAY="${RECONNECT_MAX_DELAY:-60}"

if [[ -z "$SESSION_NAME" ]]; then
  echo 'ZELLIJ_SESSION_NAME is required' >&2
  exit 1
fi

# Load BRIDGE_SECRET from systemd credential store if available (systemd v250+)
# Falls back to environment variable for backward compatibility
if [[ -z "${BRIDGE_SECRET:-}" && -n "${CREDENTIALS_DIRECTORY:-}" && -f "${CREDENTIALS_DIRECTORY}/bridge-secret" ]]; then
  BRIDGE_SECRET="$(cat "${CREDENTIALS_DIRECTORY}/bridge-secret")"
  export BRIDGE_SECRET
fi

post_event() {
  local json_body="$1"
  local headers=(-H 'Content-Type: application/json')
  if [[ -n "${BRIDGE_SECRET:-}" ]]; then
    headers+=(-H "x-bridge-secret: ${BRIDGE_SECRET}")
  fi
  curl -sfS -X POST "${BRIDGE_URL}${HOOK_PATH}" \
    "${headers[@]}" \
    -d "$json_body" >/dev/null 2>&1 || true
}

# Wait for bridge
max_wait=30
waited=0
while ! curl -sf "${BRIDGE_URL}/health" >/dev/null 2>&1; do
  if [[ $waited -ge $max_wait ]]; then
    echo "[zellij-subscribe] bridge not available after ${max_wait}s" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

# Discover pane IDs if not specified
if [[ -z "$PANE_IDS" ]]; then
  PANE_IDS="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-panes --json 2>/dev/null \
    | python3 -c '
import json, sys
try:
  d = json.loads(sys.stdin.read())
except json.JSONDecodeError:
  d = []
terminals = [p for p in d if not p.get("is_plugin")]
# Only subscribe to non-floating focused panes
focused = [p for p in terminals if p.get("is_focused") and not p.get("is_floating")]
if not focused:
  focused = terminals[:1]
print(",".join(str(p["id"]) for p in focused))
' 2>/dev/null || true)"
fi

if [[ -z "$PANE_IDS" ]]; then
  echo "[zellij-subscribe] no pane IDs discovered" >&2
  exit 0
fi

# Build --pane-id args
PANE_ARGS=""
for pid in $(echo "$PANE_IDS" | tr ',' ' '); do
  PANE_ARGS="$PANE_ARGS --pane-id $pid"
done

echo "[zellij-subscribe] streaming panes: $PANE_IDS session: $SESSION_NAME bridge: $BRIDGE_URL"

# Track last viewport hash per pane to debounce content updates
declare -A _last_viewport_hash
_update_counter=0
_connect_attempt=0

# Reconnection loop with exponential backoff
while [[ "$_running" == "true" ]]; do
  # Re-discover pane IDs on each reconnect (session layout may have changed)
  if [[ -z "${SUBSCRIBE_PANE_IDS:-}" ]]; then
    PANE_IDS="$(ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij action list-panes --json 2>/dev/null \
      | python3 -c '
import json, sys
try:
  d = json.loads(sys.stdin.read())
except json.JSONDecodeError:
  d = []
terminals = [p for p in d if not p.get("is_plugin")]
focused = [p for p in terminals if p.get("is_focused") and not p.get("is_floating")]
if not focused:
  focused = terminals[:1]
print(",".join(str(p["id"]) for p in focused))
' 2>/dev/null || true)"

    PANE_ARGS=""
    for pid in $(echo "$PANE_IDS" | tr ',' ' '); do
      PANE_ARGS="$PANE_ARGS --pane-id $pid"
    done
  fi

  if [[ -z "$PANE_IDS" ]]; then
    echo "[zellij-subscribe] no pane IDs found on attempt $((_connect_attempt + 1))" >&2
  else
    echo "[zellij-subscribe] connecting (attempt $((_connect_attempt + 1))) panes: $PANE_IDS" >&2

    ZELLIJ_SESSION_NAME="$SESSION_NAME" zellij subscribe --format json $PANE_ARGS 2>/dev/null | while IFS= read -r line; do
      if [[ "$_running" != "true" ]]; then
        break
      fi

      # Parse NDJSON line
      event_type="$(echo "$line" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("event",""))' 2>/dev/null || true)"
      pane_id="$(echo "$line" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("pane_id",""))' 2>/dev/null || true)"

      if [[ "$event_type" != "pane_update" ]]; then
        continue
      fi

      # Compute viewport hash for debounce
      viewport_hash="$(echo "$line" | python3 -c 'import json,sys,hashlib; d=json.load(sys.stdin); vp=d.get("viewport",[]); print(hashlib.md5(json.dumps(vp).encode()).hexdigest()[:12])' 2>/dev/null || true)"

      if [[ -z "$viewport_hash" ]]; then
        continue
      fi

      # Debounce: skip if viewport hasn't changed
      last_hash="${_last_viewport_hash[$pane_id]:-}"
      if [[ "$viewport_hash" == "$last_hash" ]]; then
        continue
      fi
      _last_viewport_hash[$pane_id]="$viewport_hash"

      # Throttle: only post every N content changes per pane
      _update_counter=$((_update_counter + 1))
      if [[ $((_update_counter % CONTENT_DEBOUNCE)) -ne 0 ]]; then
        continue
      fi

      # Extract last line of viewport (prompt line) as summary
      last_line="$(echo "$line" | python3 -c 'import json,sys; d=json.load(sys.stdin); vp=d.get("viewport",[]); print(vp[-1] if vp else "")' 2>/dev/null || true)"

      # Extract viewport line count
      line_count="$(echo "$line" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("viewport",[])))' 2>/dev/null || echo 0)"

      is_initial="$(echo "$line" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(str(d.get("is_initial",False)).lower())' 2>/dev/null || echo false)"

      post_event "{\"hook_event_name\":\"FileChanged\",\"session_id\":\"zellij-subscribe\",\"cwd\":\"/\",\"zellij_event\":\"pane_content\",\"pane_id\":\"${pane_id}\",\"viewport_lines\":${line_count},\"viewport_hash\":\"${viewport_hash}\",\"is_initial\":${is_initial},\"last_line\":$(echo "$last_line" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo '""')}"
    done
  fi

  # Stream ended or no panes — reconnect if still running
  if [[ "$_running" != "true" ]]; then
    break
  fi

  _connect_attempt=$((_connect_attempt + 1))
  # Exponential backoff with jitter: delay = min(BASE * 2^attempt, MAX) + random 0-1s
  _delay=$((RECONNECT_BASE_DELAY * (1 << (_connect_attempt > 5 ? 5 : _connect_attempt))))
  if [[ $_delay -gt $RECONNECT_MAX_DELAY ]]; then
    _delay=$RECONNECT_MAX_DELAY
  fi
  _jitter=$((RANDOM % 1000))
  echo "[zellij-subscribe] stream ended, reconnecting in ${_delay}.${_jitter}s (attempt ${_connect_attempt})" >&2
  sleep "${_delay}.${_jitter}"

  # Wait for bridge before reconnecting
  _bwait=0
  while ! curl -sf "${BRIDGE_URL}/health" >/dev/null 2>&1; do
    if [[ $_bwait -ge 30 ]]; then
      echo "[zellij-subscribe] bridge unavailable during reconnect, stopping" >&2
      _running=false
      break
    fi
    sleep 1
    _bwait=$((_bwait + 1))
  done
done

echo "[zellij-subscribe] shutdown complete" >&2
