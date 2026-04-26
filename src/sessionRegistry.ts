import type { NormalizedSignal, SessionSnapshot } from "./types";

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly taskOwners = new Map<string, string>();
  private readonly agentNamesById = new Map<string, string>();

  private taskKey(sessionId: string, taskId: string): string {
    return `${sessionId}:${taskId}`;
  }

  private agentIdentityKey(sessionId: string, agentId: string): string {
    return `${sessionId}:${agentId}`;
  }

  private clearTaskOwnersForSession(sessionId: string): void {
    const sessionPrefix = `${sessionId}:`;
    for (const key of this.taskOwners.keys()) {
      if (key.startsWith(sessionPrefix)) {
        this.taskOwners.delete(key);
      }
    }
  }

  private clearAgentNamesForSession(sessionId: string): void {
    const sessionPrefix = `${sessionId}:`;
    for (const key of this.agentNamesById.keys()) {
      if (key.startsWith(sessionPrefix)) {
        this.agentNamesById.delete(key);
      }
    }
  }

  private clearAgentNamesForAgent(sessionId: string, agentName: string): void {
    const sessionPrefix = `${sessionId}:`;
    for (const [key, name] of this.agentNamesById) {
      if (name === agentName && key.startsWith(sessionPrefix)) {
        this.agentNamesById.delete(key);
      }
    }
  }

  private clearTaskOwnersForAgent(sessionId: string, agentName: string): void {
    const sessionPrefix = `${sessionId}:`;
    for (const [key, owner] of this.taskOwners) {
      if (owner === agentName && key.startsWith(sessionPrefix)) {
        this.taskOwners.delete(key);
      }
    }
  }

  private renameTaskOwnersForAgent(
    sessionId: string,
    previousName: string,
    nextName: string,
  ): void {
    if (previousName === nextName) {
      return;
    }
    const sessionPrefix = `${sessionId}:`;
    for (const [key, owner] of this.taskOwners) {
      if (owner === previousName && key.startsWith(sessionPrefix)) {
        this.taskOwners.set(key, nextName);
      }
    }
  }

  private resetSession(sessionId: string): void {
    this.clearTaskOwnersForSession(sessionId);
    this.clearAgentNamesForSession(sessionId);
    this.sessions.delete(sessionId);
  }

  private rememberAgentIdentity(signal: NormalizedSignal): NormalizedSignal {
    if (signal.scope !== "subagent") {
      return signal;
    }

    const agentId = signal.context.agentId;
    if (!agentId) {
      return signal;
    }

    const key = this.agentIdentityKey(signal.sessionId, agentId);
    const knownName = this.agentNamesById.get(key);

    if (knownName && knownName !== signal.agentName) {
      const isKnownGeneric = knownName === agentId || knownName === "subagent";
      const isIncomingSpecific = signal.agentName !== agentId && signal.agentName !== "subagent";

      if (isKnownGeneric && isIncomingSpecific) {
        this.agentNamesById.set(key, signal.agentName);
        const session = this.sessions.get(signal.sessionId);
        if (session?.agents[knownName]) {
          delete session.agents[knownName];
        }
        this.renameTaskOwnersForAgent(signal.sessionId, knownName, signal.agentName);
        return signal;
      }

      return {
        ...signal,
        agentName: knownName,
      };
    }

    this.agentNamesById.set(key, signal.agentName);
    return signal;
  }

  private resolveSignal(signal: NormalizedSignal): NormalizedSignal {
    let resolved = this.rememberAgentIdentity(signal);
    const taskId = resolved.context.taskId;

    if (resolved.eventName === "TaskCreated" && resolved.scope === "subagent" && taskId) {
      this.taskOwners.set(this.taskKey(resolved.sessionId, taskId), resolved.agentName);
    }

    if (resolved.eventName === "TaskCompleted" && taskId) {
      const owner = this.taskOwners.get(this.taskKey(resolved.sessionId, taskId));
      if (owner) {
        this.taskOwners.delete(this.taskKey(resolved.sessionId, taskId));
        resolved = {
          ...resolved,
          scope: "subagent",
          agentName: owner,
          shouldLeave: true,
        };
      }
    }

    if (resolved.shouldLeave && resolved.scope === "subagent") {
      if (taskId) {
        this.taskOwners.delete(this.taskKey(resolved.sessionId, taskId));
      }
      this.clearTaskOwnersForAgent(resolved.sessionId, resolved.agentName);
      const agentId = resolved.context.agentId;
      if (agentId) {
        this.agentNamesById.delete(this.agentIdentityKey(resolved.sessionId, agentId));
      }
      this.clearAgentNamesForAgent(resolved.sessionId, resolved.agentName);
    }

    return resolved;
  }

  record(signal: NormalizedSignal): { snapshot: SessionSnapshot; signal: NormalizedSignal } {
    const resolvedSignal = this.resolveSignal(signal);
    if (resolvedSignal.eventName === "SessionStart" || resolvedSignal.eventName === "SessionEnd") {
      this.resetSession(resolvedSignal.sessionId);
    }
    const existing = this.sessions.get(resolvedSignal.sessionId) || {
      sessionId: resolvedSignal.sessionId,
      updatedAt: new Date().toISOString(),
      agents: {},
    };

    existing.updatedAt = new Date().toISOString();
    existing.cwd = resolvedSignal.context.cwd || existing.cwd;
    existing.transcriptPath = resolvedSignal.context.transcriptPath || existing.transcriptPath;

    if (resolvedSignal.scope === "main") {
      existing.main = resolvedSignal;
    } else if (resolvedSignal.shouldLeave) {
      delete existing.agents[resolvedSignal.agentName];
    } else {
      existing.agents[resolvedSignal.agentName] = resolvedSignal;
    }

    this.sessions.set(resolvedSignal.sessionId, existing);
    return {
      snapshot: existing,
      signal: resolvedSignal,
    };
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].sort((a, b) => {
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  get(sessionId: string): SessionSnapshot | undefined {
    return this.sessions.get(sessionId);
  }
}
