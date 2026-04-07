# Technology Stack

## Runtime Environment

- **Runtime**: Bun 1.3.11 (specified via `packageManager` in `package.json`)
- **Execution**: `bun run src/index.ts` (dev script)
- **Type Checking**: `bun run typecheck` / `tsc --noEmit`

## Language & Compiler

- **TypeScript**: ^6.0.2
- **Target**: ES2022
- **Module System**: ESNext with Bundler module resolution
- **Type Definitions**: `@types/bun` ^1.3.11
- **Strict Mode**: Enabled (`"strict": true` in tsconfig.json)
- **No Emit**: TypeScript compiles in-memory only (`"noEmit": true`)
- **Skip Lib Check**: Enabled (`"skipLibCheck": true`)

## Project Structure

```
free-code-star-office-zellij-lab/
├── src/
│   ├── index.ts          # Main entry point, Bun.serve HTTP server
│   ├── config.ts         # Environment-based configuration loader
│   ├── starOfficeClient.ts # HTTP client for Star Office API
│   ├── sessionRegistry.ts  # Session state tracking
│   ├── stateMapper.ts   # Claude event to office state normalization
│   └── types.ts          # TypeScript type definitions
├── plugins/
│   └── claude-star-office-bridge/
│       └── .claude-plugin/
│           └── plugin.json  # Claude plugin manifest
└── package.json
```

## Core Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@types/bun` | ^1.3.11 | Bun runtime type definitions |
| `typescript` | ^6.0.2 | TypeScript compiler |

## HTTP Server Architecture

**Server Implementation**: Native Bun.serve (no express/fastify)

```typescript
// src/index.ts:124-225
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: async (request: Request): Promise<Response> => { ... }
});
```

**Server Endpoints**:
| Method | Path | Handler |
|--------|------|---------|
| GET | `/health` | Health check with config status |
| GET | `/sessions` | List active sessions |
| POST | `/hook/claude` | Claude hook event receiver |
| POST | `/event/manual` | Manual event injection |

## Configuration System

**Source**: `src/config.ts`

Environment variables with fallbacks:
| Variable | Default | Purpose |
|----------|---------|---------|
| `BRIDGE_HOST` | `127.0.0.1` | Server bind address |
| `BRIDGE_PORT` | `4317` | Server port |
| `BRIDGE_SECRET` | `undefined` | Request authorization secret |
| `BRIDGE_DRY_RUN` | `true` | Skip Star Office API calls |
| `BRIDGE_EVENTS_LOG_PATH` | `tmp/events.ndjson` | Event log file path |
| `STAR_OFFICE_URL` | `undefined` | Star Office API base URL |
| `STAR_OFFICE_JOIN_KEY` | `undefined` | Agent join authentication key |
| `STAR_OFFICE_MAIN_AGENT_NAME` | `free-code` | Main agent identifier |

## Session Management

**Component**: `SessionRegistry` (imported from sessionRegistry module)

- Tracks active sessions and their signals
- Provides snapshot of current session state
- Supports listing all active sessions via `GET /sessions`

## State Mapping

**Component**: `stateMapper.ts` - `normalizeClaudeEvent()`

- Transforms Claude bridge events into `NormalizedSignal` format
- Maps event names to office state representations
- Returns `null` for events that do not map to office state

## Type System

**Source**: `src/types.ts`

Key types:
- `BridgeConfig` - Configuration interface
- `NormalizedSignal` - Normalized signal for session/agent/state
- `ClaudeBridgeEvent` - Raw Claude hook event structure
- `BridgeEventLogEntry` - Structured event log record
- `BridgeErrorInfo` - Error formatting helper

## Event Logging

- **Format**: NDJSON (newline-delimited JSON)
- **Path**: Configurable via `BRIDGE_EVENTS_LOG_PATH`
- **Directory Creation**: Automatic with `recursive: true`
- **Fields Logged**: source, receivedAt, rawEvent, signal, originalSignal, starOfficeResult, starOfficeError, ignored, ignoreReason, rawBody
