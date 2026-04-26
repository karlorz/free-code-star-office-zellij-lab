# sg01 Interactive Hooks Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the interactive notification capture helper so it guides sg01 Zellij web validation without storing or printing secrets.

**Architecture:** Keep the existing bridge/plugin/runtime flow intact. Add script-level configuration and operator-facing output only, then verify with typecheck and shell syntax checks.

**Tech Stack:** Bash, Bun, TypeScript, Claude/free-code plugin hooks, Zellij web operator workflow.

---

## File Structure

- Modify: `scripts/run-interactive-notification-capture.sh`
  - Responsibility: start the lab bridge, wire the draft plugin, launch the interactive runtime, and print sg01/Zellij-web validation guidance.
- No test file is added because this change is a Bash operator helper. Validation uses `bash -n` plus existing TypeScript typecheck.
- No `.env` or token-bearing file is modified.

## Task 1: Add sg01 Zellij Web Configuration to the Helper

**Files:**
- Modify: `scripts/run-interactive-notification-capture.sh:5-16`

- [ ] **Step 1: Add environment defaults near existing script configuration**

Change the top configuration block to include Zellij web metadata. Keep the token optional and never echo its value.

```bash
FREE_CODE_ROOT="${FREE_CODE_ROOT:-/Users/karlchow/Desktop/code/free-code}"
FREE_CODE_ENTRYPOINT="${FREE_CODE_ENTRYPOINT:-${FREE_CODE_ROOT}/src/entrypoints/cli.tsx}"
PLUGIN_DIR="${CLAUDE_PLUGIN_DIR:-${REPO_ROOT}/plugins/claude-star-office-bridge}"
BRIDGE_HOST="${BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${BRIDGE_PORT:-4317}"
BRIDGE_DRY_RUN="${BRIDGE_DRY_RUN:-true}"
MAX_BRIDGE_PORT_ATTEMPTS="${MAX_BRIDGE_PORT_ATTEMPTS:-8}"
PERMISSION_MODE="${PERMISSION_MODE:-default}"
ZELLIJ_WEB_URL="${ZELLIJ_WEB_URL:-https://term.karldigi.dev/main}"
ZELLIJ_SESSION_NAME="${ZELLIJ_SESSION_NAME:-}"
ZELLIJ_WEB_TOKEN="${ZELLIJ_WEB_TOKEN:-}"
BRIDGE_URL="http://${BRIDGE_HOST}:${BRIDGE_PORT}"
EVENTS_LOG="${REPO_ROOT}/tmp/events.ndjson"
BRIDGE_LOG="${REPO_ROOT}/tmp/live-bridge.log"
```

- [ ] **Step 2: Run shell syntax check**

Run:

```bash
bash -n scripts/run-interactive-notification-capture.sh
```

Expected: no output and exit code 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/run-interactive-notification-capture.sh
git commit -m "Add sg01 Zellij web capture configuration"
```

## Task 2: Document New Environment Variables in Usage Output

**Files:**
- Modify: `scripts/run-interactive-notification-capture.sh:21-45`

- [ ] **Step 1: Update the usage heredoc**

Add these lines after `LEADER_PROMPT` in the `Environment overrides:` section:

```bash
  ZELLIJ_WEB_URL     Default: https://term.karldigi.dev/main
  ZELLIJ_SESSION_NAME Optional expected session name in sg01 Zellij web
  ZELLIJ_WEB_TOKEN   Optional operator token; only set/unset status is printed
```

- [ ] **Step 2: Verify help output includes the new variables**

Run:

```bash
./scripts/run-interactive-notification-capture.sh --help
```

Expected output includes:

```text
ZELLIJ_WEB_URL     Default: https://term.karldigi.dev/main
ZELLIJ_SESSION_NAME Optional expected session name in sg01 Zellij web
ZELLIJ_WEB_TOKEN   Optional operator token; only set/unset status is printed
```

- [ ] **Step 3: Commit**

```bash
git add scripts/run-interactive-notification-capture.sh
git commit -m "Document sg01 Zellij web capture settings"
```

## Task 3: Print the sg01 Operator Checklist Before Launch

**Files:**
- Modify: `scripts/run-interactive-notification-capture.sh:174-181`

- [ ] **Step 1: Add token status and session label variables before the existing capture output**

Insert before the first `echo "[interactive-capture] bridge: ..."` line:

```bash
zellij_token_status="unset"
if [[ -n "${ZELLIJ_WEB_TOKEN}" ]]; then
  zellij_token_status="set (redacted)"
fi

zellij_session_label="not specified"
if [[ -n "${ZELLIJ_SESSION_NAME}" ]]; then
  zellij_session_label="${ZELLIJ_SESSION_NAME}"
