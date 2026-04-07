import type {
  ClaudeBridgeEvent,
  NormalizedSignal,
  OfficeState,
  SignalContext,
} from "./types";

type UnknownRecord = Record<string, unknown>;

type ControlPlaneMessage = {
  type: string;
  subtype?: string;
  requestId?: string;
  from?: string;
  agentId?: string;
  toolName?: string;
  toolUseId?: string;
  description?: string;
  approved?: boolean;
  allow?: boolean;
  reason?: string;
  feedback?: string;
  error?: string;
  host?: string;
  planFilePath?: string;
  timestamp?: string;
  permissionSuggestionsCount?: number;
  permissionUpdatesCount?: number;
};

type TeammatePromptMessage = {
  teammateName?: string;
  summary?: string;
  content: string;
};

type ParsedControlPlanePrompt = {
  controlPlane: ControlPlaneMessage;
  teammateName?: string;
  teammateSummary?: string;
};

type ParsedNotificationMessage = {
  workerName?: string;
  toolName?: string;
  host?: string;
};

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

function firstBoolean(record: UnknownRecord, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function firstTimestamp(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function lastPathStem(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replaceAll("\\", "/");
  const segment = normalized.split("/").filter(Boolean).pop();
  if (!segment) {
    return undefined;
  }
  const stem = segment.replace(/\.[^/.]+$/, "").trim();
  return stem || undefined;
}

function extractToolName(payload: UnknownRecord): string | undefined {
  const nestedTool = asRecord(payload.tool);
  return firstString(payload, ["tool_name", "toolName", "tool"]) ||
    firstString(nestedTool, ["name", "tool_name", "toolName"]);
}

function extractWorktreePath(payload: UnknownRecord): string | undefined {
  const nestedWorktree = asRecord(payload.worktree);
  return firstString(payload, ["worktree_path", "worktreePath"]) ||
    firstString(nestedWorktree, ["path", "worktree_path", "worktreePath"]);
}

function extractWorktreeBranch(payload: UnknownRecord): string | undefined {
  const nestedWorktree = asRecord(payload.worktree);
  return firstString(payload, ["worktree_branch", "worktreeBranch"]) ||
    firstString(nestedWorktree, ["branch", "worktree_branch", "worktreeBranch"]);
}

function parseTeammatePrompt(prompt: string | undefined): TeammatePromptMessage | null {
  if (!prompt || !prompt.includes("<teammate-message")) {
    return null;
  }

  const match = prompt.match(/<teammate-message\s+teammate_id="([^"]+)"(?:\s+color="([^"]+)")?(?:\s+summary="([^"]+)")?>\n?([\s\S]*?)\n?<\/teammate-message>/);
  if (!match || !match[4]) {
    return null;
  }

  return {
    teammateName: match[1]?.trim() || undefined,
    summary: match[3]?.trim() || undefined,
    content: match[4].trim(),
  };
}

function parseControlPlanePrompt(prompt: string | undefined): ParsedControlPlanePrompt | null {
  const teammatePrompt = parseTeammatePrompt(prompt);
  if (!teammatePrompt) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(teammatePrompt.content);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  const response = asRecord(record.response);
  const hostPattern = asRecord(record.hostPattern);
  const type = firstString(record, ["type"]);
  if (!type) {
    return null;
  }

  const approve = firstBoolean(record, ["approve", "approved"]);
  return {
    teammateName: teammatePrompt.teammateName,
    teammateSummary: teammatePrompt.summary,
    controlPlane: {
      type,
      subtype: firstString(record, ["subtype"]),
      requestId: firstString(record, ["requestId", "request_id"]),
      from: firstString(record, ["from", "workerName", "worker_name"]),
      agentId: firstString(record, ["agentId", "agent_id", "workerId", "worker_id"]),
      toolName: firstString(record, ["toolName", "tool_name"]),
      toolUseId: firstString(record, ["toolUseId", "tool_use_id"]),
      description: firstString(record, ["description"]),
      approved: approve,
      allow: firstBoolean(record, ["allow"]),
      reason: firstString(record, ["reason"]),
      feedback: firstString(record, ["feedback"]),
      error: firstString(record, ["error"]),
      host: firstString(hostPattern, ["host"]) || firstString(record, ["host"]),
      planFilePath: firstString(record, ["planFilePath", "plan_file_path"]),
      timestamp: firstTimestamp(record, ["timestamp", "createdAt", "created_at"]),
      permissionSuggestionsCount: Array.isArray(record.permission_suggestions)
        ? record.permission_suggestions.length
        : undefined,
      permissionUpdatesCount: Array.isArray(response.permission_updates)
        ? response.permission_updates.length
        : undefined,
    },
  };
}

function parseControlPlaneMessage(prompt: string | undefined): ControlPlaneMessage | null {
  return parseControlPlanePrompt(prompt)?.controlPlane || null;
}

function parseDirectControlPlaneEvent(eventName: string, payload: UnknownRecord): ControlPlaneMessage | null {
  switch (eventName) {
    case "PermissionRequest":
      return {
        type: eventName,
        requestId: firstString(payload, ["request_id", "requestId"]),
        from: firstString(payload, ["teammate_name", "teammateName", "agent_name", "agentName"]),
        agentId: firstString(payload, ["agent_id", "agentId"]),
        toolName: extractToolName(payload),
        toolUseId: firstString(payload, ["tool_use_id", "toolUseId"]),
        description: firstString(payload, ["description", "message"]),
      };
    case "PermissionDenied":
      return {
        type: eventName,
        requestId: firstString(payload, ["request_id", "requestId"]),
        error: firstString(payload, ["error", "message", "reason"]),
      };
    default:
      return null;
  }
}

function parseNotificationMessage(message: string | undefined): ParsedNotificationMessage | null {
  if (!message) {
    return null;
  }

  const permissionMatch = message.match(/^(.+?) needs permission for (.+)$/i);
  if (permissionMatch) {
    return {
      workerName: permissionMatch[1]?.trim() || undefined,
      toolName: permissionMatch[2]?.trim() || undefined,
    };
  }

  const networkMatch = message.match(/^(.+?) needs network access to (.+)$/i);
  if (networkMatch) {
    return {
      workerName: networkMatch[1]?.trim() || undefined,
      host: networkMatch[2]?.trim() || undefined,
    };
  }

  return null;
}

function buildControlPlaneDetail(controlPlane: ControlPlaneMessage, teammateSummary?: string): string {
  switch (controlPlane.type) {
    case "shutdown_request":
      return `[Shutdown Request from ${controlPlane.from || "unknown"}]${controlPlane.reason ? ` ${controlPlane.reason}` : ""}`;
    case "shutdown_approved":
      return `[Shutdown Approved] ${controlPlane.from || "unknown"} is now exiting`;
    case "shutdown_rejected":
      return `[Shutdown Rejected] ${controlPlane.from || "unknown"}: ${controlPlane.reason || "No reason provided"}`;
    case "plan_approval_request":
      return `[Plan Approval Request from ${controlPlane.from || "unknown"}]`;
    case "plan_approval_response":
      if (controlPlane.approved) {
        return "[Plan Approved] You can now proceed with implementation";
      }
      return `[Plan Rejected] ${controlPlane.feedback || "Please revise your plan"}`;
    case "permission_request":
    case "PermissionRequest":
      return `[Permission Request] ${controlPlane.toolName || "unknown tool"}${controlPlane.description ? ` — ${controlPlane.description}` : ""}`;
    case "permission_response":
      if (controlPlane.subtype === "success") {
        return `[Permission Approved] ${controlPlane.requestId || "unknown request"}`;
      }
      return `[Permission Denied] ${controlPlane.error || "Permission denied"}`;
    case "PermissionDenied":
      return `[Permission Denied] ${controlPlane.error || "Permission denied"}`;
    case "sandbox_permission_request":
      return `[Sandbox Permission Request] ${controlPlane.host || "unknown host"}`;
    case "sandbox_permission_response":
      if (controlPlane.allow) {
        return `[Sandbox Permission Approved] ${controlPlane.host || "unknown host"}`;
      }
      return `[Sandbox Permission Denied] ${controlPlane.host || "unknown host"}`;
    default:
      return teammateSummary || controlPlane.type;
  }
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
  const explicitScope = firstString(payload, ["scope"]);
  if (explicitScope === "subagent") {
    return "subagent";
  }

  const agentType = firstString(payload, ["agent_type", "agentType"]);
  if (agentType === "subagent" || agentType === "agent") {
    return "subagent";
  }

  const explicitIdentity = firstString(payload, [
    "subagent_name",
    "subagentName",
    "teammate_name",
    "teammateName",
    "agent_id",
    "agentId",
    "agent_transcript_path",
    "agentTranscriptPath",
  ]);
  return explicitIdentity ? "subagent" : "main";
}

function deriveAgentName(
  payload: UnknownRecord,
  scope: "main" | "subagent",
): string {
  if (scope === "main") {
    return "main";
  }
  const directName = firstString(payload, [
    "subagent_name",
    "subagentName",
    "agent_name",
    "agentName",
    "teammate_name",
    "teammateName",
    "name",
    "agent_id",
    "agentId",
  ]);
  if (directName) {
    return directName;
  }

  const transcriptDerived = lastPathStem(
    firstString(payload, ["agent_transcript_path", "agentTranscriptPath"]),
  );
  if (transcriptDerived) {
    return transcriptDerived;
  }

  return "subagent";
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
  const controlPlanePrompt = eventName === "UserPromptSubmit"
    ? parseControlPlanePrompt(firstString(payload, ["prompt"]))
    : null;
  const directControlPlane = parseDirectControlPlaneEvent(eventName, payload);

  if (controlPlanePrompt) {
    return buildControlPlaneDetail(controlPlanePrompt.controlPlane, controlPlanePrompt.teammateSummary);
  }
  if (directControlPlane) {
    return buildControlPlaneDetail(directControlPlane);
  }

  const explicit = firstString(payload, [
    "detail",
    "task_subject",
    "task_description",
    "error",
    "error_details",
    "stop_reason",
    "permission_decision_reason",
    "additional_context",
    "last_assistant_message",
    "description",
    "reason",
    "message",
    "summary",
    "status",
    "task_id",
    "taskId",
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

function isPermissionDeniedStop(eventName: string, detail: string): boolean {
  if (eventName !== "Stop") {
    return false;
  }

  const normalized = detail.toLowerCase();
  return normalized.includes("permission was denied") ||
    (normalized.includes("don't-ask mode") && normalized.includes("can't complete that command as requested"));
}

function mapEventToState(
  eventName: string,
  toolName: string | undefined,
  detail: string,
): OfficeState | null {
  if (isPermissionDeniedStop(eventName, detail)) {
    return "error";
  }

  switch (eventName) {
    case "SessionStart":
    case "SessionEnd":
    case "TaskCompleted":
    case "Stop":
    case "SubagentStop":
    case "TeammateIdle":
      return "idle";
    case "PreToolUse":
    case "PostToolUse":
      return mapToolNameToState(toolName);
    case "PostToolUseFailure":
    case "PermissionDenied":
    case "StopFailure":
      return "error";
    case "PermissionRequest":
    case "TaskCreated":
    case "SubagentStart":
    case "Notification":
    case "UserPromptSubmit":
    case "Setup":
    case "Elicitation":
    case "ElicitationResult":
      return "executing";
    case "ConfigChange":
    case "InstructionsLoaded":
    case "CwdChanged":
    case "FileChanged":
    case "WorktreeCreate":
    case "WorktreeRemove":
    case "PreCompact":
    case "PostCompact":
      return "syncing";
    default:
      return null;
  }
}

export function normalizeClaudeEvent(event: ClaudeBridgeEvent): NormalizedSignal | null {
  const payload = asRecord(event.payload);
  const toolName = extractToolName(payload);
  const controlPlanePrompt = event.event_name === "UserPromptSubmit"
    ? parseControlPlanePrompt(firstString(payload, ["prompt"]))
    : null;
  const directControlPlane = parseDirectControlPlaneEvent(event.event_name, payload);
  const controlPlane = controlPlanePrompt?.controlPlane || directControlPlane;
  const notificationType = firstString(payload, ["notification_type", "notificationType"]);
  const notificationTitle = firstString(payload, ["title"]);
  const notificationMessage = firstString(payload, ["message"]);
  const notificationMetadata = event.event_name === "Notification"
    ? parseNotificationMessage(notificationMessage)
    : null;
  const detail = buildDetail(event.event_name, toolName, payload);
  const state = mapEventToState(event.event_name, toolName, detail);

  if (!state) {
    return null;
  }

  const scope = deriveScope(payload, event.event_name);
  const context: SignalContext = {
    cwd: firstString(payload, ["cwd"]),
    transcriptPath: firstString(payload, ["transcript_path", "transcriptPath"]),
    agentTranscriptPath: firstString(payload, ["agent_transcript_path", "agentTranscriptPath"]),
    rawToolName: toolName,
    agentId: firstString(payload, ["agent_id", "agentId"]),
    agentType: firstString(payload, ["agent_type", "agentType"]),
    taskId: firstString(payload, ["task_id", "taskId"]),
    taskStatus: firstString(payload, ["task_status", "taskStatus", "status"]),
    taskSummary: firstString(payload, ["task_summary", "taskSummary", "summary"]),
    outputFilePath: firstString(payload, ["output_file", "outputFile", "output_file_path", "outputFilePath"]),
    worktreePath: extractWorktreePath(payload),
    worktreeBranch: extractWorktreeBranch(payload),
    teamName: firstString(payload, ["team_name", "teamName"]),
    teammateName: controlPlanePrompt?.teammateName || firstString(payload, ["teammate_name", "teammateName"]),
    teammateSummary: controlPlanePrompt?.teammateSummary,
    parentSessionId: firstString(payload, ["parent_session_id", "parentSessionId"]),
    notificationType,
    notificationTitle,
    notificationMessage,
    notificationWorkerName: notificationMetadata?.workerName,
    notificationToolName: notificationMetadata?.toolName,
    notificationHost: notificationMetadata?.host,
    controlPlaneType: controlPlane?.type,
    controlPlaneSubtype: controlPlane?.subtype,
    controlPlaneRequestId: controlPlane?.requestId,
    controlPlaneSender: controlPlane?.from,
    controlPlaneAgentId: controlPlane?.agentId,
    controlPlaneToolName: controlPlane?.toolName,
    controlPlaneToolUseId: controlPlane?.toolUseId,
    controlPlaneDescription: controlPlane?.description,
    controlPlaneApproved: controlPlane?.approved,
    controlPlaneAllow: controlPlane?.allow,
    controlPlaneReason: controlPlane?.reason,
    controlPlaneFeedback: controlPlane?.feedback,
    controlPlaneError: controlPlane?.error,
    controlPlaneHost: controlPlane?.host,
    controlPlanePlanFilePath: controlPlane?.planFilePath,
    controlPlaneTimestamp: controlPlane?.timestamp,
    controlPlanePermissionUpdatesCount: controlPlane?.permissionUpdatesCount,
    permissionSuggestionsCount: controlPlane?.permissionSuggestionsCount ?? (
      Array.isArray(payload.permission_suggestions)
        ? payload.permission_suggestions.length
        : undefined
    ),
    stopHookActive: firstBoolean(payload, ["stop_hook_active", "stopHookActive"]),
  };

  const shouldLeave = event.event_name === "SubagentStop" ||
    (event.event_name === "TaskCompleted" && scope === "subagent") ||
    (event.event_name === "Stop" && scope === "subagent");

  return {
    sessionId: deriveSessionId(payload),
    agentName: deriveAgentName(payload, scope),
    scope,
    state,
    detail,
    eventName: event.event_name,
    shouldLeave,
    context,
  };
}
