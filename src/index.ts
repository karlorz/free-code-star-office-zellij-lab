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

const SSE_REPLAY_CAPACITY = 64;
const sseClients = new Set<ReadableStreamDefaultController>();
const sseEventLog: { id: string; event: string; payload: unknown }[] = [];
const lastSignalByKey = new Map<string, string>();
const dedupCounts = new Map<string, { seen: number; passed: number }>();
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
  const id = randomUUID();
  const entry = { id, event, payload };
  sseEventLog.push(entry);
  if (sseEventLog.length > SSE_REPLAY_CAPACITY) sseEventLog.shift();
  const message = formatSSE(payload, event, id);
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

  // Deduplicate consecutive identical signals per session+event
  const dedupeKey = `${resolvedSignal.sessionId}:${resolvedSignal.context.zellijEvent || resolvedSignal.eventName}`;
  const contextHash = JSON.stringify(resolvedSignal.context);
  const lastHash = lastSignalByKey.get(dedupeKey);
  const isDuplicate = lastHash === contextHash;
  lastSignalByKey.set(dedupeKey, contextHash);

  // Track dedup stats per key
  const stats = dedupCounts.get(dedupeKey) || { seen: 0, passed: 0 };
  stats.seen++;
  if (!isDuplicate) stats.passed++;
  dedupCounts.set(dedupeKey, stats);

  if (isDuplicate) {
    return json({
      ok: true,
      ignored: true,
      reason: "duplicate signal",
      signal: resolvedSignal,
      snapshot,
    });
  }

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

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[bridge] received ${signal}, draining ${sseClients.size} SSE clients...`);

  const shutdownMessage = formatSSE({ shutdown: true, reason: signal }, "shutdown");
  for (const controller of sseClients) {
    try {
      controller.enqueue(shutdownMessage);
      controller.close();
    } catch {}
  }
  sseClients.clear();
  clearInterval(keepAliveInterval);

  await Bun.sleep(1000);
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

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
      const lastEventId = request.headers.get("Last-Event-ID");
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);
          // Send full snapshot on connect so new clients have current state
          const snapshot = registry.list();
          try {
            controller.enqueue(formatSSE(snapshot, "snapshot", randomUUID()));
          } catch {
            sseClients.delete(controller);
            return;
          }
          // Replay recent events to new clients if they send Last-Event-ID
          if (lastEventId) {
            const replayIndex = sseEventLog.findIndex((e) => e.id === lastEventId);
            if (replayIndex !== -1) {
              for (const entry of sseEventLog.slice(replayIndex + 1)) {
                try {
                  controller.enqueue(formatSSE(entry.payload, entry.event, entry.id));
                } catch {
                  sseClients.delete(controller);
                  return;
                }
              }
            }
          }
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
          "X-Accel-Buffering": "no",
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
        sseClients: sseClients.size,
        sseEventLogSize: sseEventLog.length,
        sessions: registry.list().length,
        uptime: process.uptime(),
      });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }

    if (request.method === "GET" && url.pathname === "/snapshot") {
      return json({
        ok: true,
        sessions: registry.list(),
        uptime: process.uptime(),
      });
    }

    if (request.method === "GET" && url.pathname === "/sessions") {
      return json({
        ok: true,
        sessions: registry.list(),
      });
    }

    if (request.method === "GET" && url.pathname.match(/^\/sessions\/[^/]+\/events$/)) {
      const sessionId = decodeURIComponent(url.pathname.split("/")[2]);
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      const sourceFilter = url.searchParams.get("source") || undefined;
      const eventTypeFilter = url.searchParams.get("event_type") || undefined;
      try {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(config.eventsLogPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        let entries = lines
          .map((line) => { try { return JSON.parse(line); } catch { return null; } })
          .filter(Boolean)
          .filter((e: Record<string, unknown>) => {
            const sig = e.signal as Record<string, unknown> | null;
            if (!sig || sig.sessionId !== sessionId) return false;
            if (sourceFilter && e.source !== sourceFilter) return false;
            if (eventTypeFilter) {
              const ctx = sig.context as Record<string, unknown> | undefined;
              const zellijEvt = ctx?.zellijEvent as string | undefined;
              const evtName = sig.eventName as string | undefined;
              if (zellijEvt !== eventTypeFilter && evtName !== eventTypeFilter) return false;
            }
            return true;
          });
        entries = entries.slice(-limit);
        return json({
          ok: true,
          sessionId,
          count: entries.length,
          entries,
        });
      } catch {
        return json({ ok: true, sessionId, count: 0, entries: [] });
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/sessions/")) {
      const sessionId = decodeURIComponent(url.pathname.slice("/sessions/".length));
      if (!sessionId) {
        return json({ ok: false, error: "missing session id" }, { status: 400 });
      }
      const snapshot = registry.get(sessionId);
      if (!snapshot) {
        return json({ ok: false, error: "session not found" }, { status: 404 });
      }
      return json({
        ok: true,
        session: snapshot,
      });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      const dedupEntries = Object.fromEntries(
        [...dedupCounts.entries()].map(([key, val]) => [key, val])
      );
      const totalSeen = [...dedupCounts.values()].reduce((sum, s) => sum + s.seen, 0);
      const totalPassed = [...dedupCounts.values()].reduce((sum, s) => sum + s.passed, 0);
      return json({
        ok: true,
        uptime: process.uptime(),
        sseClients: sseClients.size,
        sseEventLogSize: sseEventLog.length,
        sessions: registry.list().length,
        dedup: {
          totalSeen,
          totalPassed,
          totalSuppressed: totalSeen - totalPassed,
          keysTracked: dedupCounts.size,
          perKey: dedupEntries,
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/events/recent") {
      const afterId = url.searchParams.get("after_id") || undefined;
      let events = sseEventLog;
      if (afterId) {
        const afterIndex = sseEventLog.findIndex((e) => e.id === afterId);
        if (afterIndex !== -1) {
          events = sseEventLog.slice(afterIndex + 1);
        }
      }
      return json({
        ok: true,
        count: events.length,
        events,
      });
    }

    if (request.method === "GET" && url.pathname === "/events/log") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      const sourceFilter = url.searchParams.get("source") || undefined;
      const eventTypeFilter = url.searchParams.get("event_type") || undefined;
      try {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(config.eventsLogPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        let entries = lines.map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        if (sourceFilter || eventTypeFilter) {
          entries = entries.filter((e: Record<string, unknown>) => {
            if (sourceFilter && e.source !== sourceFilter) return false;
            if (eventTypeFilter) {
              const sig = e.signal as Record<string, unknown> | null;
              if (!sig) return false;
              const ctx = sig.context as Record<string, unknown> | undefined;
              const zellijEvt = ctx?.zellijEvent as string | undefined;
              const evtName = sig.eventName as string | undefined;
              if (zellijEvt !== eventTypeFilter && evtName !== eventTypeFilter) return false;
            }
            return true;
          });
        }
        entries = entries.slice(-limit);
        return json({
          ok: true,
          count: entries.length,
          totalLines: lines.length,
          entries,
        });
      } catch (error) {
        return json({
          ok: true,
          count: 0,
          totalLines: 0,
          entries: [],
          error: "log file not found or unreadable",
        });
      }
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

    if (request.method === "POST" && url.pathname === "/hook/zellij") {
      const rawBody = await request.text();
      let body: Record<string, unknown>;

      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return json({ ok: false, error: "invalid json" }, { status: 400 });
      }

      const zellijEvent = typeof body.zellij_event === "string" ? body.zellij_event : "unknown";
      const sessionId = typeof body.session_id === "string" ? body.session_id : "zellij-monitor";
      const cwd = typeof body.cwd === "string" ? body.cwd : "/";

      // Map Zellij events to office states
      let state: NormalizedSignal["state"];
      let detail: string;
      switch (zellijEvent) {
        case "pane_update":
          state = "syncing";
          detail = `pane_update: ${body.total_panes ?? "?"} panes`;
          break;
        case "tab_update":
          state = "syncing";
          detail = `tab_update: ${body.tab_count ?? "?"} tabs, active=${typeof body.active_tab === "string" ? body.active_tab : "?"}`;
          break;
        case "cwd_change":
          state = "executing";
          detail = `cwd_change: ${cwd}`;
          break;
        case "pane_exit":
          state = "idle";
          detail = `pane_exit: exit=${body.exit_status ?? "?"} held=${body.is_held ?? "?"}`;
          break;
        case "client_update":
          state = "syncing";
          detail = `client_update: ${body.client_count ?? "?"} clients`;
          break;
        default:
          state = "syncing";
          detail = zellijEvent;
      }

      const signal: NormalizedSignal = {
        sessionId,
        agentName: "main",
        scope: "main",
        state,
        detail,
        eventName: typeof body.hook_event_name === "string" ? body.hook_event_name : "ZellijEvent",
        shouldLeave: false,
        context: {
          cwd,
          zellijEvent,
          zellijPaneCount: body.total_panes != null ? Number(body.total_panes) : undefined,
          zellijTabCount: body.tab_count != null ? Number(body.tab_count) : undefined,
          zellijFocusedTitles: Array.isArray(body.focused_titles) ? body.focused_titles.map(String) : undefined,
          zellijActiveTab: typeof body.active_tab === "string" ? body.active_tab : undefined,
          zellijTerminalCommand: typeof body.terminal_command === "string" ? body.terminal_command : undefined,
          zellijExitStatus: body.exit_status != null ? Number(body.exit_status) : (body.exit_status === null ? null : undefined),
          zellijIsHeld: typeof body.is_held === "boolean" ? body.is_held : undefined,
          zellijIsFloating: typeof body.is_floating === "boolean" ? body.is_floating : undefined,
          zellijClientCount: body.client_count != null ? Number(body.client_count) : undefined,
          zellijTabNames: Array.isArray(body.tabs) ? body.tabs.map(String) : undefined,
        },
      };

      return processSignal(signal, "zellij-hook");
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
