#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CAPTURE_BATCH="${CAPTURE_BATCH:-safe-lifecycle}"
EVENTS_LOG="${REPO_ROOT}/tmp/events.ndjson"
REPORT_PATH=""

usage() {
  cat <<EOF
Usage: bash scripts/check-live-capture-artifact.sh [--batch <name>] [--report <path>] [events.ndjson]

Reads a bridge event log and reports which expected live-runtime capture events
were observed. This checker is read-only: it does not start free-code, create
teams, request permissions, or trigger hooks.

Batches:
  safe-lifecycle    Subagent/team/permission notification sequence (default)
  config-file-watch Setup/config/cwd/file/instructions events
  worktree          WorktreeCreate and WorktreeRemove
  compaction        PreCompact and PostCompact
  risky-denial      PermissionDenied and StopFailure
  all               Every canonical free-code hook event
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --batch)
      if [[ -z "${2:-}" ]]; then
        echo "[live-capture-check] --batch requires a value" >&2
        exit 1
      fi
      CAPTURE_BATCH="$2"
      shift 2
      ;;
    --batch=*)
      CAPTURE_BATCH="${1#--batch=}"
      shift
      ;;
    --report)
      if [[ -z "${2:-}" ]]; then
        echo "[live-capture-check] --report requires a path" >&2
        exit 1
      fi
      REPORT_PATH="$2"
      shift 2
      ;;
    --report=*)
      REPORT_PATH="${1#--report=}"
      shift
      ;;
    --*)
      echo "[live-capture-check] unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      EVENTS_LOG="$1"
      shift
      ;;
  esac
done

if [[ ! -f "${EVENTS_LOG}" ]]; then
  echo "[live-capture-check] event log not found: ${EVENTS_LOG}" >&2
  echo "[live-capture-check] run scripts/run-interactive-notification-capture.sh first, or pass an events.ndjson path" >&2
  exit 1
fi

python3 - "${EVENTS_LOG}" "${CAPTURE_BATCH}" "${REPORT_PATH}" <<'PY'
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
batch = sys.argv[2]
report_path = Path(sys.argv[3]) if sys.argv[3] else None
canonical = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "UserPromptSubmit",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PermissionRequest",
    "PermissionDenied",
    "Setup",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "Elicitation",
    "ElicitationResult",
    "ConfigChange",
    "WorktreeCreate",
    "WorktreeRemove",
    "InstructionsLoaded",
    "CwdChanged",
    "FileChanged",
]
required_by_batch = {
    "safe-lifecycle": [
        "SubagentStart",
        "TaskCreated",
        "PermissionRequest",
        "Notification",
        "TaskCompleted",
        "TeammateIdle",
        "SubagentStop",
    ],
    "config-file-watch": [
        "Setup",
        "CwdChanged",
        "FileChanged",
        "InstructionsLoaded",
        "ConfigChange",
    ],
    "worktree": ["WorktreeCreate", "WorktreeRemove"],
    "compaction": ["PreCompact", "PostCompact"],
    "risky-denial": ["PermissionDenied", "StopFailure"],
    "all": canonical,
}

if batch not in required_by_batch:
    print(f"[live-capture-check] unknown batch: {batch}", file=sys.stderr)
    print(
        "[live-capture-check] supported batches: "
        + ", ".join(sorted(required_by_batch)),
        file=sys.stderr,
    )
    sys.exit(1)

required = required_by_batch[batch]
optional = [event for event in canonical if event not in required]

events = []
payload_keys_by_event = defaultdict(set)
context_keys_by_event = defaultdict(set)
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

        payload = raw_event.get("payload")
        if isinstance(payload, dict):
            payload_keys_by_event[event_name].update(str(key) for key in payload.keys())

        context = signal.get("context")
        if isinstance(context, dict):
            context_keys_by_event[event_name].update(str(key) for key in context.keys())

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

sequence_ok = bool(positions)
status = "pass" if not missing_required else "missing-required-events"

