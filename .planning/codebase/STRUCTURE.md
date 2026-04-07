# Project Structure

## Directory Layout

```
/root/workspace/
├── src/
│   ├── index.ts            # HTTP bridge server entry point
│   ├── stateMapper.ts      # Event normalization and state mapping
│   ├── sessionRegistry.ts  # In-memory session state management
│   ├── starOfficeClient.ts # Star Office UI HTTP client
│   ├── config.ts           # Configuration loader from environment
│   └── types.ts            # TypeScript type definitions
├── scripts/
│   ├── launch-zellij-lab.sh # Start/attach Zellij session
│   ├── smoke-test.sh       # Bridge integration test
│   ├── run-live-capture.sh  # Capture real hook events
│   └── run-interactive-notification-capture.sh
├── plugins/
│   └── claude-star-office-bridge/  # Draft Claude plugin
├── docs/
│   ├── architecture.md     # Architecture documentation
│   └── fast-track-plan.md  # Implementation plan
├── .planning/
│   └── codebase/           # This document and ARCHITECTURE.md
└── tmp/                    # Runtime artifacts (events log)
```

## Source Files

### `src/index.ts` (229 lines)
HTTP bridge server using Bun.serve()
- Entry point that loads config and initializes registry/client
- Routes: `/health`, `/sessions`, `/hook/claude`, `/event/manual`
- Authorization check via `x-bridge-secret` header
- Event normalization via `normalizeClaudeEvent()`
- Session recording via `registry.record()`
- Star Office apply via `starOfficeClient.apply()`
- Event logging to NDJSON file

### `src/stateMapper.ts` (539 lines)
Converts Claude hook events to normalized signals
- `normalizeClaudeEvent()` - main entry point
- Helper functions:
  - `asRecord()` - safe object cast
  - `firstString()` / `firstBoolean()` / `firstTimestamp()` - multi-key extraction
  - `extractToolName()` - nested tool name extraction
  - `extractWorktreePath()` / `extractWorktreeBranch()` - worktree info
  - `parseTeammatePrompt()` - control plane XML parsing
  - `parseControlPlanePrompt()` - JSON control plane parsing
  - `parseDirectControlPlaneEvent()` - direct permission events
  - `parseNotificationMessage()` - notification string parsing
- `deriveSessionId()` - session ID from various payload fields
- `deriveScope()` - main vs subagent from event name and payload
- `deriveAgentName()` - agent name resolution
- `mapToolNameToState()` - tool name to office state
- `buildDetail()` - human-readable detail from payload
- `mapEventToState()` - event type to office state

### `src/sessionRegistry.ts` (182 lines)
In-memory session and agent state registry
- `SessionRegistry` class with Map-based storage
- Key methods:
  - `record()` - record signal, return snapshot
  - `list()` - all sessions sorted by updatedAt
- Internal methods:
  - `rememberAgentIdentity()` - track agentId -> agentName
  - `resolveSignal()` - handle TaskCreated/Completed correlation
  - `resetSession()` - clear session state
- Cleanup on SubagentStop and scope=main transitions

### `src/starOfficeClient.ts` (108 lines)
HTTP client for Star Office UI backend
- `StarOfficeClient` class
- `apply()` - main entry, routes to appropriate endpoint
- `ensureJoined()` - register subagent, return agentId
- `post()` - HTTP fetch with JSON handling
- Endpoints:
  - `/set_state` - main agent state
  - `/join-agent` - subagent registration
  - `/agent-push` - subagent state update
  - `/leave-agent` - subagent departure
- Dry-run mode when no baseUrl or dryRun=true

### `src/config.ts`
Configuration loader from environment variables:
- `host`, `port` - server binding
- `secret` - authorization secret
- `dryRun` - skip Star Office calls
- `eventsLogPath` - event log file path
- `starOfficeUrl` - Star Office backend URL
- `starOfficeJoinKey` - agent join key
- `mainAgentName` - main agent identifier

### `src/types.ts` (110 lines)
TypeScript type definitions:
- `OfficeState` - union type: idle | writing | researching | executing | syncing | error
- `AgentScope` - "main" | "subagent"
- `ClaudeBridgeEvent` - incoming hook event structure
- `SignalContext` - 40+ context fields from event payload
- `NormalizedSignal` - normalized signal after stateMapper
- `SessionSnapshot` - current state of a session
- `BridgeErrorInfo` - error message and stack
- `BridgeEventLogEntry` - event log entry structure
- `BridgeConfig` - configuration interface

## Scripts

### `scripts/launch-zellij-lab.sh`
Starts or attaches Zellij session for the operator

### `scripts/smoke-test.sh`
Integration test that:
- Boots isolated temporary bridge
- Validates subagent cleanup paths
- Tests SubagentStop handling
- Tests task-owner-correlated TaskCompleted

### `scripts/run-live-capture.sh`
Live event capture:
- Starts bridge in dry-run mode
- Wires draft plugin into local runtime
- Writes captured raw events to `tmp/events.ndjson`
- Defaults to `-p` run with `--permission-mode bypassPermissions`
- Auto-picks first free bridge port starting at 4317

### `scripts/run-interactive-notification-capture.sh`
Interactive capture for worker approval events:
- Same bridge/plugin wiring as live-capture
- Launches interactive leader session
- Used for team creation and permission notification testing

## Plugins

### `plugins/claude-star-office-bridge/`
Draft Claude plugin that forwards hook payloads to the bridge
- See plugins/claude-star-office-bridge/README.md for details

## Documentation

### `docs/architecture.md`
Architecture overview including:
- System shape diagram
- Repo roles
- Event mapping table
- Why this boundary

### `docs/fast-track-plan.md`
Implementation plan and quick start guide

## Output Directory

### `.planning/codebase/`
Contains:
- `ARCHITECTURE.md` - This document (high-level architecture and data flow)
- `STRUCTURE.md` - This document (directory/file structure)

### `tmp/`
Runtime directory for:
- `events.ndjson` - Captured hook events
