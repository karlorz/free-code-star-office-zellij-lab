import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
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
const SSE_MAX_BUFFERED_MESSAGES = 32; // Drop clients with more than this many buffered messages
let sseEventSeq = 0;
let sseClientSeq = 0;
const sseClients = new Map<number, { controller: ReadableStreamDefaultController; buffered: number }>();
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID, X-Bridge-Secret",
};
const sseEventLog: { id: number; event: string; payload: unknown }[] = [];
const lastSignalByKey = new Map<string, string>();
const dedupCounts = new Map<string, { seen: number; passed: number }>();
const encoder = new TextEncoder();

function formatSSE(data: unknown, event?: string, id?: number): Uint8Array {
  const parts: string[] = [];
  if (id !== undefined) parts.push(`id: ${id}`);
  if (event) parts.push(`event: ${event}`);
  parts.push(`retry: 3000`);
  parts.push(`data: ${JSON.stringify(data)}`);
  parts.push("", "");
  return encoder.encode(parts.join("\n"));
}

function broadcastSSE(event: string, payload: unknown): number {
  const id = ++sseEventSeq;
  const entry = { id, event, payload };
  sseEventLog.push(entry);
  if (sseEventLog.length > SSE_REPLAY_CAPACITY) sseEventLog.shift();
  const message = formatSSE(payload, event, id);
  for (const [cid, client] of sseClients) {
    try {
      client.controller.enqueue(message);
      // Successful enqueue means the stream absorbed it — no accumulation
      // buffered tracks pending writes that haven't been flushed yet
      // Check backpressure: drop slow clients
      if (client.buffered > SSE_MAX_BUFFERED_MESSAGES) {
        console.warn(`[bridge] dropping slow SSE client ${cid} (${client.buffered} buffered messages)`);
        try {
          client.controller.enqueue(formatSSE({ reason: "backpressure", bufferedMessages: client.buffered }, "backpressure"));
          client.controller.close();
        } catch {}
        sseClients.delete(cid);
      }
    } catch {
      // Enqueue failed — increment buffer count for this stalled client
      client.buffered++;
      if (client.buffered > SSE_MAX_BUFFERED_MESSAGES) {
        console.warn(`[bridge] dropping stalled SSE client ${cid} (${client.buffered} failed enqueues)`);
        sseClients.delete(cid);
      }
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
      ...CORS_HEADERS,
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

// Simple rate limiter: per-IP sliding window
const rateLimits = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 120; // requests per window

function checkRateLimit(request: Request): string | null {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { count: 1, windowStart: now });
    return null;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return ip;
  }
  return null;
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
  for (const [cid, client] of sseClients) {
    try {
      client.controller.enqueue(ping);
      // Reset buffer counter on successful ping — client is keeping up
      client.buffered = 0;
    } catch {
      sseClients.delete(cid);
    }
  }
}, 15_000);

// Periodic sweeper: prune stale dedup entries and log summary
const sweeperInterval = setInterval(() => {
  const now = Date.now();
  // Prune dedup entries that haven't been seen recently
  for (const [key, stats] of dedupCounts) {
    if (stats.seen === stats.passed && stats.seen < 2) {
      dedupCounts.delete(key);
      lastSignalByKey.delete(key);
    }
  }
  if (sseClients.size > 0 || sseEventLog.length > 0) {
    console.log(`[bridge] sweep: ${sseClients.size} clients, ${sseEventLog.length} events, ${dedupCounts.size} dedup keys, seq=${sseEventSeq}`);
  }
}, 60_000);

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[bridge] received ${signal}, draining ${sseClients.size} SSE clients...`);

  const shutdownMessage = formatSSE({ shutdown: true, reason: signal }, "shutdown");
  for (const [cid, client] of sseClients) {
    try {
      client.controller.enqueue(shutdownMessage);
      client.controller.close();
    } catch {}
  }
  sseClients.clear();
  clearInterval(keepAliveInterval);
  clearInterval(sweeperInterval);

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
    const start = performance.now();

    const response = await handleRequest(request, url);
    const duration = (performance.now() - start).toFixed(1);
    console.log(`[bridge] ${request.method} ${url.pathname} ${response.status} ${duration}ms`);
    return response;
  },
});

async function handleRequest(request: Request, url: URL): Promise<Response> {
    // Rate limit POST endpoints
    if (request.method === "POST") {
      const limited = checkRateLimit(request);
      if (limited) {
        return json({ ok: false, error: "rate limited", retryAfterMs: RATE_LIMIT_WINDOW }, { status: 429 });
      }
    }

    if (!isAuthorized(request) && request.method !== "GET") {
      return json({ ok: false, error: "unauthorized" }, { status: 401, headers: CORS_HEADERS });
    }

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/events") {
      server.timeout(request, 0);
      const lastEventId = request.headers.get("Last-Event-ID");
      const clientId = ++sseClientSeq;
      const stream = new ReadableStream({
        start(controller) {
          sseClients.set(clientId, { controller, buffered: 0 });
          // Notify other clients about new connection
          broadcastSSE("client_connected", { clientId, totalClients: sseClients.size });
          // Send full snapshot on connect so new clients have current state
          const snapshot = registry.list();
          try {
            controller.enqueue(formatSSE({ ...snapshot, _clientId: clientId }, "snapshot", ++sseEventSeq));
          } catch {
            sseClients.delete(clientId);
            return;
          }
          // Replay recent events to new clients if they send Last-Event-ID
          if (lastEventId) {
            const requestedId = Number(lastEventId);
            if (!isNaN(requestedId)) {
              const replayIndex = sseEventLog.findIndex((e) => e.id === requestedId);
              if (replayIndex !== -1) {
                // Found the event — replay everything after it (skip ephemeral client events)
                for (const entry of sseEventLog.slice(replayIndex + 1)) {
                  if (entry.event === "client_connected" || entry.event === "client_disconnected") continue;
                  try {
                    controller.enqueue(formatSSE(entry.payload, entry.event, entry.id));
                  } catch {
                    sseClients.delete(clientId);
                    return;
                  }
                }
              } else {
                // Stale Last-Event-ID: event older than ring buffer — send gap notification
                const gapStart = requestedId;
                const gapEnd = sseEventLog.length > 0 ? sseEventLog[0].id - 1 : sseEventSeq;
                const gapSize = gapEnd - gapStart;
                try {
                  controller.enqueue(formatSSE({
                    gapStart,
                    gapEnd,
                    gapSize,
                    suggestion: "replay unavailable — use /snapshot or /events/recent for full state",
                  }, "gap", ++sseEventSeq));
                } catch {
                  sseClients.delete(clientId);
                  return;
                }
              }
            }
          }
          request.signal.addEventListener("abort", () => {
            sseClients.delete(clientId);
            broadcastSSE("client_disconnected", { clientId, totalClients: sseClients.size });
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
          ...CORS_HEADERS,
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
        sseClientIds: [...sseClients.keys()],
        uptime: process.uptime(),
      });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain", ...CORS_HEADERS } });
    }

    if (request.method === "GET" && url.pathname === "/events/test") {
      return new Response(`<!DOCTYPE html>
