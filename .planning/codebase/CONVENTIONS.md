# Coding Conventions

## TypeScript Type Conventions

### Import Style
- Use `import type` for type-only imports to enable tree-shaking
- Use `import` with `type` modifier for inline type imports

```typescript
import type {
  ClaudeBridgeEvent,
  NormalizedSignal,
  OfficeState,
  SignalContext,
} from "./types";
```

### Type Definitions
- Use `type` for union types and simple aliases
- Use `interface` for object shapes that may be extended

```typescript
// Union type
export type OfficeState =
  | "idle"
  | "writing"
  | "researching"
  | "executing"
  | "syncing"
  | "error";

// Object interface
export interface SignalContext {
  cwd?: string;
  transcriptPath?: string;
  // ... optional fields with ?
  agentId?: string;
  agentType?: string;
}
```

### Generic Object Types
- Use `Record<string, unknown>` for loosely typed record objects
- Never use `any` type

```typescript
type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}
```

## Naming Conventions

### PascalCase
- Type names: `OfficeState`, `NormalizedSignal`, `SessionSnapshot`
- Interface names: `SignalContext`, `BridgeConfig`
- Event name strings: `"SessionStart"`, `"PreToolUse"`, `"TaskCompleted"`

### camelCase
- Variable names: `sessionId`, `agentName`, `toolName`
- Function names: `normalizeClaudeEvent`, `firstString`, `asRecord`
- Method names: `record()`, `list()`, `apply()`

### SCREAMING_SNAKE_CASE
- Environment variables: `BRIDGE_HOST`, `BRIDGE_PORT`, `BRIDGE_SECRET`
- Config fields that map directly from env vars

### snake_case / camelCase Variants
Payload fields commonly support both `snake_case` and `camelCase` for compatibility:
```typescript
firstString(payload, ["session_id", "sessionId", "conversation_id", "request_id"])
```

## Bun-Specific Patterns

### Bun.serve for HTTP Server
```typescript
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: async (request: Request): Promise<Response> => {
    // Handle requests
  },
});
```

### Node.js Built-in Imports
- Use `node:` prefix for built-in modules
- Use async/await with `node:fs/promises`

```typescript
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
```

### ES Modules
- Package uses `"type": "module"` in package.json
- All imports use ES module syntax
- Use `.ts` extension in imports (Bun resolves this)

## Event Normalization Patterns

### Core Normalization Function
`normalizeClaudeEvent` in `stateMapper.ts` is the central transformation function:
```typescript
export function normalizeClaudeEvent(event: ClaudeBridgeEvent): NormalizedSignal | null
```

### Payload Extraction Pattern
Use helper functions to safely extract and normalize field values:
```typescript
function asRecord(value: unknown): UnknownRecord { ... }
function firstString(record: UnknownRecord, keys: string[]): string | undefined { ... }
function firstBoolean(record: UnknownRecord, keys: string[]): boolean | undefined { ... }
function firstTimestamp(record: UnknownRecord, keys: string[]): string | undefined { ... }
```

### Nested Object Extraction
Extract nested objects safely before accessing their fields:
```typescript
function extractToolName(payload: UnknownRecord): string | undefined {
  const nestedTool = asRecord(payload.tool);
  return firstString(payload, ["tool_name", "toolName", "tool"]) ||
    firstString(nestedTool, ["name", "tool_name", "toolName"]);
}
```

### Switch-Based Event Mapping
```typescript
function mapEventToState(
  eventName: string,
  toolName: string | undefined,
  detail: string,
): OfficeState | null {
  switch (eventName) {
    case "SessionStart":
    case "SessionEnd":
    case "TaskCompleted":
      return "idle";
    case "PreToolUse":
    case "PostToolUse":
      return mapToolNameToState(toolName);
    // ...
  }
}
```

## Session and Signal Type Structures

### ClaudeBridgeEvent (Input)
Raw incoming event from hooks:
```typescript
interface ClaudeBridgeEvent {
  source: string;
  event_name: string;
  payload?: Record<string, unknown> | null;
  received_at?: string;
}
```

### NormalizedSignal (Output)
Normalized signal for internal processing:
```typescript
interface NormalizedSignal {
  sessionId: string;
  agentName: string;
  scope: AgentScope;  // "main" | "subagent"
  state: OfficeState;  // "idle" | "writing" | "researching" | "executing" | "syncing" | "error"
  detail: string;
  eventName: string;
  shouldLeave?: boolean;
  context: SignalContext;
}
```

### SignalContext (Metadata)
Rich context object containing extracted metadata:
```typescript
interface SignalContext {
  cwd?: string;
  transcriptPath?: string;
  agentTranscriptPath?: string;
  rawToolName?: string;
  agentId?: string;
  agentType?: string;
  taskId?: string;
  taskStatus?: string;
  taskSummary?: string;
  outputFilePath?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  teamName?: string;
  teammateName?: string;
  teammateSummary?: string;
  parentSessionId?: string;
  notificationType?: string;
  notificationTitle?: string;
  notificationMessage?: string;
  // ... controlPlane fields for teammate messaging
  controlPlaneType?: string;
  controlPlaneSubtype?: string;
  controlPlaneRequestId?: string;
  // ...
}
```

### SessionSnapshot (State View)
```typescript
interface SessionSnapshot {
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
  updatedAt: string;
  main?: NormalizedSignal;
  agents: Record<string, NormalizedSignal>;
}
```

## Code Patterns

### Guard Clauses with Early Returns
```typescript
function parseTeammatePrompt(prompt: string | undefined): TeammatePromptMessage | null {
  if (!prompt || !prompt.includes("<teammate-message")) {
    return null;
  }
  // ...
}
```

### Fallback Chains
```typescript
function deriveSessionId(payload: UnknownRecord): string {
  return (
    firstString(payload, ["session_id", "sessionId", "conversation_id", "request_id"]) ||
    firstString(payload, ["transcript_path", "transcriptPath"]) ||
    firstString(payload, ["cwd"]) ||
    "default-session"
  );
}
```

### Error Formatting
```typescript
function formatError(error: unknown): BridgeErrorInfo {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}
```

### JSON Response Helper
```typescript
function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers || {}),
    },
  });
}
```

### Configuration Pattern
Environment variables with fallbacks and type coercion in `config.ts`:
```typescript
function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadConfig(): BridgeConfig {
  return {
    host: process.env.BRIDGE_HOST || "127.0.0.1",
    port: Number(process.env.BRIDGE_PORT || "4317"),
    dryRun: readBoolean(process.env.BRIDGE_DRY_RUN, true),
    // ...
  };
}
```

## Class Patterns

### Service Classes with Dependency Injection
```typescript
export class StarOfficeClient {
  private readonly baseUrl?: string;
  private readonly joinKey?: string;
  private readonly dryRun: boolean;
  private readonly agentIds = new Map<string, string>();

  constructor(config: BridgeConfig) {
    this.baseUrl = config.starOfficeUrl;
    this.joinKey = config.starOfficeJoinKey;
    this.dryRun = config.dryRun;
  }
}
```

### Registry Pattern for Session State
```typescript
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly taskOwners = new Map<string, string>();
  private readonly agentNamesById = new Map<string, string>();

  record(signal: NormalizedSignal): { snapshot: SessionSnapshot; signal: NormalizedSignal } {
    // ... records and returns
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].sort((a, b) => {
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }
}
```
