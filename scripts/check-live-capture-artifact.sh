#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CAPTURE_BATCH="${CAPTURE_BATCH:-safe-lifecycle}"
EVENTS_LOG="${REPO_ROOT}/tmp/events.ndjson"
REPORT_PATH=""
SSE_PROOF_PATH=""

usage() {
  cat <<EOF
Usage: bash scripts/check-live-capture-artifact.sh [--batch <name>] [--report <path>] [--sse-proof <path>] [events.ndjson]

Reads a bridge event log and reports which expected live-runtime capture events
were observed. This checker is read-only: it does not start free-code, create
teams, request permissions, open SSE connections, or trigger hooks.

Options:
  --batch <name>      Expected event batch to verify
  --report <path>    Write a markdown report
  --sse-proof <path> Include key-only proof from a saved /events SSE transcript

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
    --sse-proof)
      if [[ -z "${2:-}" ]]; then
        echo "[live-capture-check] --sse-proof requires a path" >&2
        exit 1
      fi
      SSE_PROOF_PATH="$2"
      shift 2
      ;;
    --sse-proof=*)
      SSE_PROOF_PATH="${1#--sse-proof=}"
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

if [[ -n "${SSE_PROOF_PATH}" && ! -f "${SSE_PROOF_PATH}" ]]; then
  echo "[live-capture-check] SSE proof not found: ${SSE_PROOF_PATH}" >&2
  exit 1
fi

python3 - "${EVENTS_LOG}" "${CAPTURE_BATCH}" "${REPORT_PATH}" "${SSE_PROOF_PATH}" <<'PY'
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
batch = sys.argv[2]
report_path = Path(sys.argv[3]) if sys.argv[3] else None
sse_proof_path = Path(sys.argv[4]) if sys.argv[4] else None
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
common_payload_keys = {
    "additional_context",
    "agent_id",
    "agent_transcript_path",
    "agent_type",
    "cwd",
    "detail",
    "error",
    "error_details",
    "event_name",
    "message",
    "notification_type",
    "output_file",
    "output_file_path",
    "parent_session_id",
    "permission_decision_reason",
    "permission_suggestions",
    "prompt",
    "reason",
    "request_id",
    "session_id",
    "status",
    "stop_hook_active",
    "stop_reason",
    "summary",
    "task_description",
    "task_id",
    "task_status",
    "task_subject",
    "task_summary",
    "teammate_name",
    "title",
    "tool_name",
    "tool_use_id",
    "transcript_path",
    "worktree",
    "worktree_branch",
    "worktree_path",
}
common_context_keys = {
    "agentId",
    "agentTranscriptPath",
    "agentType",
    "controlPlaneAgentId",
    "controlPlaneAllow",
    "controlPlaneApproved",
    "controlPlaneDescription",
    "controlPlaneError",
    "controlPlaneFeedback",
    "controlPlaneHost",
    "controlPlanePermissionUpdatesCount",
    "controlPlanePlanFilePath",
    "controlPlaneReason",
    "controlPlaneRequestId",
    "controlPlaneSender",
    "controlPlaneSubtype",
    "controlPlaneTimestamp",
    "controlPlaneToolName",
    "controlPlaneToolUseId",
    "controlPlaneType",
    "cwd",
    "notificationHost",
    "notificationMessage",
    "notificationTitle",
    "notificationToolName",
    "notificationType",
    "notificationWorkerName",
    "outputFilePath",
    "parentSessionId",
    "permissionSuggestionsCount",
    "rawToolName",
    "stopHookActive",
    "taskId",
    "taskStatus",
    "taskSummary",
    "teamName",
    "teammateName",
    "teammateSummary",
    "transcriptPath",
    "worktreeBranch",
    "worktreePath",
}
expected_payload_keys_by_event = {
    event_name: set(common_payload_keys)
    for event_name in canonical
}
expected_context_keys_by_event = {
    event_name: set(common_context_keys)
    for event_name in canonical
}
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
missing_by_batch = {
    batch_name: [event for event in batch_events if event not in observed]
    for batch_name, batch_events in required_by_batch.items()
    if batch_name != "all"
}
complete_batches = [batch_name for batch_name, missing_events in missing_by_batch.items() if not missing_events]
next_capture_batches = [batch_name for batch_name, missing_events in missing_by_batch.items() if missing_events]
unknown_payload_keys_by_event = {
    event_name: payload_keys_by_event[event_name] - expected_payload_keys_by_event.get(event_name, set())
    for event_name in observed
}
unknown_context_keys_by_event = {
    event_name: context_keys_by_event[event_name] - expected_context_keys_by_event.get(event_name, set())
    for event_name in observed
}
unknown_payload_key_count = sum(len(keys) for keys in unknown_payload_keys_by_event.values())
unknown_context_key_count = sum(len(keys) for keys in unknown_context_keys_by_event.values())

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

