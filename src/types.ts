export type OfficeState =
  | "idle"
  | "writing"
  | "researching"
  | "executing"
  | "syncing"
  | "error";

export type AgentScope = "main" | "subagent";

export interface ClaudeBridgeEvent {
  source: string;
  event_name: string;
  payload?: Record<string, unknown> | null;
  received_at?: string;
}

export interface SignalContext {
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
  notificationWorkerName?: string;
  notificationToolName?: string;
  notificationHost?: string;
  controlPlaneType?: string;
  controlPlaneSubtype?: string;
  controlPlaneRequestId?: string;
  controlPlaneSender?: string;
  controlPlaneAgentId?: string;
  controlPlaneToolName?: string;
  controlPlaneToolUseId?: string;
  controlPlaneDescription?: string;
  controlPlaneApproved?: boolean;
  controlPlaneAllow?: boolean;
  controlPlaneReason?: string;
  controlPlaneFeedback?: string;
  controlPlaneError?: string;
  controlPlaneHost?: string;
  controlPlanePlanFilePath?: string;
  controlPlaneTimestamp?: string;
  controlPlanePermissionUpdatesCount?: number;
  permissionSuggestionsCount?: number;
  stopHookActive?: boolean;
}

export interface NormalizedSignal {
  sessionId: string;
  agentName: string;
  scope: AgentScope;
  state: OfficeState;
  detail: string;
  eventName: string;
  shouldLeave?: boolean;
  context: SignalContext;
}

export interface SessionSnapshot {
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
  updatedAt: string;
  main?: NormalizedSignal;
  agents: Record<string, NormalizedSignal>;
}

export interface BridgeErrorInfo {
  message: string;
  stack?: string;
}

export interface BridgeEventLogEntry {
  source: string;
  receivedAt: string;
  rawEvent: unknown | null;
  signal: NormalizedSignal | null;
  originalSignal: NormalizedSignal | null;
  starOfficeResult: unknown | null;
  starOfficeError: BridgeErrorInfo | null;
  ignored: boolean;
  ignoreReason: string | null;
  rawBody?: string;
}

export interface BridgeConfig {
  host: string;
  port: number;
  secret?: string;
  dryRun: boolean;
  eventsLogPath: string;
  starOfficeUrl?: string;
  starOfficeJoinKey?: string;
  mainAgentName: string;
}
