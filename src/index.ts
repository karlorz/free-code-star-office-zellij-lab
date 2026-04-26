import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config";
import { SessionRegistry } from "./sessionRegistry";
import { StarOfficeClient } from "./starOfficeClient";
import { normalizeClaudeEvent } from "./stateMapper";
import type {
  BridgeErrorInfo,
  BridgeEventLogEntry,
  ClaudeBridgeEvent,
  NormalizedSignal,
} from "./types";

const sseClients = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();

function formatSSE(data: unknown, event?: string, id?: string): Uint8Array {
  const parts: string[] = [];
  if (id) parts.push(`id: ${id}`);
  if (event) parts.push(`event: ${event}`);
  parts.push(`data: ${JSON.stringify(data)}`);
  parts.push("", "");
  return encoder.encode(parts.join("\n"));
}

function broadcastSSE(event: string, payload: unknown): void {
  const message = formatSSE(payload, event, randomUUID());
  for (const controller of sseClients) {
    try {
      controller.enqueue(message);
    } catch {
      sseClients.delete(controller);
    }
  }
}

const config = loadConfig();
const registry = new SessionRegistry();
const starOfficeClient = new StarOfficeClient(config);

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers || {}),
    },
  });
}

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

async function appendEvent(entry: BridgeEventLogEntry): Promise<void> {
  try {
    await mkdir(dirname(config.eventsLogPath), { recursive: true });
    await appendFile(config.eventsLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.warn("[bridge] failed to append event", formatError(error));
  }
}

async function appendIgnoredEvent(
  source: string,
  ignoreReason: string,
  options: {
    rawEvent?: unknown;
    rawBody?: string;
  } = {},
): Promise<void> {
  await appendEvent({
    source,
    receivedAt: new Date().toISOString(),
    rawEvent: options.rawEvent ?? null,
    signal: null,
    originalSignal: null,
    starOfficeResult: null,
    starOfficeError: null,
    ignored: true,
    ignoreReason,
    rawBody: options.rawBody,
  });
}

function isAuthorized(request: Request): boolean {
  if (!config.secret) {
    return true;
  }
  return request.headers.get("x-bridge-secret") === config.secret;
}

async function processSignal(
  signal: NormalizedSignal,
  source: string,
  rawEvent?: ClaudeBridgeEvent,
): Promise<Response> {
  const { snapshot, signal: resolvedSignal } = registry.record(signal);

  let starOfficeResult: unknown;
  let starOfficeError: { message: string; stack?: string } | undefined;

  try {
    starOfficeResult = await starOfficeClient.apply(resolvedSignal);
  } catch (error) {
    starOfficeError = formatError(error);
  }

  await appendEvent({
    source,
    receivedAt: new Date().toISOString(),
    rawEvent: rawEvent ?? null,
    signal: resolvedSignal,
    originalSignal: signal,
    starOfficeResult: starOfficeResult ?? null,
    starOfficeError: starOfficeError ?? null,
    ignored: false,
    ignoreReason: null,
  });

  broadcastSSE("signal", resolvedSignal);

  if (starOfficeError) {
    return json({
      ok: false,
      signal: resolvedSignal,
      snapshot,
      error: "star office apply failed",
      starOfficeError,
    }, { status: 502 });
  }

  return json({
    ok: true,
    signal: resolvedSignal,
    snapshot,
    starOfficeResult,
  });
}

const keepAliveInterval = setInterval(() => {
  const ping = encoder.encode(": ping\n\n");
  for (const controller of sseClients) {
    try {
      controller.enqueue(ping);
    } catch {
      sseClients.delete(controller);
    }
  }
}, 15_000);

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (!isAuthorized(request) && request.method !== "GET") {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    if (request.method === "GET" && url.pathname === "/events") {
      server.timeout(request, 0);
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);
          request.signal.addEventListener("abort", () => {
            sseClients.delete(controller);
            try {
              controller.close();
            } catch {}
          });
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
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
      const rawBody = await request.text();
      let body: ClaudeBridgeEvent;

      try {
        body = JSON.parse(rawBody) as ClaudeBridgeEvent;
      } catch {
        await appendIgnoredEvent("claude-hook", "invalid json", { rawBody });
        return json({ ok: false, error: "invalid json" }, { status: 400 });
      }

      if (!body || (typeof body.event_name !== "string" || body.event_name.trim() === "") && (typeof body.hook_event_name !== "string" || body.hook_event_name.trim() === "")) {
        await appendIgnoredEvent("claude-hook", "missing event_name", { rawEvent: body ?? null });
        return json({ ok: false, error: "missing event_name" }, { status: 400 });
      }

      // Normalize native HTTP hook format (hook_event_name at top level) into
      // the bridge's existing event_name + payload envelope shape.
      const eventName = body.event_name || body.hook_event_name || "unknown";
      if (!body.event_name && body.hook_event_name) {
        const { hook_event_name, session_id, cwd: bodyCwd, transcript_path, tool_name, tool_input, tool_response, tool_use_id, permission_mode, ...rest } = body;
        body = {
          source: "claude-hook",
          event_name: hook_event_name!,
          payload: {
            session_id,
            cwd: bodyCwd,
            transcript_path,
            tool_name,
            tool_input,
            tool_response,
            tool_use_id,
            permission_mode,
            ...rest,
          },
          received_at: new Date().toISOString(),
        };
      }

      const event = {
        ...body,
        source: body.source || "claude-hook",
        received_at: body.received_at || new Date().toISOString(),
      };
      const signal = normalizeClaudeEvent(event);

      if (!signal) {
        await appendIgnoredEvent("claude-hook", "event did not map to an office state", { rawEvent: event });
        return json({
          ok: true,
          ignored: true,
          reason: "event did not map to an office state",
        });
      }

      return processSignal(signal, "claude-hook", event);
    }

    if (request.method === "POST" && url.pathname === "/event/manual") {
      let body: {
        sessionId?: string;
        agentName?: string;
        scope?: "main" | "subagent";
        state: NormalizedSignal["state"];
        detail?: string;
        shouldLeave?: boolean;
      };

      try {
        body = (await request.json()) as {
          sessionId?: string;
          agentName?: string;
          scope?: "main" | "subagent";
          state: NormalizedSignal["state"];
          detail?: string;
          shouldLeave?: boolean;
        };
      } catch {
        return json({ ok: false, error: "invalid json" }, { status: 400 });
      }

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
