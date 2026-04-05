import type {
  ClaudeBridgeEvent,
  NormalizedSignal,
  OfficeState,
  SignalContext,
} from "./types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function firstString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function extractToolName(payload: UnknownRecord): string | undefined {
  const nestedTool = asRecord(payload.tool);
  return firstString(payload, ["tool_name", "toolName", "tool"]) ||
    firstString(nestedTool, ["name", "tool_name", "toolName"]);
}

function deriveSessionId(payload: UnknownRecord): string {
  return (
    firstString(payload, ["session_id", "sessionId", "conversation_id", "request_id"]) ||
    firstString(payload, ["transcript_path", "transcriptPath"]) ||
    firstString(payload, ["cwd"]) ||
    "default-session"
  );
}

function deriveScope(payload: UnknownRecord, eventName: string): "main" | "subagent" {
  if (eventName.startsWith("Subagent")) {
    return "subagent";
  }
  const explicit = firstString(payload, ["subagent_name", "subagentName"]);
  return explicit ? "subagent" : "main";
}

function deriveAgentName(
  payload: UnknownRecord,
  scope: "main" | "subagent",
): string {
  if (scope === "main") {
    return "main";
  }
  return (
    firstString(payload, ["subagent_name", "subagentName", "agent_name", "agentName", "name"]) ||
    "subagent"
  );
}

function mapToolNameToState(toolName?: string): OfficeState {
  const normalized = (toolName || "").toLowerCase();
  if (["websearch", "webfetch", "read", "glob", "grep", "find"].includes(normalized)) {
    return "researching";
  }
  if (["edit", "write", "multiedit"].includes(normalized)) {
    return "writing";
  }
  if (["bash", "run", "task"].includes(normalized)) {
    return "executing";
  }
  return "executing";
}

function buildDetail(eventName: string, toolName: string | undefined, payload: UnknownRecord): string {
  const explicit = firstString(payload, [
    "detail",
    "description",
    "reason",
    "message",
    "summary",
    "prompt",
  ]);

  if (explicit) {
    return explicit;
  }
  if (toolName) {
    return `${eventName} ${toolName}`;
  }
  return eventName;
}

function mapEventToState(eventName: string, toolName: string | undefined): OfficeState | null {
  switch (eventName) {
    case "PreToolUse":
      return mapToolNameToState(toolName);
    case "PostToolUseFailure":
    case "PermissionDenied":
    case "StopFailure":
      return "error";
    case "PermissionRequest":
      return "executing";
    case "TaskCompleted":
    case "Stop":
    case "SubagentStop":
      return "idle";
    case "SubagentStart":
      return "executing";
    default:
      return null;
  }
}

export function normalizeClaudeEvent(event: ClaudeBridgeEvent): NormalizedSignal | null {
  const payload = asRecord(event.payload);
  const toolName = extractToolName(payload);
  const state = mapEventToState(event.event_name, toolName);

  if (!state) {
    return null;
  }

  const scope = deriveScope(payload, event.event_name);
  const context: SignalContext = {
    cwd: firstString(payload, ["cwd"]),
    transcriptPath: firstString(payload, ["transcript_path", "transcriptPath"]),
    rawToolName: toolName,
  };

  return {
    sessionId: deriveSessionId(payload),
    agentName: deriveAgentName(payload, scope),
    scope,
    state,
    detail: buildDetail(event.event_name, toolName, payload),
    eventName: event.event_name,
    shouldLeave: event.event_name === "SubagentStop",
    context,
  };
}
