#!/usr/bin/env bash
set -euo pipefail

EVENT_NAME="${1:-unknown}"
BRIDGE_URL="${CLAUDE_STAR_BRIDGE_URL:-http://127.0.0.1:4317}"
BRIDGE_SECRET="${CLAUDE_STAR_BRIDGE_SECRET:-}"
TMP_FILE="$(mktemp)"
trap 'rm -f "${TMP_FILE}"' EXIT

cat > "${TMP_FILE}"

python3 - "${EVENT_NAME}" "${BRIDGE_URL}" "${BRIDGE_SECRET}" "${TMP_FILE}" <<'PY'
import json
import sys
import urllib.request

event_name, bridge_url, bridge_secret, payload_path = sys.argv[1:5]

with open(payload_path, "r", encoding="utf-8") as fh:
    raw = fh.read()

payload = None
if raw.strip():
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {"raw": raw}

body = json.dumps(
    {
        "source": "claude-hook",
        "event_name": event_name,
        "payload": payload,
    }
).encode("utf-8")

request = urllib.request.Request(
    f"{bridge_url.rstrip('/')}/hook/claude",
    data=body,
    headers={"content-type": "application/json"},
    method="POST",
)

if bridge_secret:
    request.add_header("x-bridge-secret", bridge_secret)

try:
    with urllib.request.urlopen(request, timeout=3):
        pass
except Exception as exc:
    print(f"[claude-star-office-bridge] warning: {exc}", file=sys.stderr)
PY