fi
```

- [ ] **Step 2: Replace the current reminder block with the sg01 checklist**

Replace these lines:

```bash
echo "[interactive-capture] reminder: run this in a pane-capable interactive terminal and create the team from the leader session rather than using -p/--print."
echo "[interactive-capture] recommended leader prompt:"
printf '%s\n' "${LEADER_PROMPT}"
```

With:

```bash
echo "[interactive-capture] sg01 Zellij web: ${ZELLIJ_WEB_URL}"
echo "[interactive-capture] sg01 Zellij session: ${zellij_session_label}"
echo "[interactive-capture] sg01 Zellij web token: ${zellij_token_status}"
echo "[interactive-capture] operator checklist:"
echo "  1. Open the sg01 Zellij web URL above."
echo "  2. Provide the Zellij web token in the browser/operator flow when prompted; do not paste it into this repo."
echo "  3. Attach to the expected session if one is configured."
echo "  4. Use the interactive leader session launched by this script."
echo "  5. Create the team from the leader session, not from -p/--print mode."
echo "  6. Trigger the worker permission probe: touch worker-permission-probe.txt."
echo "[interactive-capture] recommended leader prompt:"
printf '%s\n' "${LEADER_PROMPT}"
```

- [ ] **Step 3: Verify help still works without launching runtime**

Run:

```bash
./scripts/run-interactive-notification-capture.sh --help
```

Expected: help output prints and exits before bridge startup.

- [ ] **Step 4: Run shell syntax check**

Run:

```bash
bash -n scripts/run-interactive-notification-capture.sh
```

Expected: no output and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-interactive-notification-capture.sh
git commit -m "Print sg01 interactive capture checklist"
```

## Task 4: Print Post-Run Capture Review Guidance

**Files:**
- Modify: `scripts/run-interactive-notification-capture.sh:183-188`

- [ ] **Step 1: Add post-run guidance after the runtime subshell**

After this block:

```bash
(
  cd "${FREE_CODE_ROOT}"
  env "${runtime_env[@]}" \
    bun run "${FREE_CODE_ENTRYPOINT}" "${plugin_args[@]}" "${runtime_args[@]}"
)
```

Add:

```bash
cat <<EOF
[interactive-capture] capture finished
[interactive-capture] review artifact: ${EVENTS_LOG}
[interactive-capture] success patterns to inspect:
  - Notification events for leader-side worker permission prompts
  - permission_request or PermissionRequest control-plane payloads
  - TaskCreated events that identify worker ownership
  - TaskCompleted or SubagentStop events that cleanly remove workers
[interactive-capture] bridge log: ${BRIDGE_LOG}
EOF
```

- [ ] **Step 2: Run shell syntax check**

Run:

```bash
bash -n scripts/run-interactive-notification-capture.sh
```

Expected: no output and exit code 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/run-interactive-notification-capture.sh
git commit -m "Add interactive capture review guidance"
```

## Task 5: Run Final Validation

**Files:**
- Validate: `scripts/run-interactive-notification-capture.sh`
- Validate: `package.json`

- [ ] **Step 1: Run TypeScript typecheck**

Run:

```bash
bun run typecheck
```

Expected: command exits 0.

- [ ] **Step 2: Run shell syntax check**

Run:

```bash
bash -n scripts/run-interactive-notification-capture.sh
```

Expected: no output and exit code 0.

- [ ] **Step 3: Verify token value is not present in tracked files**

Run:

```bash
git grep -n "<redacted-zellij-web-token>" -- . ':!.env'
```

Expected: no output and exit code 1, meaning the token is not tracked. If it prints a match, remove the token before committing.

- [ ] **Step 4: Review final diff**

Run:

```bash
git diff -- scripts/run-interactive-notification-capture.sh
```

Expected: only script guidance/configuration changes; no secret values.

- [ ] **Step 5: Commit final validation note if needed**

If Task 5 required no file changes, do not create an empty commit. If it required a fix, commit only that fix:

```bash
git add scripts/run-interactive-notification-capture.sh
git commit -m "Validate sg01 interactive capture helper"
```

## Task 6: Optional Manual sg01/Zellij Web Check

**Files:**
- No repository changes expected.

- [ ] **Step 1: Start the helper with the operator token in the environment**

Run only when ready for an interactive session:

```bash
ZELLIJ_WEB_TOKEN='<operator-provided-token>' ./scripts/run-interactive-notification-capture.sh
```

Expected: script prints `sg01 Zellij web token: set (redacted)` and does not print the token value.

- [ ] **Step 2: Use sg01 Zellij web**

Open:

```text
https://term.karldigi.dev/main
```

Expected: the deployed Zellij web terminal is reachable and accepts the operator token through its normal UI flow.

- [ ] **Step 3: Trigger the permission probe**

Use the launched leader session and prompt to create the worker. The worker action should be:

```bash
touch worker-permission-probe.txt
```

Expected: leader-side notification/permission events appear during the interactive session.

- [ ] **Step 4: Inspect capture artifacts**

Run:

```bash
grep -E 'Notification|permission_request|PermissionRequest|TaskCreated|TaskCompleted|SubagentStop' tmp/events.ndjson
```

Expected: at least one relevant event line appears. If no line appears, preserve `tmp/live-bridge.log` and `tmp/events.ndjson` for diagnosis.

---

## Self-Review

- Spec coverage: The plan covers helper configuration, sg01 URL defaults, optional token handling without printing, operator checklist, post-run artifact guidance, and validation commands. It explicitly excludes SSH automation, browser automation, Star Office live endpoint changes, and a bridge-side report endpoint.
- Placeholder scan: No TBD/TODO/fill-in placeholders remain. The only token placeholder is intentionally shown as `<operator-provided-token>` for a manual command and must not be committed with a real token.
- Type consistency: Environment variable names match the design spec: `ZELLIJ_WEB_URL`, `ZELLIJ_SESSION_NAME`, and `ZELLIJ_WEB_TOKEN`.
