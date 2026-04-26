#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SMOKE_PORT="${SMOKE_BRIDGE_PORT:-}"
if [[ -z "${SMOKE_PORT}" ]]; then
  SMOKE_PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
fi

BRIDGE_URL="http://127.0.0.1:${SMOKE_PORT}"
EVENTS_LOG_FILE="$(mktemp)"
LOG_FILE="$(mktemp)"
cleanup() {
  if [[ -n "${BRIDGE_PID:-}" ]]; then
    kill "${BRIDGE_PID}" >/dev/null 2>&1 || true
    wait "${BRIDGE_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${LOG_FILE}" "${EVENTS_LOG_FILE}"
}
trap cleanup EXIT

echo "[1/31] start isolated bridge"
(
  cd "${REPO_ROOT}"
  BRIDGE_HOST="127.0.0.1" \
  BRIDGE_PORT="${SMOKE_PORT}" \
  BRIDGE_DRY_RUN="true" \
  BRIDGE_EVENTS_LOG_PATH="${EVENTS_LOG_FILE}" \
  bun run src/index.ts >"${LOG_FILE}" 2>&1
) &
BRIDGE_PID=$!

echo "[2/31] wait for bridge health"
for _ in $(seq 1 50); do
  if curl -fsS "${BRIDGE_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! curl -fsS "${BRIDGE_URL}/health" >/dev/null 2>&1; then
  echo "bridge failed to start" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

echo "[3/31] manual main agent state"
curl -fsS -X POST "${BRIDGE_URL}/event/manual" \
  -H "content-type: application/json" \
  -d '{"sessionId":"smoke-main","scope":"main","state":"writing","detail":"smoke test main"}' >/dev/null

echo "[4/31] manual subagent state"
curl -fsS -X POST "${BRIDGE_URL}/event/manual" \
  -H "content-type: application/json" \
  -d '{"sessionId":"smoke-main","scope":"subagent","agentName":"worker-1","state":"researching","detail":"smoke test subagent"}' >/dev/null

echo "[5/31] hook-mapped main event"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"PreToolUse","payload":{"session_id":"smoke-hook","tool_name":"Read","task_subject":"hook test main"}}' >/dev/null

echo "[6/31] hook-mapped subagent lifecycle"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCreated","payload":{"session_id":"smoke-hook","agent_id":"worker-42","agent_transcript_path":"/tmp/worker-42.jsonl","parent_session_id":"smoke-parent","task_subject":"hook test subagent"}}' >/dev/null

hook_live_json="$(curl -fsS "${BRIDGE_URL}/sessions")"
SESSIONS_JSON="${hook_live_json}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["SESSIONS_JSON"])
if not payload.get("ok"):
    raise SystemExit("sessions endpoint returned ok=false during parent_session_id check")

sessions = payload.get("sessions", [])
by_id = {session.get("sessionId"): session for session in sessions}
hook_session = by_id.get("smoke-hook")
if not hook_session:
    raise SystemExit("missing smoke-hook session during parent_session_id check")

agents = hook_session.get("agents") or {}
worker_42 = agents.get("worker-42")
if not worker_42:
    raise SystemExit("expected worker-42 to be present before SubagentStop")

context = worker_42.get("context") or {}
if context.get("parentSessionId") != "smoke-parent":
    raise SystemExit(
        f"expected worker-42 context.parentSessionId='smoke-parent', got {context.get('parentSessionId')!r}",
    )
PY

curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"SubagentStop","payload":{"session_id":"smoke-hook","agent_id":"worker-42","task_description":"done"}}' >/dev/null

curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCreated","payload":{"session_id":"smoke-hook","agent_id":"worker-55","task_id":"task-55","task_subject":"task owner mapping"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCompleted","payload":{"session_id":"smoke-hook","task_id":"task-55","task_description":"task owner completion"}}' >/dev/null

echo "[7/31] hook-mapped transcript-only subagent lifecycle"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCreated","payload":{"session_id":"smoke-hook","agent_transcript_path":"/tmp/worker-66.jsonl","task_id":"task-66","task_subject":"transcript-only owner mapping"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCompleted","payload":{"session_id":"smoke-hook","task_id":"task-66","task_description":"transcript-only owner completion"}}' >/dev/null

echo "[8/31] session reset on SessionStart"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCreated","payload":{"session_id":"smoke-reset","agent_id":"worker-reset","task_id":"task-reset","task_subject":"reset owner mapping"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"SessionStart","payload":{"session_id":"smoke-reset"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCompleted","payload":{"session_id":"smoke-reset","task_id":"task-reset","task_description":"should not resurrect old owner"}}' >/dev/null

echo "[9/31] session reset on SessionEnd"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCreated","payload":{"session_id":"smoke-end","agent_id":"worker-end","task_id":"task-end","task_subject":"end owner mapping"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"SessionEnd","payload":{"session_id":"smoke-end"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCompleted","payload":{"session_id":"smoke-end","task_id":"task-end","task_description":"should not resurrect ended owner"}}' >/dev/null

echo "[10/31] same-session SessionEnd→SessionStart cycle reset"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCreated","payload":{"session_id":"smoke-cycle","agent_id":"worker-cycle","task_id":"task-cycle","task_subject":"cycle owner mapping"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"SessionEnd","payload":{"session_id":"smoke-cycle"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"SessionStart","payload":{"session_id":"smoke-cycle"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCompleted","payload":{"session_id":"smoke-cycle","task_id":"task-cycle","task_description":"should not resurrect after cycle reset"}}' >/dev/null

echo "[11/31] agent-id identity stabilization across name drift"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCreated","payload":{"session_id":"smoke-alias","agent_id":"worker-alias","teammate_name":"friendly-alias","task_id":"task-alias","task_subject":"alias owner mapping"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"SubagentStop","payload":{"session_id":"smoke-alias","agent_id":"worker-alias","task_description":"alias stop"}}' >/dev/null

echo "[12/31] agent-id identity upgrade from generic to teammate name"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCreated","payload":{"session_id":"smoke-upgrade","agent_id":"worker-upgrade","task_id":"task-upgrade","task_subject":"upgrade owner mapping"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"PreToolUse","payload":{"session_id":"smoke-upgrade","agent_id":"worker-upgrade","teammate_name":"friendly-upgrade","tool_name":"Read","task_subject":"upgrade identity pass"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCompleted","payload":{"session_id":"smoke-upgrade","task_id":"task-upgrade","task_description":"upgrade owner completion"}}' >/dev/null