<html><head><title>Star Office Bridge — SSE Test</title>
<style>
body{font-family:monospace;margin:1rem;background:#1a1a2e;color:#e0e0e0}
#status{color:#0f0;margin-bottom:1rem}
#events{white-space:pre-wrap;font-size:0.85rem;max-height:80vh;overflow-y:auto}
.evt{padding:2px 0;border-bottom:1px solid #333}
.evt-signal{color:#7ec8e3}.evt-snapshot{color:#f0c040}.evt-gap{color:#ff6b6b}
.evt-client{color:#a0a0a0}.evt-backpressure{color:#ff4444}.evt-other{color:#c0c0c0}
.ts{color:#666;margin-right:0.5rem}
</style></head><body>
<h2>Star Office Bridge — SSE Test</h2>
<div id="status">Connecting...</div>
<div id="events"></div>
<script>
const el=document.getElementById("events");
const st=document.getElementById("status");
const es=new EventSource("/events");
let count=0;
function add(cls,text){
  const d=document.createElement("div");
  d.className="evt evt-"+cls;
  d.innerHTML='<span class="ts">'+new Date().toLocaleTimeString()+'</span>'+text;
  el.prepend(d);
  if(++count>200)d.lastChild&&d.remove();
}
es.onopen=()=>{st.textContent="Connected";st.style.color="#0f0"};
es.onerror=()=>{st.textContent="Disconnected — reconnecting...";st.style.color="#f00"};
es.addEventListener("snapshot",e=>{add("snapshot","SNAPSHOT "+e.data)});
es.addEventListener("signal",e=>{const d=JSON.parse(e.data);add("signal",d.state+" "+d.detail)});
es.addEventListener("gap",e=>{const d=JSON.parse(e.data);add("gap","GAP "+d.gapSize+" events missed")});
es.addEventListener("client_connected",e=>{const d=JSON.parse(e.data);add("client","CLIENT #"+d.clientId+" connected ("+d.totalClients+" total)")});
es.addEventListener("client_disconnected",e=>{const d=JSON.parse(e.data);add("client","CLIENT #"+d.clientId+" disconnected ("+d.totalClients+" total)")});
es.addEventListener("backpressure",e=>{add("backpressure","BACKPRESSURE "+e.data)});
es.addEventListener("shutdown",e=>{add("other","SHUTDOWN "+e.data)});
es.onmessage=e=>{add("other",e.type+": "+e.data)};
</script></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS },
      });
    }

    if (request.method === "GET" && url.pathname === "/version") {
      return json({
        ok: true,
        version: "0.9.0",
        runtime: `bun ${Bun.version}`,
        arch: process.arch,
        platform: process.platform,
        uptime: process.uptime(),
      });
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
        sseClientIds: [...sseClients.keys()],
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
      const afterId = url.searchParams.get("after_id");
      let events = sseEventLog;
      if (afterId) {
        const requestedId = Number(afterId);
        if (!isNaN(requestedId)) {
          const afterIndex = sseEventLog.findIndex((e) => e.id === requestedId);
          if (afterIndex !== -1) {
            events = sseEventLog.slice(afterIndex + 1);
          }
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
        case "command_change":
          state = "executing";
          detail = `command_change: ${typeof body.terminal_command === "string" ? body.terminal_command : "?"}`;
          break;
        case "pane_content":
          state = "executing";
          detail = `pane_content: pane=${body.pane_id ?? "?"} lines=${body.viewport_lines ?? "?"}`;
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
          zellijPaneId: typeof body.pane_id === "string" ? body.pane_id : undefined,
          zellijViewportLines: body.viewport_lines != null ? Number(body.viewport_lines) : undefined,
          zellijViewportHash: typeof body.viewport_hash === "string" ? body.viewport_hash : undefined,
          zellijLastLine: typeof body.last_line === "string" ? body.last_line : undefined,
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
}

console.log(
  `[bridge] listening on http://${server.hostname}:${server.port} dryRun=${config.dryRun} starOffice=${config.starOfficeUrl || "none"}`,
);
