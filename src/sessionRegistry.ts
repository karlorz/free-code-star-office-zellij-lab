import type { NormalizedSignal, SessionSnapshot } from "./types";

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionSnapshot>();

  record(signal: NormalizedSignal): SessionSnapshot {
    const existing = this.sessions.get(signal.sessionId) || {
      sessionId: signal.sessionId,
      updatedAt: new Date().toISOString(),
      agents: {},
    };

    existing.updatedAt = new Date().toISOString();
    existing.cwd = signal.context.cwd || existing.cwd;
    existing.transcriptPath = signal.context.transcriptPath || existing.transcriptPath;

    if (signal.scope === "main") {
      existing.main = signal;
    } else if (signal.shouldLeave) {
      delete existing.agents[signal.agentName];
    } else {
      existing.agents[signal.agentName] = signal;
    }

    this.sessions.set(signal.sessionId, existing);
    return existing;
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].sort((a, b) => {
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }
}
