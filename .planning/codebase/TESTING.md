# Testing Setup

## Overview

This project uses a **smoke test approach** rather than traditional unit tests. There are no `.test.ts` or `.spec.ts` files in the repository. Testing is performed via a comprehensive bash script that starts the server and validates behavior through HTTP endpoints.

## Smoke Test

### Location
`scripts/smoke-test.sh` - A comprehensive 30-step smoke test (450+ lines)

### Execution
```bash
# Run with default port
./scripts/smoke-test.sh

# Run with custom port
SMOKE_BRIDGE_PORT=4318 ./scripts/smoke-test.sh
```

### What It Tests

The smoke test validates:
1. **Server Startup** - Bridge starts and `/health` endpoint responds
2. **Manual State Injection** - POST to `/event/manual` for main and subagent states
3. **Hook Event Processing** - POST to `/hook/claude` with various event types
4. **Session Management** - Verifies sessions appear in `/sessions` endpoint
5. **Parent Session ID** - Subagent events correctly track parent session
6. **Session Reset** - `SessionStart` and `SessionEnd` clear agent state
7. **Agent Identity Stabilization** - Agent ID mapping across name changes
8. **Task Owner Mapping** - Tasks correctly attributed to creating agents
9. **Stop Denial Fallback** - Permission denial maps to error state
10. **Task Metadata Projection** - `taskId`, `taskStatus`, `taskSummary`, `outputFilePath`, `worktreePath`, `worktreeBranch`
11. **Control Plane Messages** - Teammate messages for plan approval, shutdown, permissions
12. **Notification Parsing** - Worker permission and network access notifications
13. **Invalid Input Handling** - Rejects invalid JSON and missing `event_name`

### Test Structure

Each step follows this pattern:
```bash
echo "[N/N] description"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"EventName","payload":{...}}' >/dev/null
```

### Validation

Validation uses embedded Python scripts to inspect the `/sessions` response:
```python
SESSIONS_JSON="${hook_live_json}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["SESSIONS_JSON"])
if not payload.get("ok"):
    raise SystemExit("sessions endpoint returned ok=false")

sessions = payload.get("sessions", [])
by_id = {session.get("sessionId"): session for session in sessions}
# ... assertions
PY
```

### Event Log Validation

The smoke test also validates the events log file (`tmp/events.ndjson`):
```python
events_log_json="$(python3 - "${EVENTS_LOG_FILE}" <<'PY'
import json
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    entries = [json.loads(line) for line in handle if line.strip()]
print(json.dumps(entries))
PY
)"
```

## Type Checking

### TypeScript Compiler
```bash
bun run typecheck
# or
tsc --noEmit
```

No custom tsconfig options are used; defaults from `tsconfig.json` apply.

## Development Server

### Running Locally
```bash
bun run dev
# or
bun run src/index.ts
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_HOST` | `127.0.0.1` | Server bind address |
| `BRIDGE_PORT` | `4317` | Server port |
| `BRIDGE_SECRET` | `undefined` | Secret for authorization |
| `BRIDGE_DRY_RUN` | `true` | Skip Star Office API calls |
| `BRIDGE_EVENTS_LOG_PATH` | `tmp/events.ndjson` | Path for event log |
| `STAR_OFFICE_URL` | `undefined` | Star Office API URL |
| `STAR_OFFICE_JOIN_KEY` | `undefined` | Join key for agent sync |

## Health Check

### Endpoint
```
GET /health
```

### Response
```json
{
  "ok": true,
  "host": "127.0.0.1",
  "port": 4317,
  "dryRun": true,
  "starOfficeUrl": null
}
```

## Sessions Endpoint

### Endpoint
```
GET /sessions
```

### Response
```json
{
  "ok": true,
  "sessions": [
    {
      "sessionId": "smoke-hook",
      "cwd": "/root/workspace",
      "transcriptPath": undefined,
      "updatedAt": "2026-04-07T12:00:00.000Z",
      "main": {
        "sessionId": "smoke-hook",
        "agentName": "main",
        "scope": "main",
        "state": "researching",
        "detail": "hook test main",
        "eventName": "PreToolUse",
        "shouldLeave": false,
        "context": { ... }
      },
      "agents": {
        "worker-42": { ... }
      }
    }
  ]
}
```

## Test Event Payloads

### Main Agent State
```json
{
  "source": "smoke",
  "event_name": "PreToolUse",
  "payload": {
    "session_id": "smoke-main",
    "tool_name": "Read",
    "task_subject": "smoke test main"
  }
}
```

### Subagent Lifecycle
```json
{
  "source": "smoke",
  "event_name": "TaskCreated",
  "payload": {
    "session_id": "smoke-hook",
    "agent_id": "worker-42",
    "agent_transcript_path": "/tmp/worker-42.jsonl",
    "parent_session_id": "smoke-parent",
    "task_subject": "hook test subagent"
  }
}
```

### Control Plane Message
```json
{
  "source": "smoke",
  "event_name": "UserPromptSubmit",
  "payload": {
    "session_id": "smoke-control-plane-request",
    "prompt": "<teammate-message teammate_id=\"worker-mailbox\" summary=\"plan request\">\n{\"type\":\"plan_approval_request\",\"from\":\"worker-mailbox\",\"timestamp\":\"2026-04-06T00:00:00.000Z\",\"planFilePath\":\"/tmp/plan.md\",\"planContent\":\"# Plan\",\"requestId\":\"plan-123\"}\n</teammate-message>"
  }
}
```

## No Unit Test Framework

The project deliberately does not use:
- Jest, Vitest, or other test runners
- `.test.ts` or `.spec.ts` files
- `describe`/`it`/`expect` patterns

If adding unit tests, consider:
- Vitest would be the natural choice for Bun-compatible testing
- Test files should live alongside source: `src/stateMapper.test.ts`
- Mock `StarOfficeClient` for isolated unit tests

## Adding Tests

To add a new test scenario:

1. Add a step in `smoke-test.sh`:
```bash
echo "[N/N] new test scenario"
curl -fsS -X POST "${BRIDGE_URL}/hook/claude" \
  -H "content-type: application/json" \
  -d '{"source":"smoke","event_name":"YourEvent","payload":{...}}' >/dev/null
```

2. Add assertions after the step using Python:
```python
NEW_SESSION_JSON="$(curl -fsS "${BRIDGE_URL}/sessions")"
SESSION_JSON="${NEW_SESSION_JSON}" python3 - <<'PY'
import json
import os
payload = json.loads(os.environ["SESSION_JSON"])
# ... your assertions
PY
```
