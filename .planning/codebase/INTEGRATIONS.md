# External Integrations

## Star Office UI API

**Integration Type**: HTTP REST API client
**Component**: `src/starOfficeClient.ts` - `StarOfficeClient` class

### Configuration

```typescript
// src/starOfficeClient.ts:17-21
constructor(config: BridgeConfig) {
  this.baseUrl = config.starOfficeUrl;
  this.joinKey = config.starOfficeJoinKey;
  this.dryRun = config.dryRun;
}
```

### API Endpoints

| Endpoint | Purpose | Method |
|----------|---------|--------|
| `/join-agent` | Register agent with Star Office | POST |
| `/set_state` | Update main agent state | POST |
| `/leave-agent` | Deregister agent | POST |
| `/agent-push` | Push state update for subagent | POST |

### Request Flow

**Main Agent State Update** (`signal.scope === "main"`):
```typescript
// src/starOfficeClient.ts:79-85
async apply(signal: NormalizedSignal): Promise<unknown> {
  if (signal.scope === "main") {
    return this.post("/set_state", {
      state: signal.state,
      detail: signal.detail,
    });
  }
  // ...
}
```

**Subagent Operations**:
1. Check if agent already joined via `agentIds` Map
2. If not, call `/join-agent` to get `agentId`
3. For state updates, call `/agent-push`
4. For leave events, call `/leave-agent`

**Join Request Structure**:
```typescript
// src/starOfficeClient.ts:66-71
const joinResponse = await this.post("/join-agent", {
  name: signal.agentName,
  joinKey: this.joinKey || "dry-run-join-key",
  state: signal.state,
  detail: signal.detail,
});
```

### Dry Run Mode

When `BRIDGE_DRY_RUN=true` or `STAR_OFFICE_URL` is undefined:
- All Star Office API calls return mock response: `{ dryRun: true, path, body }`
- No actual HTTP requests are made
- Default dry run is `true` (from config)

### Authorization

- `STAR_OFFICE_JOIN_KEY` required for subagent sync (throws if missing in non-dry-run)
- Agent IDs stored in Map keyed by `sessionId:agentName`

## Claude Hook Events

**Endpoint**: `POST /hook/claude`

### Event Format

```typescript
// src/index.ts:153-156
let body: ClaudeBridgeEvent;
try {
  body = JSON.parse(rawBody) as ClaudeBridgeEvent;
}
// Required field: event_name (string, non-empty)
```

### Processing Pipeline

1. Parse raw JSON body
2. Validate `event_name` field exists and is non-empty string
3. Normalize event via `normalizeClaudeEvent()` from `stateMapper.ts`
4. If normalization returns null, event is ignored (no office state mapping)
5. Process signal through `processSignal()`:
   - Record in SessionRegistry
   - Apply to Star Office via `starOfficeClient.apply()`
   - Append to event log

### Ignored Events

Events are ignored and logged with reason for:
- Invalid JSON (`invalid json`)
- Missing `event_name` (`missing event_name`)
- No office state mapping (`event did not map to an office state`)

## Manual Event Injection

**Endpoint**: `POST /event/manual`

### Request Body

```typescript
// src/index.ts:187-204
{
  sessionId?: string;        // defaults to "manual-session"
  agentName?: string;        // defaults to "main"
  scope?: "main" | "subagent";
  state: NormalizedSignal["state"];  // required
  detail?: string;          // defaults to state value
  shouldLeave?: boolean;
}
```

### Use Case

Allows external tools or scripts to inject state changes directly without Claude hook.

## Health Check

**Endpoint**: `GET /health`

### Response

```typescript
// src/index.ts:134-142
{
  ok: true,
  host: config.host,
  port: config.port,
  dryRun: config.dryRun,
  starOfficeUrl: config.starOfficeUrl || null,
}
```

## Session Registry

**Endpoint**: `GET /sessions`

### Response

```typescript
// src/index.ts:145-148
{
  ok: true,
  sessions: registry.list(),
}
```

Lists all active sessions tracked by SessionRegistry.

## Authorization

**Mechanism**: `x-bridge-secret` header comparison

```typescript
// src/index.ts:71-76
function isAuthorized(request: Request): boolean {
  if (!config.secret) {
    return true;  // No auth required if secret not set
  }
  return request.headers.get("x-bridge-secret") === config.secret;
}
```

- GET requests to `/health` and `/sessions` bypass authorization
- All POST endpoints require authorization when `BRIDGE_SECRET` is set

## Claude Plugin Integration

**Manifest**: `plugins/claude-star-office-bridge/.claude-plugin/plugin.json`

```json
{
  "name": "claude-star-office-bridge",
  "version": "0.1.0",
  "description": "Draft plugin that forwards Claude hook events to a local Star Office bridge service",
  "author": {
    "name": "Karl Chow Lab",
    "email": "local-only@example.invalid"
  }
}
```

**Purpose**: Enables Claude to send hook events to this bridge service via standard Claude hook mechanisms.

## Event Logging

All events (processed and ignored) are logged to NDJSON file:
- Path: configured via `BRIDGE_EVENTS_LOG_PATH`
- Both successful and failed Star Office calls are logged
- Includes timing, raw event data, transformed signal, and API results