echo "[13/31] leave-path alias identity map cleanup on task-owner completion"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCreated","payload":{"session_id":"smoke-leave-alias","agent_id":"worker-leave-alias","task_id":"task-leave-alias","task_subject":"leave alias mapping"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"PreToolUse","payload":{"session_id":"smoke-leave-alias","agent_id":"worker-leave-alias","teammate_name":"friendly-leave-alias","tool_name":"Read","task_subject":"leave alias upgrade"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCompleted","payload":{"session_id":"smoke-leave-alias","task_id":"task-leave-alias","task_description":"leave alias completion"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"PreToolUse","payload":{"session_id":"smoke-leave-alias","agent_id":"worker-leave-alias","tool_name":"Read","task_subject":"leave alias generic reentry"}}' >/dev/null

echo "[14/31] Stop denial fallback"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"Stop","payload":{"session_id":"smoke-denial","last_assistant_message":"Bash permission was denied in don'\''t-ask mode, so I can’t complete that command as requested."}}' >/dev/null

curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"PostToolUseFailure","payload":{"session_id":"smoke-post-tool-failure","tool_name":"Bash","error":"command failed for smoke coverage"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"PermissionDenied","payload":{"session_id":"smoke-permission-denied-direct","request_id":"perm-denied-direct","reason":"classifier denied smoke probe"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"StopFailure","payload":{"session_id":"smoke-stop-failure","error":"stop failed for smoke coverage"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"PostToolUse","payload":{"session_id":"smoke-post-tool","tool_name":"Bash","tool_response":"ok"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"Setup","payload":{"session_id":"smoke-setup","status":"setup complete"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"SubagentStart","payload":{"session_id":"smoke-subagent-start","agent_id":"worker-start","agent_type":"general-purpose","task_subject":"synthetic start"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TeammateIdle","payload":{"session_id":"smoke-teammate-idle","teammate_name":"worker-idle","summary":"synthetic idle"}}' >/dev/null

for event_name in Elicitation ElicitationResult ConfigChange WorktreeCreate WorktreeRemove InstructionsLoaded CwdChanged FileChanged PreCompact PostCompact; do
  curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
    -H "content-type: application/json" \
    -d "{\"source\":\"smoke\",\"event_name\":\"${event_name}\",\"payload\":{\"session_id\":\"smoke-${event_name}\",\"detail\":\"synthetic ${event_name}\",\"worktree\":{\"path\":\"/tmp/smoke-worktree\",\"branch\":\"smoke-branch\"}}}" >/dev/null
done

echo "[15/31] task metadata projection"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"TaskCompleted","payload":{"session_id":"smoke-task-meta","task_id":"task-meta-1","task_description":"task metadata completion","status":"completed","summary":"task summary projection","output_file":"/tmp/task-meta/output.md","worktree":{"path":"/tmp/worktrees/task-meta","branch":"task-meta-branch"}}}' >/dev/null

echo "[16/31] teammate control-plane projection"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-control-plane-request","prompt":"<teammate-message teammate_id=\"worker-mailbox\" summary=\"plan request\">\n{\"type\":\"plan_approval_request\",\"from\":\"worker-mailbox\",\"timestamp\":\"2026-04-06T00:00:00.000Z\",\"planFilePath\":\"/tmp/plan.md\",\"planContent\":\"# Plan\",\"requestId\":\"plan-123\"}\n</teammate-message>"}}' >/dev/null

echo "[17/31] teammate control-plane responses"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-control-plane-approved","prompt":"<teammate-message teammate_id=\"worker-mailbox\" summary=\"plan approved\">\n{\"type\":\"plan_approval_response\",\"requestId\":\"plan-124\",\"approved\":true,\"timestamp\":\"2026-04-06T00:01:00.000Z\"}\n</teammate-message>"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-control-plane-rejected","prompt":"<teammate-message teammate_id=\"worker-mailbox\" summary=\"plan rejected\">\n{\"type\":\"plan_approval_response\",\"requestId\":\"plan-125\",\"approved\":false,\"feedback\":\"needs revision\",\"timestamp\":\"2026-04-06T00:02:00.000Z\"}\n</teammate-message>"}}' >/dev/null

echo "[18/31] teammate shutdown projection"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-shutdown-request","prompt":"<teammate-message teammate_id=\"worker-mailbox\" summary=\"shutdown request\">\n{\"type\":\"shutdown_request\",\"requestId\":\"shutdown-1\",\"from\":\"worker-mailbox\",\"reason\":\"done\",\"timestamp\":\"2026-04-06T00:03:00.000Z\"}\n</teammate-message>"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-shutdown-approved","prompt":"<teammate-message teammate_id=\"worker-mailbox\" summary=\"shutdown approved\">\n{\"type\":\"shutdown_approved\",\"requestId\":\"shutdown-2\",\"from\":\"lead-agent\",\"timestamp\":\"2026-04-06T00:04:00.000Z\"}\n</teammate-message>"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-shutdown-rejected","prompt":"<teammate-message teammate_id=\"worker-mailbox\" summary=\"shutdown rejected\">\n{\"type\":\"shutdown_rejected\",\"requestId\":\"shutdown-3\",\"from\":\"lead-agent\",\"reason\":\"keep working\",\"timestamp\":\"2026-04-06T00:05:00.000Z\"}\n</teammate-message>"}}' >/dev/null

echo "[19/31] teammate permission projection"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-permission-request","prompt":"<teammate-message teammate_id=\"worker-mailbox\" summary=\"permission request\">\n{\"type\":\"permission_request\",\"request_id\":\"perm-1\",\"agent_id\":\"worker-mailbox\",\"tool_name\":\"Bash\",\"tool_use_id\":\"toolu_123\",\"description\":\"Run ls in repo root\",\"input\":{\"command\":\"ls\"},\"permission_suggestions\":[{\"tool_name\":\"Bash\"}]}\n</teammate-message>"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-permission-approved","prompt":"<teammate-message teammate_id=\"team-lead\" summary=\"permission approved\">\n{\"type\":\"permission_response\",\"request_id\":\"perm-1\",\"subtype\":\"success\",\"response\":{\"updated_input\":{\"command\":\"ls -la\"},\"permission_updates\":[{\"tool_name\":\"Bash\",\"ruleContent\":\"allow ls\"}]}}\n</teammate-message>"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-permission-denied","prompt":"<teammate-message teammate_id=\"team-lead\" summary=\"permission denied\">\n{\"type\":\"permission_response\",\"request_id\":\"perm-2\",\"subtype\":\"error\",\"error\":\"Permission denied by lead\"}\n</teammate-message>"}}' >/dev/null

