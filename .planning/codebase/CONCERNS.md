# Codebase Concerns

## Risks

- **Payload drift between official Claude Code hooks and free-code runtime**: The stateMapper.ts uses multiple fallback field names (e.g., `firstString` tries `session_id`, `sessionId`, `conversation_id`, `request_id`). If free-code emits fields with different naming conventions or omits expected fields, normalization will silently use fallbacks that may be semantically incorrect.

- **Subagent event compatibility is unverified**: The README explicitly states "Whether subagent event names and payloads match official Claude Code closely enough to reuse the same mapper unchanged" is unknown. The `sessionRegistry.ts` has complex logic for tracking agent identities across events (`rememberAgentIdentity`, `renameTaskOwnersForAgent`), but this was designed for official Claude Code behavior.

- **Draft plugin installation path not validated**: The README notes "The final plugin installation path and plugin enablement workflow on the local machine" is still needs a live validation pass. If the plugin cannot be enabled or fails to load, the entire hook forwarding pipeline breaks silently.

- **In-memory session state is not durable**: `SessionRegistry` maintains all session/agent state in RAM. If the bridge process crashes or restarts, all session context is lost. Star Office UI will receive stale state with no recovery mechanism.

- **Agent identity resolution can produce silent wrong-agent attribution**: In `sessionRegistry.ts` lines 86-105, when a known generic agent ID receives a specific name, the code deletes the old key and renames. If events arrive out of order, an event could be attributed to the wrong agent because `agentNamesById` was already updated.

- **Dry-run mode may mask real integration failures**: The bridge defaults to `BRIDGE_DRY_RUN=true`, which means `run-live-capture.sh` never actually calls Star Office UI endpoints. Payload normalization and event mapping are tested, but the actual `/set_state`, `/join-agent`, `/agent-push`, `/leave-agent` HTTP calls are never exercised.

- **Port collision detection is racy**: The `port_in_use()` check in `run-live-capture.sh` (lines 73-87) creates a socket and tries to bind. Between the check and actual bridge startup, another process could claim the port. The retry loop helps but does not guarantee success.

- **Task owner correlation relies on task IDs being stable and unique**: `sessionRegistry.ts` correlates subagent task completion to owners via `taskOwners` map keyed by `${sessionId}:${taskId}`. If free-code reuses task IDs across different tasks or sessions, cleanup could be mismatched.

## Technical Debt

- **Excessive field name fallback proliferation in stateMapper.ts**: The `firstString` helper is called with 6-10 alternative field names throughout the file. This pattern masks schema drift instead of fixing it. A schema validation layer would be more robust.

- **Complex notification parsing via regex in `parseNotificationMessage`**: Lines 213-235 use regex patterns like `/^(.+?) needs permission for (.+)$/i` to extract worker names. This is fragile if free-code changes notification message format slightly.

- **Control plane prompt parsing assumes specific XML structure**: `parseTeammatePrompt` (lines 117-132) expects `<teammate-message teammate_id="...">` format. Any whitespace or attribute order change breaks parsing silently.

- **No schema validation on incoming hook payloads**: `asRecord()` simply casts to `Record<string, unknown>`. Malformed or unexpected payload shapes fail silently and may produce incorrect state mappings.

- **Multiple overlapping permission-related field extractions**: `stateMapper.ts` extracts `permissionSuggestionsCount` and `permissionUpdatesCount` in different ways (lines 176-181, 517-521). The logic is duplicated and could diverge.

- **SessionRegistry cleanup logic is complex and tightly coupled**: Methods like `clearTaskOwnersForAgent`, `clearAgentNamesForAgent`, and `renameTaskOwnersForAgent` manipulate three separate maps. This coupling makes it hard to reason about cleanup correctness.

- **No error boundary around Star Office API calls**: If `/set_state`, `/join-agent`, `/agent-push`, or `/leave-agent` returns an error, the bridge logs it but continues. There is no retry, no dead-letter queue, and no alerting.

- **The `shouldLeave` logic in sessionRegistry.ts lines 125-142 has implicit ordering dependencies**: `SubagentStop` and `TaskCompleted` both set `shouldLeave`, but if both arrive, the second one may find already-cleaned state and fail to clean properly.

## Open Questions

- Does free-code emit `SubagentStop` events, or does it use a different event name for subagent termination?

- Does free-code support the `scope` field on payloads to distinguish main vs subagent, or does it rely on `agent_type` or other heuristics?

- Will free-code emit `PreToolUse` for the same tool set the bridge expects (`WebSearch`, `WebFetch`, `Read`, `Glob`, `Grep`, `Edit`, `Write`, `MultiEdit`, `Bash`, `Run`, `Task`)?

- What is the exact format of free-code's team/worker notification messages? The regex patterns in `parseNotificationMessage` assume specific phrasing.

- Does free-code support `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` for the team-notification profile, or does it have its own team implementation?

- Will the interactive notification capture path (`run-interactive-notification-capture.sh`) actually trigger leader-side `Notification` hooks when workers request permissions?

- Does the draft plugin require special installation beyond pointing `CLAUDE_PLUGIN_DIR` at the plugin directory?

- Is there a `stop_hook_active` field in free-code payloads, or is this an official Claude Code-specific field that may be absent?

## Known Limitations

- **The bridge does not persist events**: Raw hook events are written to `tmp/events.ndjson` only when `BRIDGE_DRY_RUN=true` captures to file. In normal mode, events are processed and discarded.

- **No support for concurrent Star Office UI instances**: The bridge assumes a single Star Office UI instance. Multiple dashboards would receive duplicate state updates with undefined behavior.

- **The smoke test only validates isolated cleanup paths**: `scripts/smoke-test.sh` tests `SubagentStop` and `TaskCompleted` cleanup in isolation. It does not test the full lifecycle: `SessionStart` -> `SubagentStart` -> `SubagentStop` -> `SessionEnd`.

- **Zellij session hosting requires manual orchestration**: `scripts/launch-zellij-lab.sh` starts or attaches a session, but the operator must manually coordinate between Zellij and Star Office UI. There is no automatic synchronization.

- **The team-notification profile runs in `-p` (print) mode**: Even when using `LIVE_CAPTURE_PROFILE=team-notification`, the script runs `bun run ... -p "..."` which is non-interactive. The README acknowledges "does not yet validate the interactive pane-backed notification path".

- **Hook envelope forwarding assumes plugin wires correctly**: The draft plugin must forward hook payloads to `BRIDGE_URL` with correct `CLAUDE_STAR_BRIDGE_SECRET`. If the plugin misbehaves or the secret mismatches, the bridge receives nothing and logs no error.

- **Port auto-selection has hardcoded limits**: `MAX_BRIDGE_PORT_ATTEMPTS=8` means at most 8 ports (4317-4324) will be tried. On a heavily loaded system, this may not find a free port.

- **No support for hook replay or event replay**: If the bridge misses events (network blip, restart), Star Office UI state will be permanently out of sync with actual runtime state until a new session starts.
