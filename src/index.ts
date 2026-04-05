import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config";
import { SessionRegistry } from "./sessionRegistry";
import { StarOfficeClient } from "./starOfficeClient";
import { normalizeClaudeEvent } from "./stateMapper";
import type { ClaudeBridgeEvent, NormalizedSignal } from "./types";

const config = loadConfig();
const registry = new SessionRegistry();
const starOfficeClient = new StarOfficeClient(config);
const eventsLogPath = join(process.cwd(), "tmp", "events.ndjson");

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers || {}),
    },
  });
}

async function appendEvent(entry: unknown): Promise<void> {
  await mkdir(join(process.cwd(), "tmp"), { recursive: true });
  await appendFile(eventsLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function isAuthorized(request: Request): boolean {
  if (!config.secret) {
    return true;
  }
  return request.headers.get("x-bridge-secret") === config.secret;
}

async function processSignal(signal: NormalizedSignal, source: string): Promise<Response> {
  const snapshot = registry.record(signal);
  const starOfficeResult = await starOfficeClient.apply(signal);

  await appendEvent({
    source,
    receivedAt: new Date().toISOString(),
    signal,
    starOfficeResult,
  });

  return json({
    ok: true,
    signal,
    snapshot,
    starOfficeResult,
  });
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (!isAuthorized(request) && request.method !== "GET") {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        host: config.host,
        port: config.port,
        dryRun: config.dryRun,
        starOfficeUrl: config.starOfficeUrl || null,
      });
    }

    if (request.method === "GET" && url.pathname === "/sessions") {
      return json({
        ok: true,
        sessions: registry.list(),
      });
    }

    if (request.method === "POST" && url.pathname === "/hook/claude") {
      const body = (await request.json()) as ClaudeBridgeEvent;
      const event = {
        ...body,
        received_at: body.received_at || new Date().toISOString(),
      };
      const signal = normalizeClaudeEvent(event);

      if (!signal) {
        await appendEvent({
          source: "claude-hook",
          receivedAt: new Date().toISOString(),
          ignored: true,
          event,
        });
        return json({
          ok: true,
          ignored: true,
          reason: "event did not map to an office state",
        });
      }

      return processSignal(signal, "claude-hook");
    }

    if (request.method === "POST" && url.pathname === "/event/manual") {
      const body = (await request.json()) as {
        sessionId?: string;
        agentName?: string;
        scope?: "main" | "subagent";
        state: NormalizedSignal["state"];
        detail?: string;
        shouldLeave?: boolean;
      };

      const signal: NormalizedSignal = {
        sessionId: body.sessionId || "manual-session",
        agentName: body.agentName || "main",
        scope: body.scope || "main",
        state: body.state,
        detail: body.detail || body.state,
        eventName: "ManualEvent",
        shouldLeave: body.shouldLeave,
        context: {},
      };

      return processSignal(signal, "manual");
    }

    return json({ ok: false, error: "not found" }, { status: 404 });
  },
});

console.log(
  `[bridge] listening on http://${server.hostname}:${server.port} dryRun=${config.dryRun} starOffice=${config.starOfficeUrl || "none"}`,
);