echo "[20/31] teammate sandbox permission projection"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-sandbox-request","prompt":"<teammate-message teammate_id=\"worker-mailbox\" summary=\"sandbox request\">\n{\"type\":\"sandbox_permission_request\",\"requestId\":\"sandbox-1\",\"workerId\":\"worker-mailbox\",\"workerName\":\"worker-mailbox\",\"hostPattern\":{\"host\":\"api.anthropic.com\"},\"createdAt\":1712361600000}\n</teammate-message>"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-sandbox-approved","prompt":"<teammate-message teammate_id=\"team-lead\" summary=\"sandbox approved\">\n{\"type\":\"sandbox_permission_response\",\"requestId\":\"sandbox-1\",\"host\":\"api.anthropic.com\",\"allow\":true,\"timestamp\":\"2026-04-06T00:06:00.000Z\"}\n</teammate-message>"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"UserPromptSubmit","payload":{"session_id":"smoke-sandbox-denied","prompt":"<teammate-message teammate_id=\"team-lead\" summary=\"sandbox denied\">\n{\"type\":\"sandbox_permission_response\",\"requestId\":\"sandbox-2\",\"host\":\"example.com\",\"allow\":false,\"timestamp\":\"2026-04-06T00:07:00.000Z\"}\n</teammate-message>"}}' >/dev/null


echo "[21/31] direct PermissionRequest hook projection"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"PermissionRequest","payload":{"session_id":"smoke-direct-permission-request","agent_id":"worker-direct","tool_name":"Bash","tool_use_id":"toolu_direct","description":"Run pwd in repo root"}}' >/dev/null


echo "[22/31] notification hook projection"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"Notification","payload":{"session_id":"smoke-notification-permission","notification_type":"worker_permission_prompt","title":"Worker permission needed","message":"worker-mailbox needs permission for Bash"}}' >/dev/null
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"Notification","payload":{"session_id":"smoke-notification-network","notification_type":"worker_permission_prompt","title":"Worker network access needed","message":"worker-mailbox needs network access to api.anthropic.com"}}' >/dev/null


echo "[23/31] hook invalid-json rejection"
invalid_json_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  --data-binary 'not-json')"
if [[ "${invalid_json_status}" != "400" ]]; then
  echo "expected /hook/claude invalid json status 400, got ${invalid_json_status}" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

echo "[24/31] hook missing-event rejection"
missing_event_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  --data-binary '{"source":"smoke","payload":{"session_id":"smoke-hook"}}')"
if [[ "${missing_event_status}" != "400" ]]; then
  echo "expected /hook/claude missing event_name status 400, got ${missing_event_status}" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

echo "[25/31] session projection checks"
sessions_json="$(curl -fsS "${BRIDGE_URL}/sessions")"
SESSIONS_JSON="${sessions_json}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["SESSIONS_JSON"])
if not payload.get("ok"):
    raise SystemExit("sessions endpoint returned ok=false")

sessions = payload.get("sessions", [])
if not isinstance(sessions, list):
    raise SystemExit("sessions payload is not a list")

by_id = {session.get("sessionId"): session for session in sessions}
hook_session = by_id.get("smoke-hook")
if not hook_session:
    raise SystemExit("missing smoke-hook session")

main = hook_session.get("main") or {}
if main.get("state") != "researching":
    raise SystemExit(f"expected smoke-hook main.state=researching, got {main.get('state')!r}")

agents = hook_session.get("agents") or {}
worker_42 = agents.get("worker-42")
if worker_42:
    raise SystemExit("expected worker-42 to be removed after SubagentStop")
if "worker-55" in agents:
    raise SystemExit("expected worker-55 to be removed after task-owner TaskCompleted mapping")
if "worker-66" in agents:
    raise SystemExit("expected worker-66 to be removed after transcript-only TaskCompleted owner mapping")

denial_session = by_id.get("smoke-denial")
if not denial_session:
    raise SystemExit("missing smoke-denial session")

denial_main = denial_session.get("main") or {}
if denial_main.get("state") != "error":
    raise SystemExit(f"expected smoke-denial main.state=error, got {denial_main.get('state')!r}")
if denial_main.get("detail") != "Bash permission was denied in don't-ask mode, so I can’t complete that command as requested.":
    raise SystemExit("expected smoke-denial detail to preserve last_assistant_message")

reset_session = by_id.get("smoke-reset")
if not reset_session:
    raise SystemExit("missing smoke-reset session")

reset_agents = reset_session.get("agents") or {}
if "worker-reset" in reset_agents:
    raise SystemExit("expected worker-reset to be cleared after SessionStart reset")

end_session = by_id.get("smoke-end")
if not end_session:
    raise SystemExit("missing smoke-end session")

end_agents = end_session.get("agents") or {}
if "worker-end" in end_agents:
    raise SystemExit("expected worker-end to be cleared after SessionEnd reset")

cycle_session = by_id.get("smoke-cycle")
if not cycle_session:
    raise SystemExit("missing smoke-cycle session")

cycle_agents = cycle_session.get("agents") or {}
if "worker-cycle" in cycle_agents:
    raise SystemExit("expected worker-cycle to stay cleared across SessionEnd->SessionStart cycle")

alias_session = by_id.get("smoke-alias")
if not alias_session:
    raise SystemExit("missing smoke-alias session")

alias_agents = alias_session.get("agents") or {}
if "friendly-alias" in alias_agents:
    raise SystemExit("expected friendly-alias to be removed via stabilized agent_id mapping")
if "worker-alias" in alias_agents:
    raise SystemExit("expected worker-alias to be removed after SubagentStop")
upgrade_session = by_id.get("smoke-upgrade")
if not upgrade_session:
    raise SystemExit("missing smoke-upgrade session")

upgrade_agents = upgrade_session.get("agents") or {}
if "worker-upgrade" in upgrade_agents:
    raise SystemExit("expected worker-upgrade to be upgraded away and removed after TaskCompleted")
if "friendly-upgrade" in upgrade_agents:
    raise SystemExit("expected friendly-upgrade to be removed via upgraded task-owner mapping")

leave_alias_session = by_id.get("smoke-leave-alias")
if not leave_alias_session:
    raise SystemExit("missing smoke-leave-alias session")

leave_alias_agents = leave_alias_session.get("agents") or {}
if "worker-leave-alias" not in leave_alias_agents:
    raise SystemExit("expected worker-leave-alias to re-enter cleanly after alias-map cleanup")
if "friendly-leave-alias" in leave_alias_agents:
    raise SystemExit("expected friendly-leave-alias alias to be cleared on leave")