sse_proof = None
if sse_proof_path:
    sse_text = sse_proof_path.read_text(encoding="utf-8", errors="replace")
    sse_event_count = sse_text.count("\nevent: signal")
    if sse_text.startswith("event: signal"):
        sse_event_count += 1
    sse_data_count = sse_text.count("\ndata: ")
    if sse_text.startswith("data: "):
        sse_data_count += 1
    sse_proof = {
        "path": str(sse_proof_path),
        "status_200": "Status: 200" in sse_text,
        "event_stream_header": "text/event-stream" in sse_text,
        "no_cache_header": "no-cache" in sse_text,
        "signal_events": sse_event_count,
        "data_lines": sse_data_count,
        "session_ids": sorted(session for session in {event["session"] for event in events if event.get("session")} if session and session in sse_text),
    }

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

print("[live-capture-check] unknown key drift:")
if unknown_payload_key_count == 0 and unknown_context_key_count == 0:
    print("  - none")
else:
    for event_name in sorted(counts):
        payload_keys = ", ".join(sorted(unknown_payload_keys_by_event[event_name])) or "none"
        context_keys = ", ".join(sorted(unknown_context_keys_by_event[event_name])) or "none"
        if payload_keys != "none" or context_keys != "none":
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

if sse_proof:
    print("[live-capture-check] SSE proof:")
    print(f"  - path: {sse_proof['path']}")
    print(f"  - status 200: {'ok' if sse_proof['status_200'] else 'missing'}")
    print(f"  - event-stream header: {'ok' if sse_proof['event_stream_header'] else 'missing'}")
    print(f"  - no-cache header: {'ok' if sse_proof['no_cache_header'] else 'missing'}")
    print(f"  - signal events: {sse_proof['signal_events']}")
    print(f"  - data lines: {sse_proof['data_lines']}")
    matched_sessions = ", ".join(sse_proof["session_ids"]) or "none"
    print(f"  - matched artifact sessions: {matched_sessions}")

print("[live-capture-check] next capture targets:")
if complete_batches:
    print(f"  - complete batches: {', '.join(complete_batches)}")
else:
    print("  - complete batches: none")
for batch_name in sorted(next_capture_batches):
    print(f"  - {batch_name}: missing {', '.join(missing_by_batch[batch_name])}")

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
        f"- Unknown payload keys: {unknown_payload_key_count}.",
        f"- Unknown context keys: {unknown_context_key_count}.",
        f"- SSE proof: {'provided' if sse_proof else 'not provided'}.",
        f"- Complete capture batches: {len(complete_batches)} of {len(missing_by_batch)}.",
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
        "## Unknown Key Drift",
        "",
        "This section lists key names observed outside the checker allowlist. It still omits values.",
        "",
        "| Event | Unknown raw payload keys | Unknown normalized context keys |",
        "|-------|--------------------------|---------------------------------|",
    ])
    if unknown_payload_key_count == 0 and unknown_context_key_count == 0:
        lines.append("| none | none | none |")
    else:
        for event_name in sorted(counts):
            payload_keys = ", ".join(f"`{key}`" for key in sorted(unknown_payload_keys_by_event[event_name])) or "none"
            context_keys = ", ".join(f"`{key}`" for key in sorted(unknown_context_keys_by_event[event_name])) or "none"
            if payload_keys != "none" or context_keys != "none":
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

    if sse_proof:
        matched_sessions = ", ".join(f"`{session}`" for session in sse_proof["session_ids"]) or "none"
        lines.extend([
            "## SSE Proof",
            "",
            "This section summarizes a saved `/events` SSE transcript by checking headers, event markers, data-line count, and whether captured artifact session IDs also appear in the SSE transcript. It does not include raw SSE payload values.",
            "",
            f"- Path: `{sse_proof['path']}`",
            f"- Status 200: `{'ok' if sse_proof['status_200'] else 'missing'}`",
            f"- Event-stream header: `{'ok' if sse_proof['event_stream_header'] else 'missing'}`",
            f"- No-cache header: `{'ok' if sse_proof['no_cache_header'] else 'missing'}`",
            f"- Signal events: {sse_proof['signal_events']}",
            f"- Data lines: {sse_proof['data_lines']}",
            f"- Matched artifact sessions: {matched_sessions}",
            "",
        ])

    lines.extend([
        "## Next Capture Targets",
        "",
        "This section groups still-missing canonical events by capture batch so the next operator run can target the smallest useful scenario. It is derived from event names only.",
        "",
        "| Batch | Status | Missing events |",
        "|-------|--------|----------------|",
    ])
    for batch_name in sorted(missing_by_batch):
        missing_events = missing_by_batch[batch_name]
        batch_status = "complete" if not missing_events else "missing"
        missing_text = ", ".join(f"`{event}`" for event in missing_events) or "none"
        lines.append(f"| `{batch_name}` | {batch_status} | {missing_text} |")
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
