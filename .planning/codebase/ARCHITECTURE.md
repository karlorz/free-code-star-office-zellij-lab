# Architecture

## System Overview

The Claude Star Office Bridge is a local HTTP service that bridges Claude Code hook events to Star Office UI state updates. It maintains in-memory session state and forwards normalized signals to a Star Office backend.

## Core Components

### HTTP Bridge Server (`src/index.ts`)
- Bun-based HTTP server listening on configurable host/port
- Accepts Claude hook events via `POST /hook/claude`
- Accepts manual events via `POST /event/manual`
- Provides observability endpoints:
  - `GET /health` - Server health and configuration
  - `GET /sessions` - Current session registry snapshot
- Supports optional secret-based authorization via `x-bridge-secret` header

### State Mapper (`src/stateMapper.ts`)
- Converts raw Claude hook events into normalized `NormalizedSignal` objects
- Maps event types to office states:
  - `PreToolUse` for `WebSearch`, `WebFetch`, `Read`, `Glob`, `Grep` -> `researching`
  - `PreToolUse` for `Edit`, `Write`, `MultiEdit` -> `writing`
  - `PreToolUse` for `Bash`, `Run`, `Task` -> `executing`
  - `PostToolUseFailure`, `PermissionDenied`, `StopFailure` -> `error`
  - `TaskCompleted`, `Stop`, `SubagentStop`, `TeammateIdle` -> `idle`
- Extracts context from various payload formats (handles multiple field naming conventions)
- Parses control plane messages embedded in prompts

### Session Registry (`src/sessionRegistry.ts`)
- In-memory store of active sessions and their agent states
- Maintains `SessionSnapshot` per session containing:
  - Main agent signal
  - Subagent signals keyed by agent name
  - Working directory and transcript paths
- Tracks task ownership for subagent correlation
- Resolves agent identity across multiple event payloads
- Cleans up agent state on `shouldLeave` signals

### Star Office Client (`src/starOfficeClient.ts`)
- HTTP client to Star Office UI backend
- Endpoints used:
  - `POST /set_state` - Main agent state updates
  - `POST /join-agent` - Subagent registration
  - `POST /agent-push` - Subagent state updates
  - `POST /leave-agent` - Subagent departure
- Maintains agent ID mapping per session/agent combination
- Supports dry-run mode for testing without backend

## Request/Response Flow

```
Claude Runtime
    |
    | Hook events (PreToolUse, PostToolUse, Stop, etc.)
    v
POST /hook/claude
    |
    v
index.ts fetch handler
    |
    | Validate JSON, check authorization
    v
normalizeClaudeEvent() [stateMapper.ts]
    |
    | Returns NormalizedSignal or null
    v
SessionRegistry.record()
    |
    | Update in-memory session state
    | Returns snapshot + resolved signal
    v
StarOfficeClient.apply()
    |
    | POST to Star Office API
    | /set_state (main) or /join-agent/agent-push/leave-agent (subagent)
    v
Star Office UI
```

## Session Registry Data Flow

```
Incoming NormalizedSignal
    |
    | rememberAgentIdentity()
    | Track agentId -> agentName mapping
    v
    |
    | resolveSignal()
    | - Handle TaskCreated: record task owner
    | - Handle TaskCompleted: correlate with task owner, set shouldLeave
    | - Handle shouldLeave: cleanup agent state
    v
    |
    | record() - update session snapshot
    | - main scope -> update existing.main
    | - subagent shouldLeave -> delete from agents
    | - subagent active -> update existing.agents[agentName]
    v
SessionSnapshot stored in Map
```

## Event Processing

### ClaudeBridgeEvent Structure
```typescript
{
  source: string,           // "claude-hook" or "manual"
  event_name: string,       // Event type (PreToolUse, Stop, etc.)
  payload?: Record<string, unknown>,
  received_at?: string
}
```

### NormalizedSignal Structure
```typescript
{
  sessionId: string,
  agentName: string,
  scope: "main" | "subagent",
  state: OfficeState,       // idle | writing | researching | executing | syncing | error
  detail: string,
  eventName: string,
  shouldLeave?: boolean,
  context: SignalContext    // 40+ context fields
}
```

## Office State Machine

```
States: idle | writing | researching | executing | syncing | error

Transitions triggered by:
- PreToolUse (tool-specific) -> researching | writing | executing
- PostToolUseFailure -> error
- PermissionDenied -> error
- StopFailure -> error
- TaskCompleted -> idle
- Stop -> idle
- SubagentStop -> idle
- TeammateIdle -> idle
- ConfigChange, InstructionsLoaded, etc. -> syncing
```

## Authorization

- If `secret` is configured in environment, requests must include `x-bridge-secret: <secret>` header
- GET /health endpoint always accessible (for monitoring)
- All mutating endpoints require authorization when secret is set

## Event Logging

All events are appended to `config.eventsLogPath` (default: `tmp/events.ndjson`) as JSON lines:
- `source`, `receivedAt`, `rawEvent`, `signal`, `originalSignal`
- `starOfficeResult`, `starOfficeError`
- `ignored`, `ignoreReason`, `rawBody`

Ignored events include: invalid JSON, missing event_name, events that don't map to an office state.