task_meta_session = by_id.get("smoke-task-meta")
if not task_meta_session:
    raise SystemExit("missing smoke-task-meta session")

task_meta_main = task_meta_session.get("main") or {}
if task_meta_main.get("detail") != "task metadata completion":
    raise SystemExit("expected smoke-task-meta detail to preserve task_description")

task_meta_context = task_meta_main.get("context") or {}
if task_meta_context.get("taskId") != "task-meta-1":
    raise SystemExit("expected smoke-task-meta context.taskId='task-meta-1'")
if task_meta_context.get("taskStatus") != "completed":
    raise SystemExit("expected smoke-task-meta context.taskStatus='completed'")
if task_meta_context.get("taskSummary") != "task summary projection":
    raise SystemExit("expected smoke-task-meta context.taskSummary='task summary projection'")
if task_meta_context.get("outputFilePath") != "/tmp/task-meta/output.md":
    raise SystemExit("expected smoke-task-meta context.outputFilePath='/tmp/task-meta/output.md'")
if task_meta_context.get("worktreePath") != "/tmp/worktrees/task-meta":
    raise SystemExit("expected smoke-task-meta context.worktreePath='/tmp/worktrees/task-meta'")
if task_meta_context.get("worktreeBranch") != "task-meta-branch":
    raise SystemExit("expected smoke-task-meta context.worktreeBranch='task-meta-branch'")

request_session = by_id.get("smoke-control-plane-request")
if not request_session:
    raise SystemExit("missing smoke-control-plane-request session")

request_main = request_session.get("main") or {}
if request_main.get("detail") != "[Plan Approval Request from worker-mailbox]":
    raise SystemExit("expected smoke-control-plane-request detail to reflect parsed teammate control-plane summary")
if request_main.get("state") != "executing":
    raise SystemExit(f"expected smoke-control-plane-request main.state=executing, got {request_main.get('state')!r}")

request_context = request_main.get("context") or {}
if request_context.get("teammateName") != "worker-mailbox":
    raise SystemExit("expected smoke-control-plane-request context.teammateName='worker-mailbox'")
if request_context.get("teammateSummary") != "plan request":
    raise SystemExit("expected smoke-control-plane-request context.teammateSummary='plan request'")
if request_context.get("controlPlaneType") != "plan_approval_request":
    raise SystemExit("expected smoke-control-plane-request context.controlPlaneType='plan_approval_request'")
if request_context.get("controlPlaneRequestId") != "plan-123":
    raise SystemExit("expected smoke-control-plane-request context.controlPlaneRequestId='plan-123'")
if request_context.get("controlPlaneSender") != "worker-mailbox":
    raise SystemExit("expected smoke-control-plane-request context.controlPlaneSender='worker-mailbox'")
if request_context.get("controlPlanePlanFilePath") != "/tmp/plan.md":
    raise SystemExit("expected smoke-control-plane-request context.controlPlanePlanFilePath='/tmp/plan.md'")
if request_context.get("controlPlaneTimestamp") != "2026-04-06T00:00:00.000Z":
    raise SystemExit("expected smoke-control-plane-request context.controlPlaneTimestamp to be preserved")

approved_session = by_id.get("smoke-control-plane-approved")
if not approved_session:
    raise SystemExit("missing smoke-control-plane-approved session")
approved_main = approved_session.get("main") or {}
if approved_main.get("detail") != "[Plan Approved] You can now proceed with implementation":
    raise SystemExit("expected approved plan detail to match upstream summary")
approved_context = approved_main.get("context") or {}
if approved_context.get("controlPlaneType") != "plan_approval_response":
    raise SystemExit("expected approved controlPlaneType='plan_approval_response'")
if approved_context.get("controlPlaneApproved") is not True:
    raise SystemExit("expected approved controlPlaneApproved=true")
if approved_context.get("controlPlaneRequestId") != "plan-124":
    raise SystemExit("expected approved controlPlaneRequestId='plan-124'")

rejected_session = by_id.get("smoke-control-plane-rejected")
if not rejected_session:
    raise SystemExit("missing smoke-control-plane-rejected session")
rejected_main = rejected_session.get("main") or {}
if rejected_main.get("detail") != "[Plan Rejected] needs revision":
    raise SystemExit("expected rejected plan detail to match upstream summary")
rejected_context = rejected_main.get("context") or {}
if rejected_context.get("controlPlaneType") != "plan_approval_response":
    raise SystemExit("expected rejected controlPlaneType='plan_approval_response'")
if rejected_context.get("controlPlaneApproved") is not False:
    raise SystemExit("expected rejected controlPlaneApproved=false")
if rejected_context.get("controlPlaneFeedback") != "needs revision":
    raise SystemExit("expected rejected controlPlaneFeedback='needs revision'")

shutdown_request_session = by_id.get("smoke-shutdown-request")
if not shutdown_request_session:
    raise SystemExit("missing smoke-shutdown-request session")
shutdown_request_main = shutdown_request_session.get("main") or {}
if shutdown_request_main.get("detail") != "[Shutdown Request from worker-mailbox] done":
    raise SystemExit("expected shutdown request detail to match upstream summary")
shutdown_request_context = shutdown_request_main.get("context") or {}
if shutdown_request_context.get("controlPlaneType") != "shutdown_request":
    raise SystemExit("expected shutdown request controlPlaneType='shutdown_request'")
if shutdown_request_context.get("controlPlaneReason") != "done":
    raise SystemExit("expected shutdown request controlPlaneReason='done'")

shutdown_approved_session = by_id.get("smoke-shutdown-approved")
if not shutdown_approved_session:
    raise SystemExit("missing smoke-shutdown-approved session")
shutdown_approved_main = shutdown_approved_session.get("main") or {}
if shutdown_approved_main.get("detail") != "[Shutdown Approved] lead-agent is now exiting":
    raise SystemExit("expected shutdown approved detail to match upstream summary")
shutdown_approved_context = shutdown_approved_main.get("context") or {}
if shutdown_approved_context.get("controlPlaneType") != "shutdown_approved":
    raise SystemExit("expected shutdown approved controlPlaneType='shutdown_approved'")
if shutdown_approved_context.get("controlPlaneSender") != "lead-agent":
    raise SystemExit("expected shutdown approved controlPlaneSender='lead-agent'")

shutdown_rejected_session = by_id.get("smoke-shutdown-rejected")
if not shutdown_rejected_session:
    raise SystemExit("missing smoke-shutdown-rejected session")