print(f"[live-capture-check] artifact: {path}")
print(f"[live-capture-check] batch: {batch}")
print(f"[live-capture-check] mapped events: {len(events)}")
print(f"[live-capture-check] ignored entries: {ignored}")
if invalid:
    print(f"[live-capture-check] invalid json lines: {invalid}")

print("[live-capture-check] observed events:")
for event_name, count in sorted(counts.items()):
    print(f"  - {event_name}: {count}")

print("[live-capture-check] observed key shapes:")
for event_name in sorted(counts):
    payload_keys = ", ".join(sorted(payload_keys_by_event[event_name])) or "none"
    context_keys = ", ".join(sorted(context_keys_by_event[event_name])) or "none"
    print(f"  - {event_name}: payload=[{payload_keys}] context=[{context_keys}]")

print("[live-capture-check] required events:")
for event_name in required:
    event_status = "ok" if event_name in observed else "missing"
    print(f"  - {event_name}: {event_status}")

if missing_optional:
    print("[live-capture-check] optional/deferred events not observed:")
    for event_name in missing_optional:
        print(f"  - {event_name}")

if sequence_ok:
    print("[live-capture-check] required sequence order: ok")
else:
    print("[live-capture-check] required sequence order: incomplete")

if report_path:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    lines = [
        "# Live Capture Artifact Report",
        "",
        "## TL;DR",
        "",
        f"- Batch: `{batch}`.",
        f"- Status: `{status}`.",
        f"- Mapped events: {len(events)}.",
        f"- Missing required events: {len(missing_required)}.",
        "",
        "## Artifact",
        "",
        f"- Path: `{path}`",
        f"- Generated: `{generated_at}`",
        f"- Ignored entries: {ignored}",
        f"- Invalid JSON lines: {invalid}",
        "",
        "## Required Events",
        "",
        "| Event | Status |",
        "|-------|--------|",
    ]
    for event_name in required:
        event_status = "ok" if event_name in observed else "missing"
        lines.append(f"| `{event_name}` | {event_status} |")

    lines.extend([
        "",
        "## Observed Events",
        "",
        "| Event | Count |",
        "|-------|-------|",
    ])
    for event_name, count in sorted(counts.items()):
        lines.append(f"| `{event_name}` | {count} |")

    lines.extend([
        "",
        "## Observed Key Shapes",
        "",
        "This section lists only key names from raw payloads and normalized contexts. It intentionally omits values to avoid copying secrets or bulky runtime data.",
        "",
        "| Event | Raw payload keys | Normalized context keys |",
        "|-------|------------------|-------------------------|",
    ])
    for event_name in sorted(counts):
        payload_keys = ", ".join(f"`{key}`" for key in sorted(payload_keys_by_event[event_name])) or "none"
        context_keys = ", ".join(f"`{key}`" for key in sorted(context_keys_by_event[event_name])) or "none"
        lines.append(f"| `{event_name}` | {payload_keys} | {context_keys} |")

    lines.extend([
        "",
        "## Sequence Check",
        "",
        f"Required sequence order: `{'ok' if sequence_ok else 'incomplete'}`.",
        "",
        "```text",
        " -> ".join(required),
        "```",
        "",
    ])

    if missing_required:
        lines.extend(["## Missing Required Events", ""])
        for event_name in missing_required:
            lines.append(f"- `{event_name}`")
        lines.append("")

    if missing_optional:
        lines.extend(["## Optional or Deferred Events Not Observed", ""])
        for event_name in missing_optional:
            lines.append(f"- `{event_name}`")
        lines.append("")

    lines.extend([
        "## Interpretation",
        "",
        "This report summarizes an existing bridge event artifact only. It does not prove events were triggered unless the referenced artifact came from a real interactive capture run.",
        "",
    ])
    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"[live-capture-check] report: {report_path}")

if missing_required:
    print("[live-capture-check] missing required events:")
    for event_name in missing_required:
        print(f"  - {event_name}")
    sys.exit(1)

print("[live-capture-check] required events observed")
PY
