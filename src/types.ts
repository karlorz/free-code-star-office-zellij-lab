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
  rawToolName?: string;
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

export interface BridgeConfig {
  host: string;
  port: number;
  secret?: string;
  dryRun: boolean;
  starOfficeUrl?: string;
  starOfficeJoinKey?: string;
  mainAgentName: string;
}