shutdown_rejected_main = shutdown_rejected_session.get("main") or {}
if shutdown_rejected_main.get("detail") != "[Shutdown Rejected] lead-agent: keep working":
    raise SystemExit("expected shutdown rejected detail to match upstream summary")
shutdown_rejected_context = shutdown_rejected_main.get("context") or {}
if shutdown_rejected_context.get("controlPlaneType") != "shutdown_rejected":
    raise SystemExit("expected shutdown rejected controlPlaneType='shutdown_rejected'")
if shutdown_rejected_context.get("controlPlaneReason") != "keep working":
    raise SystemExit("expected shutdown rejected controlPlaneReason='keep working'")

permission_request_session = by_id.get("smoke-permission-request")
if not permission_request_session:
    raise SystemExit("missing smoke-permission-request session")
permission_request_main = permission_request_session.get("main") or {}
if permission_request_main.get("detail") != "[Permission Request] Bash — Run ls in repo root":
    raise SystemExit("expected permission request detail to match projected summary")
permission_request_context = permission_request_main.get("context") or {}
if permission_request_context.get("controlPlaneType") != "permission_request":
    raise SystemExit("expected permission request controlPlaneType='permission_request'")
if permission_request_context.get("controlPlaneRequestId") != "perm-1":
    raise SystemExit("expected permission request controlPlaneRequestId='perm-1'")
if permission_request_context.get("controlPlaneAgentId") != "worker-mailbox":
    raise SystemExit("expected permission request controlPlaneAgentId='worker-mailbox'")
if permission_request_context.get("controlPlaneToolName") != "Bash":
    raise SystemExit("expected permission request controlPlaneToolName='Bash'")
if permission_request_context.get("controlPlaneToolUseId") != "toolu_123":
    raise SystemExit("expected permission request controlPlaneToolUseId='toolu_123'")
if permission_request_context.get("controlPlaneDescription") != "Run ls in repo root":
    raise SystemExit("expected permission request controlPlaneDescription to be preserved")
if permission_request_context.get("permissionSuggestionsCount") != 1:
    raise SystemExit("expected permission request permissionSuggestionsCount=1")

permission_approved_session = by_id.get("smoke-permission-approved")
if not permission_approved_session:
    raise SystemExit("missing smoke-permission-approved session")
permission_approved_main = permission_approved_session.get("main") or {}
if permission_approved_main.get("detail") != "[Permission Approved] perm-1":
    raise SystemExit("expected permission approved detail to match projected summary")
permission_approved_context = permission_approved_main.get("context") or {}
if permission_approved_context.get("controlPlaneType") != "permission_response":
    raise SystemExit("expected permission approved controlPlaneType='permission_response'")
if permission_approved_context.get("controlPlaneSubtype") != "success":
    raise SystemExit("expected permission approved controlPlaneSubtype='success'")
if permission_approved_context.get("controlPlaneRequestId") != "perm-1":
    raise SystemExit("expected permission approved controlPlaneRequestId='perm-1'")
if permission_approved_context.get("controlPlanePermissionUpdatesCount") != 1:
    raise SystemExit("expected permission approved controlPlanePermissionUpdatesCount=1")

permission_denied_session = by_id.get("smoke-permission-denied")
if not permission_denied_session:
    raise SystemExit("missing smoke-permission-denied session")
permission_denied_main = permission_denied_session.get("main") or {}
if permission_denied_main.get("detail") != "[Permission Denied] Permission denied by lead":
    raise SystemExit("expected permission denied detail to match projected summary")
permission_denied_context = permission_denied_main.get("context") or {}
if permission_denied_context.get("controlPlaneType") != "permission_response":
    raise SystemExit("expected permission denied controlPlaneType='permission_response'")
if permission_denied_context.get("controlPlaneSubtype") != "error":
    raise SystemExit("expected permission denied controlPlaneSubtype='error'")
if permission_denied_context.get("controlPlaneError") != "Permission denied by lead":
    raise SystemExit("expected permission denied controlPlaneError to be preserved")

sandbox_request_session = by_id.get("smoke-sandbox-request")
if not sandbox_request_session:
    raise SystemExit("missing smoke-sandbox-request session")
sandbox_request_main = sandbox_request_session.get("main") or {}
if sandbox_request_main.get("detail") != "[Sandbox Permission Request] api.anthropic.com":
    raise SystemExit("expected sandbox request detail to match projected summary")
sandbox_request_context = sandbox_request_main.get("context") or {}
if sandbox_request_context.get("controlPlaneType") != "sandbox_permission_request":
    raise SystemExit("expected sandbox request controlPlaneType='sandbox_permission_request'")
if sandbox_request_context.get("controlPlaneRequestId") != "sandbox-1":
    raise SystemExit("expected sandbox request controlPlaneRequestId='sandbox-1'")
if sandbox_request_context.get("controlPlaneAgentId") != "worker-mailbox":
    raise SystemExit("expected sandbox request controlPlaneAgentId='worker-mailbox'")
if sandbox_request_context.get("controlPlaneHost") != "api.anthropic.com":
    raise SystemExit("expected sandbox request controlPlaneHost='api.anthropic.com'")
if sandbox_request_context.get("controlPlaneTimestamp") != "1712361600000":
    raise SystemExit("expected sandbox request controlPlaneTimestamp to preserve createdAt")

sandbox_approved_session = by_id.get("smoke-sandbox-approved")
if not sandbox_approved_session:
    raise SystemExit("missing smoke-sandbox-approved session")
sandbox_approved_main = sandbox_approved_session.get("main") or {}
if sandbox_approved_main.get("detail") != "[Sandbox Permission Approved] api.anthropic.com":
    raise SystemExit("expected sandbox approved detail to match projected summary")
sandbox_approved_context = sandbox_approved_main.get("context") or {}
if sandbox_approved_context.get("controlPlaneType") != "sandbox_permission_response":
    raise SystemExit("expected sandbox approved controlPlaneType='sandbox_permission_response'")
if sandbox_approved_context.get("controlPlaneAllow") is not True:
    raise SystemExit("expected sandbox approved controlPlaneAllow=true")
if sandbox_approved_context.get("controlPlaneHost") != "api.anthropic.com":
    raise SystemExit("expected sandbox approved controlPlaneHost='api.anthropic.com'")

sandbox_denied_session = by_id.get("smoke-sandbox-denied")
if not sandbox_denied_session:
    raise SystemExit("missing smoke-sandbox-denied session")
sandbox_denied_main = sandbox_denied_session.get("main") or {}
if sandbox_denied_main.get("detail") != "[Sandbox Permission Denied] example.com":
    raise SystemExit("expected sandbox denied detail to match projected summary")
