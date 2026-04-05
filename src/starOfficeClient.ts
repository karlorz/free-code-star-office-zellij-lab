import type { BridgeConfig, NormalizedSignal } from "./types";

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

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

  private sessionAgentKey(signal: NormalizedSignal): string {
    return `${signal.sessionId}:${signal.agentName}`;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (!this.baseUrl || this.dryRun) {
      return {
        dryRun: true,
        path,
        body,
      };
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    const parsed = parseJsonSafely(text);

    if (!response.ok) {
      throw new Error(`Star Office request failed ${response.status}: ${text}`);
    }

    return parsed;
  }

  private async ensureJoined(signal: NormalizedSignal): Promise<string> {
    const key = this.sessionAgentKey(signal);
    const existingAgentId = this.agentIds.get(key);

    if (existingAgentId) {
      return existingAgentId;
    }

    if (!this.joinKey && !this.dryRun) {
      throw new Error("STAR_OFFICE_JOIN_KEY is required for subagent sync");
    }

    const joinResponse = await this.post("/join-agent", {
      name: signal.agentName,
      joinKey: this.joinKey || "dry-run-join-key",
      state: signal.state,
      detail: signal.detail,
    });

    const parsed = joinResponse as { agentId?: string };
    const agentId = parsed.agentId || `${signal.sessionId}:${signal.agentName}`;
    this.agentIds.set(key, agentId);
    return agentId;
  }

  async apply(signal: NormalizedSignal): Promise<unknown> {
    if (signal.scope === "main") {
      return this.post("/set_state", {
        state: signal.state,
        detail: signal.detail,
      });
    }

    const key = this.sessionAgentKey(signal);

    if (signal.shouldLeave) {
      const knownAgentId = this.agentIds.get(key);
      const result = await this.post("/leave-agent", {
        agentId: knownAgentId,
        name: signal.agentName,
      });
      this.agentIds.delete(key);
      return result;
    }

    const agentId = await this.ensureJoined(signal);
    return this.post("/agent-push", {
      agentId,
      joinKey: this.joinKey || "dry-run-join-key",
      state: signal.state,
      detail: signal.detail,
      name: signal.agentName,
    });
  }
}
