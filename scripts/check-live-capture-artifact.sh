#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EVENTS_LOG="${1:-${REPO_ROOT}/tmp/events.ndjson}"

usage() {
  cat <<EOF
Usage: bash scripts/check-live-capture-artifact.sh [events.ndjson]

Reads a bridge event log and reports which expected live-runtime capture events
were observed. This checker is read-only: it does not start free-code, create
teams, request permissions, or trigger hooks.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ ! -f "${EVENTS_LOG}" ]]; then
  echo "[live-capture-check] event log not found: ${EVENTS_LOG}" >&2
  echo "[live-capture-check] run scripts/run-interactive-notification-capture.sh first, or pass an events.ndjson path" >&2
  exit 1
fi

python3 - "${EVENTS_LOG}" <<'PY'
import json
import sys
from collections import Counter
from pathlib import Path

path = Path(sys.argv[1])
required = [
    "SubagentStart",
    "TaskCreated",
    "PermissionRequest",
    "Notification",
    "TaskCompleted",
    "TeammateIdle",
    "SubagentStop",
]
optional = [
    "Setup",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionDenied",
    "StopFailure",
    "Elicitation",
    "ElicitationResult",
    "ConfigChange",
    "WorktreeCreate",
    "WorktreeRemove",
    "InstructionsLoaded",
    "CwdChanged",
    "FileChanged",
    "PreCompact",
    "PostCompact",
]

events = []
ignored = 0
invalid = 0
with path.open("r", encoding="utf-8") as handle:
    for line_number, line in enumerate(handle, start=1):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            invalid += 1
            continue

        if entry.get("ignored"):
            ignored += 1
            continue

        raw_event = entry.get("rawEvent") or {}
        signal = entry.get("signal") or {}
        event_name = raw_event.get("event_name") or signal.get("eventName")
        if not event_name:
            continue

        events.append(
            {
                "line": line_number,
                "event": event_name,
                "state": signal.get("state"),
                "scope": signal.get("scope"),
                "agent": signal.get("agentName"),
                "session": signal.get("sessionId"),
                "detail": signal.get("detail"),
            }
        )

counts = Counter(event["event"] for event in events)
observed = set(counts)
missing_required = [event for event in required if event not in observed]
missing_optional = [event for event in optional if event not in observed]

print(f"[live-capture-check] artifact: {path}")
print(f"[live-capture-check] mapped events: {len(events)}")
print(f"[live-capture-check] ignored entries: {ignored}")
if invalid:
    print(f"[live-capture-check] invalid json lines: {invalid}")

print("[live-capture-check] observed events:")
for event_name, count in sorted(counts.items()):
    print(f"  - {event_name}: {count}")

print("[live-capture-check] required live sequence:")
for event_name in required:
    status = "ok" if event_name in observed else "missing"
    print(f"  - {event_name}: {status}")

if missing_optional:
    print("[live-capture-check] optional/deferred events not observed:")
    for event_name in missing_optional:
        print(f"  - {event_name}")

positions = []
last_index = -1
for event_name in required:
    try:
        index = next(
            index
            for index in range(last_index + 1, len(events))
            if events[index]["event"] == event_name
        )
    except StopIteration:
        positions = []
        break
    positions.append(index)
    last_index = index

if positions:
    print("[live-capture-check] required sequence order: ok")
else:
    print("[live-capture-check] required sequence order: incomplete")

if missing_required:
    print("[live-capture-check] missing required live events:")
    for event_name in missing_required:
        print(f"  - {event_name}")
    sys.exit(1)

print("[live-capture-check] required live events observed")
PY