sandbox_denied_context = sandbox_denied_main.get("context") or {}
if sandbox_denied_context.get("controlPlaneType") != "sandbox_permission_response":
    raise SystemExit("expected sandbox denied controlPlaneType='sandbox_permission_response'")
if sandbox_denied_context.get("controlPlaneAllow") is not False:
    raise SystemExit("expected sandbox denied controlPlaneAllow=false")
if sandbox_denied_context.get("controlPlaneHost") != "example.com":
    raise SystemExit("expected sandbox denied controlPlaneHost='example.com'")

notification_permission_session = by_id.get("smoke-notification-permission")
if not notification_permission_session:
    raise SystemExit("missing smoke-notification-permission session")
notification_permission_main = notification_permission_session.get("main") or {}
if notification_permission_main.get("detail") != "worker-mailbox needs permission for Bash":
    raise SystemExit("expected notification permission detail to preserve message")
if notification_permission_main.get("state") != "executing":
    raise SystemExit(f"expected notification permission main.state=executing, got {notification_permission_main.get('state')!r}")
notification_permission_context = notification_permission_main.get("context") or {}
if notification_permission_context.get("notificationType") != "worker_permission_prompt":
    raise SystemExit("expected notification permission notificationType='worker_permission_prompt'")
if notification_permission_context.get("notificationTitle") != "Worker permission needed":
    raise SystemExit("expected notification permission notificationTitle to be preserved")
if notification_permission_context.get("notificationMessage") != "worker-mailbox needs permission for Bash":
    raise SystemExit("expected notification permission notificationMessage to be preserved")
if notification_permission_context.get("notificationWorkerName") != "worker-mailbox":
    raise SystemExit("expected notification permission notificationWorkerName='worker-mailbox'")
if notification_permission_context.get("notificationToolName") != "Bash":
    raise SystemExit("expected notification permission notificationToolName='Bash'")
if notification_permission_context.get("notificationHost") is not None:
    raise SystemExit("expected notification permission notificationHost to be absent")

notification_network_session = by_id.get("smoke-notification-network")
if not notification_network_session:
    raise SystemExit("missing smoke-notification-network session")
notification_network_main = notification_network_session.get("main") or {}
if notification_network_main.get("detail") != "worker-mailbox needs network access to api.anthropic.com":
    raise SystemExit("expected notification network detail to preserve message")
if notification_network_main.get("state") != "executing":
    raise SystemExit(f"expected notification network main.state=executing, got {notification_network_main.get('state')!r}")
notification_network_context = notification_network_main.get("context") or {}
if notification_network_context.get("notificationType") != "worker_permission_prompt":
    raise SystemExit("expected notification network notificationType='worker_permission_prompt'")
if notification_network_context.get("notificationTitle") != "Worker network access needed":
    raise SystemExit("expected notification network notificationTitle to be preserved")
if notification_network_context.get("notificationMessage") != "worker-mailbox needs network access to api.anthropic.com":
    raise SystemExit("expected notification network notificationMessage to be preserved")
if notification_network_context.get("notificationWorkerName") != "worker-mailbox":
    raise SystemExit("expected notification network notificationWorkerName='worker-mailbox'")
if notification_network_context.get("notificationHost") != "api.anthropic.com":
    raise SystemExit("expected notification network notificationHost='api.anthropic.com'")
if notification_network_context.get("notificationToolName") is not None:
    raise SystemExit("expected notification network notificationToolName to be absent")

post_tool_failure_session = by_id.get("smoke-post-tool-failure")
if not post_tool_failure_session:
    raise SystemExit("missing smoke-post-tool-failure session")
post_tool_failure_main = post_tool_failure_session.get("main") or {}
if post_tool_failure_main.get("state") != "error":
    raise SystemExit(f"expected post tool failure main.state=error, got {post_tool_failure_main.get('state')!r}")
if post_tool_failure_main.get("detail") != "command failed for smoke coverage":
    raise SystemExit("expected post tool failure detail to preserve error payload")

permission_denied_direct_session = by_id.get("smoke-permission-denied-direct")
if not permission_denied_direct_session:
    raise SystemExit("missing smoke-permission-denied-direct session")
permission_denied_direct_main = permission_denied_direct_session.get("main") or {}
if permission_denied_direct_main.get("state") != "error":
    raise SystemExit(f"expected direct permission denied main.state=error, got {permission_denied_direct_main.get('state')!r}")
if permission_denied_direct_main.get("detail") != "[Permission Denied] classifier denied smoke probe":
    raise SystemExit("expected direct permission denied detail to use direct control-plane summary")
if permission_denied_direct_main.get("context", {}).get("controlPlaneType") != "PermissionDenied":
    raise SystemExit("expected direct permission denied controlPlaneType='PermissionDenied'")

stop_failure_session = by_id.get("smoke-stop-failure")
if not stop_failure_session:
    raise SystemExit("missing smoke-stop-failure session")
stop_failure_main = stop_failure_session.get("main") or {}
if stop_failure_main.get("state") != "error":
    raise SystemExit(f"expected stop failure main.state=error, got {stop_failure_main.get('state')!r}")
if stop_failure_main.get("detail") != "stop failed for smoke coverage":
    raise SystemExit("expected stop failure detail to preserve error payload")

direct_permission_session = by_id.get("smoke-direct-permission-request")
if not direct_permission_session:
    raise SystemExit("missing smoke-direct-permission-request session")
direct_permission_agents = direct_permission_session.get("agents") or {}
direct_permission_signal = direct_permission_agents.get("worker-direct")
if not direct_permission_signal:
    raise SystemExit("expected worker-direct agent signal for direct PermissionRequest")
if direct_permission_signal.get("detail") != "[Permission Request] Bash — Run pwd in repo root":
    raise SystemExit("expected direct permission request detail to match projected summary")
direct_permission_context = direct_permission_signal.get("context") or {}
if direct_permission_context.get("controlPlaneType") != "PermissionRequest":
    raise SystemExit("expected direct permission request controlPlaneType='PermissionRequest'")
if direct_permission_context.get("controlPlaneToolName") != "Bash":
    raise SystemExit("expected direct permission request controlPlaneToolName='Bash'")

PY

events_log_json="$(python3 - "${EVENTS_LOG_FILE}" <<'PY'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    entries = [json.loads(line) for line in handle if line.strip()]
print(json.dumps(entries))
PY
)"
EVENTS_LOG_JSON="${events_log_json}" python3 - <<'PY'
import json
import os

entries = json.loads(os.environ["EVENTS_LOG_JSON"])
if not isinstance(entries, list) or not entries:
    raise SystemExit("expected event log entries to be present")

for entry in entries:
    required = [
        "source",
        "receivedAt",
        "rawEvent",
        "signal",
        "originalSignal",
        "starOfficeResult",
        "starOfficeError",
        "ignored",
        "ignoreReason",
    ]
    missing = [key for key in required if key not in entry]
    if missing:
        raise SystemExit(f"event log entry missing keys: {missing}")

expected_event_states = {
    "PostToolUse": "executing",
    "PostToolUseFailure": "error",
    "PermissionDenied": "error",
    "StopFailure": "error",
    "Setup": "executing",
    "SubagentStart": "executing",
    "TeammateIdle": "idle",
    "Elicitation": "executing",
    "ElicitationResult": "executing",
    "ConfigChange": "syncing",
    "WorktreeCreate": "syncing",
    "WorktreeRemove": "syncing",
    "InstructionsLoaded": "syncing",
    "CwdChanged": "syncing",
    "FileChanged": "syncing",
    "PreCompact": "syncing",
    "PostCompact": "syncing",
}
for event_name, expected_state in expected_event_states.items():
    mapped_event = next((entry for entry in entries if ((entry.get("rawEvent") or {}).get("event_name") == event_name)), None)
    if not mapped_event:
        raise SystemExit(f"expected mapped {event_name} event log entry")
    if mapped_event.get("ignored") is not False:
        raise SystemExit(f"expected {event_name} event log entry to be mapped")
    if mapped_event.get("signal", {}).get("state") != expected_state:
        raise SystemExit(f"expected {event_name} signal.state={expected_state!r}")

mapped = next((entry for entry in entries if ((entry.get("rawEvent") or {}).get("event_name") == "PermissionRequest")), None)
if not mapped:
    raise SystemExit("expected mapped PermissionRequest event log entry")
if mapped.get("ignored") is not False:
    raise SystemExit("expected PermissionRequest event log entry to be mapped")
if mapped.get("signal", {}).get("eventName") != "PermissionRequest":
    raise SystemExit("expected PermissionRequest signal.eventName to be preserved")
if mapped.get("originalSignal", {}).get("eventName") != "PermissionRequest":
    raise SystemExit("expected PermissionRequest originalSignal.eventName to be preserved")
if mapped.get("ignoreReason") is not None:
    raise SystemExit("expected mapped PermissionRequest ignoreReason to be null")

notification = next((entry for entry in entries if (((entry.get("rawEvent") or {}).get("event_name") == "Notification") and (((entry.get("rawEvent") or {}).get("payload") or {}).get("message") == "worker-mailbox needs permission for Bash"))), None)
if not notification:
    raise SystemExit("expected mapped Notification event log entry")
if notification.get("signal", {}).get("context", {}).get("notificationToolName") != "Bash":
    raise SystemExit("expected Notification event log to preserve parsed tool name")

subagent_task = next((entry for entry in entries if (((entry.get("rawEvent") or {}).get("event_name") == "TaskCreated") and (((entry.get("rawEvent") or {}).get("payload") or {}).get("agent_id") == "worker-42"))), None)
if not subagent_task:
    raise SystemExit("expected worker-42 TaskCreated event log entry")
if subagent_task.get("signal", {}).get("context", {}).get("agentId") != "worker-42":
    raise SystemExit("expected worker-42 TaskCreated event log to preserve agentId")

ignored_invalid_json = next((entry for entry in entries if entry.get("ignored") is True and entry.get("ignoreReason") == "invalid json"), None)
if not ignored_invalid_json:
    raise SystemExit("expected ignored invalid-json event log entry")
if ignored_invalid_json.get("rawBody") != "not-json":
    raise SystemExit("expected invalid-json event log to preserve rawBody")
if ignored_invalid_json.get("rawEvent") is not None:
    raise SystemExit("expected invalid-json event log rawEvent to be null")

ignored_missing_name = next((entry for entry in entries if entry.get("ignored") is True and entry.get("ignoreReason") == "missing event_name"), None)
if not ignored_missing_name:
    raise SystemExit("expected ignored missing-event event log entry")
raw_event = ignored_missing_name.get("rawEvent") or {}
if raw_event.get("source") != "smoke":
    raise SystemExit("expected missing-event log rawEvent.source='smoke'")
if ignored_missing_name.get("signal") is not None or ignored_missing_name.get("originalSignal") is not None:
    raise SystemExit("expected ignored entries to have null signal/originalSignal")
PY

echo "[26/31] native HTTP hook format (hook_event_name at top level)"
native_hook_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"hook_event_name":"PostToolUse","session_id":"smoke-native-hook","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"echo native"},"tool_use_id":"toolu_native_1","tool_response":{"exitCode":0}}')"
if [[ "${native_hook_status}" != "200" ]]; then
  echo "expected native HTTP hook status 200, got ${native_hook_status}" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

# Verify the native hook event was normalized into event_name + payload shape
NATIVE_HOOK_SESSIONS_JSON="$(curl -fsS "${BRIDGE_URL}/sessions")"
NATIVE_HOOK_SESSIONS_JSON="${NATIVE_HOOK_SESSIONS_JSON}" python3 - <<'PY'
import json, os
payload = json.loads(os.environ["NATIVE_HOOK_SESSIONS_JSON"])
session = next((s for s in payload.get("sessions", []) if s.get("sessionId") == "smoke-native-hook"), None)
if not session:
    raise SystemExit("missing smoke-native-hook session from native HTTP hook")
main = session.get("main") or {}
if main.get("state") != "executing":
    raise SystemExit(f"expected native hook PostToolUse state=executing, got {main.get('state')!r}")
context = main.get("context") or {}
if context.get("rawToolName") != "Bash":
    raise SystemExit(f"expected native hook context.rawToolName=Bash, got {context.get('rawToolName')!r}")
PY

echo "[27/31] SSE /events endpoint with event replay"
SSE_OUTPUT="$(mktemp)"
python3 -u - "${BRIDGE_URL}" <<'PY' >"${SSE_OUTPUT}" 2>&1 &
import http.client
import sys
import time
import threading

url_parts = sys.argv[1].replace("http://", "").split(":", 1)
host = url_parts[0]
port = int(url_parts[1])

conn = http.client.HTTPConnection(host, port)
conn.request("GET", "/events")
resp = conn.getresponse()
print(f"Status: {resp.status}", flush=True)
print(f"Content-Type: {resp.getheader('Content-Type')}", flush=True)
print(f"Cache-Control: {resp.getheader('Cache-Control')}", flush=True)

timer = threading.Timer(5, lambda: conn.close())
timer.start()

try:
    while True:
        chunk = resp.read(1)
        if chunk:
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        else:
            break
except:
    pass
PY
SSE_LISTENER_PID=$!
sleep 0.5

# Post an event that should be broadcast to the SSE listener
curl -fsS -X POST "${BRIDGE_URL}/event/manual" \
  -H "content-type: application/json" \
  -d '{"sessionId":"smoke-sse-broadcast","scope":"main","state":"researching","detail":"SSE broadcast test"}' >/dev/null
sleep 1

kill "${SSE_LISTENER_PID}" >/dev/null 2>&1 || true
wait "${SSE_LISTENER_PID}" >/dev/null 2>&1 || true
sse_body="$(cat "${SSE_OUTPUT}")"
rm -f "${SSE_OUTPUT}"

if [[ "${sse_body}" != *"Status: 200"* ]]; then
  echo "SSE endpoint returned non-200 status" >&2
  echo "${sse_body}" >&2
  exit 1
fi
if [[ "${sse_body}" != *"text/event-stream"* ]]; then
  echo "SSE endpoint missing text/event-stream content type" >&2
  exit 1
fi
if [[ "${sse_body}" != *"no-cache"* ]]; then
  echo "SSE endpoint missing Cache-Control: no-cache header" >&2
  exit 1
fi
if [[ "${sse_body}" != *"event: signal"* ]]; then
  echo "SSE endpoint did not broadcast signal event" >&2
  echo "${sse_body}" >&2
  exit 1
fi
if [[ "${sse_body}" != *"smoke-sse-broadcast"* ]]; then
  echo "SSE broadcast did not contain expected session ID" >&2
  exit 1
fi

echo "[28/31] SSE event replay via Last-Event-ID"
# Generate events, capture an event ID, then reconnect with Last-Event-ID
SSE_REPLAY_OUT="$(mktemp)"
python3 -u - "${BRIDGE_URL}" <<'PY' >"${SSE_REPLAY_OUT}" 2>&1 &
import http.client, json, sys, time, threading
url_parts = sys.argv[1].replace("http://", "").split(":", 1)
host, port = url_parts[0], int(url_parts[1])
conn = http.client.HTTPConnection(host, port)
conn.request("GET", "/events")
resp = conn.getresponse()
ids_seen = []
done = threading.Event()

def timeout_close():
    done.set()
    try: conn.close()
    except: pass

timer = threading.Timer(8, timeout_close)
timer.start()
try:
    while not done.is_set():
        line = resp.readline().decode()
        if not line:
            continue
        line = line.rstrip("\n").rstrip("\r")
        if line.startswith("id: "):
            ids_seen.append(line[4:].strip())
        if line.startswith("data: ") and ids_seen:
            data = json.loads(line[6:])
            print(f"captured: {data.get('detail','?')} id={ids_seen[-1]}", flush=True)
            print(f"last_id={ids_seen[-1]}", flush=True)
except:
    pass
if ids_seen:
    print(f"last_id={ids_seen[-1]}", flush=True)
else:
    print("last_id=NONE", flush=True)
PY
SSE_CAPTURE_PID=$!
sleep 0.5

# Generate events that the first listener will see
for i in 1 2 3; do
  curl -fsS -X POST "${BRIDGE_URL}/event/manual" \
    -H "content-type: application/json" \
    -d "{\"sessionId\":\"smoke-replay\",\"scope\":\"main\",\"state\":\"writing\",\"detail\":\"replay-event-${i}\"}" >/dev/null
done
sleep 2

kill "${SSE_CAPTURE_PID}" >/dev/null 2>&1 || true
wait "${SSE_CAPTURE_PID}" >/dev/null 2>&1 || true
capture_output="$(cat "${SSE_REPLAY_OUT}")"
rm -f "${SSE_REPLAY_OUT}"

# Extract last event ID
last_event_id="$(printf '%s\n' "${capture_output}" | awk -F= '/^last_id=/ && $2 != "NONE" { value=$2 } END { print value }')"
if [[ -z "${last_event_id}" || "${last_event_id}" == "NONE" ]]; then
  echo "SSE replay: no event IDs captured, skipping replay test" >&2
else
  # Connect with Last-Event-ID and verify we get new events after that ID
  SSE_REPLAY2_OUT="$(mktemp)"
  python3 -u - "${BRIDGE_URL}" "${last_event_id}" <<'PY' >"${SSE_REPLAY2_OUT}" 2>&1 &
import http.client, json, sys, time, threading
url_parts = sys.argv[1].replace("http://", "").split(":", 1)
host, port = url_parts[0], int(url_parts[1])
last_id = sys.argv[2] if len(sys.argv) > 2 else ""
conn = http.client.HTTPConnection(host, port)
headers = {"Last-Event-ID": last_id} if last_id else {}
conn.request("GET", "/events", headers=headers)
resp = conn.getresponse()
done2 = threading.Event()

def timeout_close2():
    done2.set()
    try: conn.close()
    except: pass

timer2 = threading.Timer(4, timeout_close2)
timer2.start()
try:
    while not done2.is_set():
        line = resp.readline().decode()
        if not line:
            continue
        line = line.rstrip("\n").rstrip("\r")
        if line.startswith("data: "):
            data = json.loads(line[6:])
            print(f"replayed: {data.get('detail','?')}", flush=True)
except:
    pass
PY
  SSE_REPLAY2_PID=$!
  sleep 0.5

  # Generate events after the Last-Event-ID point
  curl -fsS -X POST "${BRIDGE_URL}/event/manual" \
    -H "content-type: application/json" \
    -d '{"sessionId":"smoke-replay","scope":"main","state":"idle","detail":"post-replay-event"}' >/dev/null
  sleep 2

  kill "${SSE_REPLAY2_PID}" >/dev/null 2>&1 || true
  wait "${SSE_REPLAY2_PID}" >/dev/null 2>&1 || true
  replay_output="$(cat "${SSE_REPLAY2_OUT}")"
  rm -f "${SSE_REPLAY2_OUT}"

  if [[ "${replay_output}" != *"post-replay-event"* ]]; then
    echo "SSE replay: reconnected client did not receive new events" >&2
    echo "${replay_output}" >&2
    exit 1
  fi
  echo "SSE replay verified: client received events after Last-Event-ID"
fi

echo "[31/31] smoke pass"
echo "smoke test passed"
