import { mkdir, appendFile, readFile } from "node:fs/promises";
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
  return broadcastSSEWithId(id, event, payload);
}

function broadcastSSEWithId(id: number, event: string, payload: unknown): number {
  const entry = { id, event, payload };
  sseEventLog.push(entry);
  if (sseEventLog.length > SSE_REPLAY_CAPACITY) sseEventLog.shift();
  const message = formatSSE(payload, event, id);
  for (const [cid, client] of sseClients) {
    try {
      client.controller.enqueue(message);
      if (client.buffered > SSE_MAX_BUFFERED_MESSAGES) {
        console.warn(`[bridge] dropping slow SSE client ${cid} (${client.buffered} buffered messages)`);
        try {
          client.controller.enqueue(formatSSE({ reason: "backpressure", bufferedMessages: client.buffered }, "backpressure"));
          client.controller.close();
        } catch {}
        sseClients.delete(cid);
      }
    } catch {
      client.buffered++;
      if (client.buffered > SSE_MAX_BUFFERED_MESSAGES) {
        console.warn(`[bridge] dropping stalled SSE client ${cid} (${client.buffered} failed enqueues)`);
        sseClients.delete(cid);
      }
    }
  }
  // Also publish to WebSocket subscribers
  try {
    server.publish("bridge-events", JSON.stringify({ type: event, id, data: payload }));
  } catch {}
  return id;
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

function mapZellijEvent(body: Record<string, unknown>): NormalizedSignal {
  const zellijEvent = typeof body.zellij_event === "string" ? body.zellij_event : "unknown";
  const sessionId = typeof body.session_id === "string" ? body.session_id : "zellij-monitor";
  const cwd = typeof body.cwd === "string" ? body.cwd : "/";

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
    case "web_status":
      state = "syncing";
      detail = `web_status: ${typeof body.web_status === "string" ? body.web_status : "?"}`;
      break;
    default:
      state = "syncing";
      detail = zellijEvent;
  }

  return {
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
      zellijWebStatus: typeof body.web_status === "string" ? body.web_status : undefined,
    },
  };
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

const ALLOWED_ACTIONS = new Set([
  "new-tab", "close-tab", "close-tab-by-id", "go-to-tab", "go-to-tab-by-id", "go-to-tab-name",
  "go-to-next-tab", "go-to-previous-tab", "rename-tab",
  "new-pane", "close-pane", "focus-next-pane", "focus-previous-pane", "focus-pane-id",
  "toggle-fullscreen", "toggle-pane-embed-or-floating", "toggle-floating-panes",
  "show-floating-panes", "hide-floating-panes",
  "move-focus", "move-focus-or-tab", "resize",
  "write", "write-chars", "switch-mode",
  "dump-screen", "dump-layout", "current-tab-info",
  "start-or-reload-plugin", "launch-or-focus-plugin",
  "list-clients", "list-panes", "list-tabs",
  "subscribe",
  "web --status", "web --create-token", "web --create-read-only-token", "web --revoke-token",
]);

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

  // Process signal asynchronously after fast-ack response.
  // This prevents hook timeouts (10s) when starOfficeClient.apply() is slow.
  // The hook response is ignored by Claude Code for decision purposes anyway.
  const signalId = ++sseEventSeq;
  broadcastSSEWithId(signalId, "signal", resolvedSignal);

  // Fire-and-forget: append to log + apply to star office
  appendEvent({
    source,
    receivedAt: new Date().toISOString(),
    rawEvent: rawEvent ?? null,
    signal: resolvedSignal,
    originalSignal: signal,
    starOfficeResult: null,
    starOfficeError: null,
    ignored: false,
    ignoreReason: null,
  }).then(async () => {
    try {
      const result = await starOfficeClient.apply(resolvedSignal);
      // Update the event log entry with the star office result
      // (the event is already persisted, the result is a side effect)
      if (result) console.log(`[bridge] star-office apply ok for ${resolvedSignal.eventName}`);
    } catch (error) {
      console.error(`[bridge] star-office apply failed for ${resolvedSignal.eventName}: ${formatError(error).message}`);
    }
  });

  return json({
    ok: true,
    signal: resolvedSignal,
    snapshot,
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

  // Stop accepting new connections — in-flight requests can still complete
  server.stop(false);

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

  // Drain window for in-flight requests
  await Bun.sleep(2000);
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 30, // Default for HTTP/WebSocket; SSE streams override per-request below
  fetch: async (request: Request, srv: any): Promise<Response | undefined> => {
    const url = new URL(request.url);

    // WebSocket upgrade for bidirectional interactive consumers
    if (url.pathname === "/ws") {
      const authed = isAuthorized(request);
      const upgraded = srv.upgrade(request, {
        data: {
          authenticated: authed,
          connectedAt: Date.now(),
          sessionId: url.searchParams.get("session") || undefined,
        },
      });
      if (upgraded) return undefined; // Bun handles 101
      return json({ ok: false, error: "websocket upgrade failed" }, { status: 400 });
    }

    const start = performance.now();

    const response = await handleRequest(request, url);
    const duration = (performance.now() - start).toFixed(1);
    console.log(`[bridge] ${request.method} ${url.pathname} ${response.status} ${duration}ms`);
    return response;
  },
  websocket: {
    open(ws) {
      const data = ws.data as unknown as { authenticated: boolean; connectedAt: number; sessionId?: string };
      console.log(`[bridge] ws client connected authed=${data.authenticated} session=${data.sessionId || "none"}`);
      // Subscribe to the event broadcast channel
      ws.subscribe("bridge-events");
      // Send initial snapshot
      const snapshot = registry.list();
      ws.send(JSON.stringify({ type: "snapshot", data: snapshot }));
    },
    async message(ws, message) {
      const data = ws.data as unknown as { authenticated: boolean };
      const text = typeof message === "string" ? message : message.toString();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "invalid json" }));
        return;
      }

      const msgType = typeof parsed.type === "string" ? parsed.type : "unknown";

      // Authenticated actions over WebSocket
      if (!data.authenticated && msgType !== "ping") {
        ws.send(JSON.stringify({ type: "error", error: "authentication required for actions" }));
        return;
      }

      switch (msgType) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          break;
        case "action": {
          // Execute a Zellij action via WebSocket (same logic as POST /action)
          const action = typeof parsed.action === "string" ? parsed.action : "";
          const args = Array.isArray(parsed.args) ? parsed.args.map(String) : [];
          const wsSession = typeof parsed.session === "string" ? parsed.session : undefined;
          if (!action || !ALLOWED_ACTIONS.has(action)) {
            ws.send(JSON.stringify({ type: "action_result", ok: false, error: "disallowed action", action }));
            return;
          }
          const session = wsSession || config.zellijSessionName || "main";
          const env = {
            ...process.env,
            ZELLIJ_SESSION_NAME: session,
            HOME: process.env.HOME || "/root",
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/0",
          };
          try {
            const proc = Bun.spawn(["zellij", "action", action, ...args], {
              stdout: "pipe",
              stderr: "pipe",
              env,
            });
            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;
            // Parse JSON output if applicable
            let parsed_output: unknown = stdout.trim();
            if (typeof parsed_output === "string" && (parsed_output.startsWith("[") || parsed_output.startsWith("{"))) {
              try { parsed_output = JSON.parse(parsed_output); } catch { /* keep as string */ }
            }
            ws.send(JSON.stringify({ type: "action_result", ok: exitCode === 0, action, args, session, exitCode, result: parsed_output || null, stderr: stderr.trim().slice(0, 1024) || null }));
          } catch (error) {
            ws.send(JSON.stringify({ type: "action_result", ok: false, action, error: String(error) }));
          }
          break;
        }
        default:
          ws.send(JSON.stringify({ type: "error", error: `unknown message type: ${msgType}` }));
      }
    },
    close(ws, code, reason) {
      const data = ws.data as unknown as { sessionId?: string };
      console.log(`[bridge] ws client disconnected code=${code} session=${data.sessionId || "none"}`);
      ws.unsubscribe("bridge-events");
    },
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

    if (request.method === "GET" && url.pathname === "/readyz") {
      // Readiness probe: returns 503 during graceful shutdown, 200 otherwise
      // Load balancers and Caddy should use this (not /healthz) to route traffic
      if (isShuttingDown) {
        return new Response("shutting down", { status: 503, headers: { "content-type": "text/plain", ...CORS_HEADERS } });
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain", ...CORS_HEADERS } });
    }

    if (request.method === "GET" && url.pathname === "/events/test") {
      const secret = config.secret || "";
      const webUrl = config.zellijWebUrl || "";
      const webToken = config.zellijWebToken || "";
      const sessionName = config.zellijSessionName || "";
      let attachUrl = "";
      if (webUrl && webToken) {
        try {
          const base = webUrl.replace(/\/$/, "");
          attachUrl = sessionName
            ? `${base.replace(/\/[^/]*$/, "")}/${sessionName}?token=${encodeURIComponent(webToken)}`
            : `${base}?token=${encodeURIComponent(webToken)}`;
        } catch {}
      }
      return new Response(`<!DOCTYPE html>
<html><head><title>Star Office Bridge — Dashboard</title>
<style>
body{font-family:monospace;margin:0;background:#1a1a2e;color:#e0e0e0;display:flex;flex-direction:column;height:100vh}
.header{padding:0.5rem 1rem;background:#0f3460;display:flex;justify-content:space-between;align-items:center}
.header h2{margin:0;font-size:1rem}
#status{color:#0f0;font-size:0.85rem}
.toolbar{display:flex;gap:0.5rem;padding:0.5rem 1rem;background:#16213e;align-items:center;flex-wrap:wrap}
.toolbar a,.toolbar button{color:#e0e0e0;background:#1a1a2e;border:1px solid #333;padding:2px 8px;font-size:0.8rem;text-decoration:none;border-radius:3px;cursor:pointer;font-family:monospace}
.toolbar a:hover,.toolbar button:hover{background:#0f3460}
#events{flex:1;white-space:pre-wrap;font-size:0.8rem;overflow-y:auto;padding:0 1rem}
.evt{padding:2px 0;border-bottom:1px solid #222}
.evt-signal{color:#7ec8e3}.evt-snapshot{color:#f0c040}.evt-gap{color:#ff6b6b}
.evt-client{color:#a0a0a0}.evt-backpressure{color:#ff4444}.evt-action{color:#9cf}.evt-other{color:#c0c0c0}
.ts{color:#555;margin-right:0.5rem}
.ws-indicator{font-size:0.75rem;padding:1px 6px;border-radius:2px}
.ws-on{background:#0a0;color:#000}.ws-off{background:#a00;color:#fff}
</style></head><body>
<div class="header"><h2>Star Office Bridge</h2><span id="status">Connecting...</span></div>
<div class="toolbar">
<a href="/health">health</a>
<a href="/snapshot">snapshot</a>
<a href="/stats">stats</a>
<a href="/help">help</a>
<a href="/web/tokens">tokens</a>
${attachUrl ? `<a href="${attachUrl}" target="_blank">zellij web</a>` : ""}
<span class="ws-indicator ws-off" id="wsBadge">WS</span>
<button onclick="wsToggle()">${secret ? "WS connect" : "WS connect (no auth)"}</button>
<button onclick="sendAction('list-tabs','--json')">list-tabs</button>
<button onclick="sendAction('list-panes')">list-panes</button>
<button onclick="tokenRefresh()" style="margin-left:auto">refresh token</button>
<span id="tokenStatus" style="font-size:0.75rem;color:#aaa">token: ${config.zellijWebToken ? "set" : "none"}</span>
</div>
<div id="events"></div>
<script>
const el=document.getElementById("events");
const st=document.getElementById("status");
const wsBadge=document.getElementById("wsBadge");
const tokenStatus=document.getElementById("tokenStatus");
const secret="${secret}";
let count=0,ws=null;
const es=new EventSource("/events");
function add(cls,text){
  const d=document.createElement("div");
  d.className="evt evt-"+cls;
  d.innerHTML='<span class="ts">'+new Date().toLocaleTimeString()+'</span>'+text;
  el.prepend(d);
  if(++count>300){const last=el.lastChild;if(last)el.removeChild(last)}
}
es.onopen=()=>{st.textContent="SSE Connected";st.style.color="#0f0"};
es.onerror=()=>{st.textContent="SSE Disconnected";st.style.color="#f00"};
es.addEventListener("snapshot",e=>{add("snapshot","SNAPSHOT "+e.data)});
es.addEventListener("signal",e=>{const d=JSON.parse(e.data);add("signal","["+d.state+"] "+d.detail+" ("+d.eventName+")")});
es.addEventListener("gap",e=>{const d=JSON.parse(e.data);add("gap","GAP "+d.gapSize+" events missed")});
es.addEventListener("client_connected",e=>{const d=JSON.parse(e.data);add("client","CLIENT #"+d.clientId+" connected ("+d.totalClients+" total)")});
es.addEventListener("client_disconnected",e=>{const d=JSON.parse(e.data);add("client","CLIENT #"+d.clientId+" disconnected ("+d.totalClients+" total)")});
es.addEventListener("backpressure",e=>{add("backpressure","BACKPRESSURE "+e.data)});
es.addEventListener("shutdown",e=>{add("other","SHUTDOWN "+e.data)});
es.addEventListener("action_executed",e=>{const d=JSON.parse(e.data);add("action","ACTION "+d.action+" exit="+d.exitCode)});
es.addEventListener("web_token_refreshed",e=>{const d=JSON.parse(e.data);tokenStatus.textContent="token: "+(d.tokenName||"refreshed");add("other","TOKEN REFRESHED "+d.tokenName)});
es.addEventListener("web_token_revoked",e=>{const d=JSON.parse(e.data);tokenStatus.textContent="token: revoked";add("other","TOKEN REVOKED "+(d.name||"all"))});
es.onmessage=e=>{add("other",e.type+": "+e.data)};
function wsToggle(){
  if(ws){ws.close();ws=null;return}
  const secret="${secret}";
  const headers=secret?{"x-bridge-secret":secret}:{};
  ws=new WebSocket((location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+"/ws",Object.keys(headers).length?{headers}:undefined);
  ws.onopen=()=>{wsBadge.className="ws-indicator ws-on";add("other","WS connected")};
  ws.onclose=()=>{wsBadge.className="ws-indicator ws-off";add("other","WS disconnected")};
  ws.onmessage=e=>{
    const d=JSON.parse(e.data);
    if(d.type==="action_result"){
      const r=typeof d.result==="string"?d.result.slice(0,300):JSON.stringify(d.result)?.slice(0,300);
      add("action","WS "+d.action+" ok="+d.ok+" "+r);
    } else if(d.type==="snapshot"){add("snapshot","WS SNAPSHOT "+JSON.stringify(d.data)?.slice(0,200))}
    else if(d.type==="pong"){add("other","WS pong")}
    else{add("other","WS "+d.type+" "+JSON.stringify(d)?.slice(0,200))}
  };
  ws.onerror=()=>{add("other","WS error")};
}
function sendAction(action,...args){
  if(!ws||ws.readyState!==1){add("other","WS not connected");return}
  ws.send(JSON.stringify({type:"action",action,args}));
}
async function tokenRefresh(){
  if(!secret){add("other","no auth secret configured");return}
  try{
    const r=await fetch("/web/token/refresh",{headers:{"x-bridge-secret":secret}});
    const d=await r.json();
    if(d.ok){
      tokenStatus.textContent="token: "+(d.tokenName||d.webToken?.slice(0,8)+"...");
      add("other","TOKEN REFRESH ok name="+d.tokenName);
      if(d.attachUrl){
        const link=document.querySelector('a[href*="token="]');
        if(link)link.href=d.attachUrl;
      }
    } else {add("other","TOKEN REFRESH failed: "+d.error)}
  }catch(e){add("other","TOKEN REFRESH error: "+e)}
}
setInterval(()=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:"ping"}))},30000);
</script></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS },
      });
    }

    if (request.method === "GET" && url.pathname === "/help") {
      return json({
        ok: true,
        version: "0.10.0",
        routes: ROUTE_TABLE,
      });
    }

    if (request.method === "GET" && url.pathname === "/version") {
      return json({
        ok: true,
        version: "0.10.0",
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
      // Bun heap stats from bun:jsc (production memory monitoring)
      let heapStats: Record<string, unknown> | null = null;
      try {
        const { heapStats: hs } = require("bun:jsc") as { heapStats: () => Record<string, unknown> };
        heapStats = hs();
      } catch {}
      return json({
        ok: true,
        uptime: process.uptime(),
        sseClients: sseClients.size,
        sseClientIds: [...sseClients.keys()],
        sseEventLogSize: sseEventLog.length,
        sessions: registry.list().length,
        heap: heapStats,
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

      const signal = mapZellijEvent(body);

      return processSignal(signal, "zellij-hook");
    }

    if (request.method === "POST" && url.pathname === "/hook/zellij/batch") {
      let events: Record<string, unknown>[];
      try {
        events = (await request.json()) as Record<string, unknown>[];
        if (!Array.isArray(events)) {
          return json({ ok: false, error: "expected JSON array" }, { status: 400 });
        }
      } catch {
        return json({ ok: false, error: "invalid json" }, { status: 400 });
      }

      const results: { index: number; ok: boolean; ignored?: boolean; reason?: string }[] = [];
      for (let i = 0; i < events.length; i++) {
        const signal = mapZellijEvent(events[i]);

        // Deduplicate inline
        const { signal: resolvedSignal } = registry.record(signal);
        const dedupeKey = `${resolvedSignal.sessionId}:${resolvedSignal.context.zellijEvent || resolvedSignal.eventName}`;
        const contextHash = JSON.stringify(resolvedSignal.context);
        const lastHash = lastSignalByKey.get(dedupeKey);
        const isDuplicate = lastHash === contextHash;
        lastSignalByKey.set(dedupeKey, contextHash);
        const stats = dedupCounts.get(dedupeKey) || { seen: 0, passed: 0 };
        stats.seen++;
        if (!isDuplicate) stats.passed++;
        dedupCounts.set(dedupeKey, stats);

        if (isDuplicate) {
          results.push({ index: i, ok: true, ignored: true, reason: "duplicate signal" });
        } else {
          broadcastSSE("signal", resolvedSignal);
          results.push({ index: i, ok: true });
        }
      }

      return json({
        ok: true,
        processed: results.length,
        results,
      });
    }

    if (request.method === "GET" && url.pathname === "/action") {
      return json({
        ok: true,
        actions: [...ALLOWED_ACTIONS].sort(),
        count: ALLOWED_ACTIONS.size,
      });
    }

    if (request.method === "GET" && url.pathname === "/web") {
      return json({
        ok: true,
        webUrl: config.zellijWebUrl || null,
        webTokenSet: config.zellijWebToken ? true : false,
        sessionName: config.zellijSessionName || null,
      });
    }

    if (request.method === "GET" && url.pathname === "/web/token/refresh") {
      if (!isAuthorized(request)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      // Run zellij web --create-token and update the in-memory config
      try {
        const env = {
          ...process.env,
          HOME: process.env.HOME || "/root",
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/0",
          ZELLIJ_SESSION_NAME: config.zellijSessionName || "",
        };
        const proc = Bun.spawn(["zellij", "web", "--create-token"], {
          stdout: "pipe",
          stderr: "pipe",
          env,
        });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          return json({
            ok: false,
            error: "zellij web --create-token failed",
            exitCode,
            stderr: stderr.trim() || null,
          }, { status: 502 });
        }

        // Parse token from output like "token_5: b5b1136b-c71d-48c3-9e91-e82e43117cc7"
        const tokenMatch = stdout.match(/(token_\d+)\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        const newToken = tokenMatch ? tokenMatch[2] : null;
        const newTokenName = tokenMatch ? tokenMatch[1] : null;

        if (newToken) {
          (config as unknown as Record<string, unknown>).zellijWebToken = newToken;
          (config as unknown as Record<string, unknown>).zellijWebTokenName = newTokenName;
          broadcastSSE("web_token_refreshed", { tokenSet: true, tokenName: newTokenName, timestamp: new Date().toISOString() });
        }

        const webUrl = config.zellijWebUrl || null;
        const sessionName = config.zellijSessionName || null;
        let attachUrl: string | null = null;
        if (webUrl && newToken) {
          try {
            const base = webUrl.replace(/\/$/, "");
            attachUrl = sessionName
              ? `${base.replace(/\/[^/]*$/, "")}/${sessionName}?token=${encodeURIComponent(newToken)}`
              : `${base}?token=${encodeURIComponent(newToken)}`;
          } catch {}
        }

        return json({
          ok: true,
          refreshed: !!newToken,
          tokenName: newTokenName,
          webUrl,
          webToken: newToken,
          sessionName,
          attachUrl,
          rawOutput: stdout.trim(),
        });
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/web/token/revoke") {
      if (!isAuthorized(request)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      let body: { name?: string; revokeAll?: boolean };
      try {
        body = (await request.json()) as { name?: string; revokeAll?: boolean };
      } catch {
        return json({ ok: false, error: "invalid json" }, { status: 400 });
      }
      try {
        const env = {
          ...process.env,
          HOME: process.env.HOME || "/root",
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/0",
        };
        if (body.revokeAll) {
          // Revoke all tokens
          const proc = Bun.spawn(["zellij", "web", "--revoke-all-tokens"], {
            stdout: "pipe", stderr: "pipe", env,
          });
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            return json({ ok: false, error: "revoke-all-tokens failed", exitCode, stderr: stderr.trim() || null }, { status: 502 });
          }
          (config as unknown as Record<string, unknown>).zellijWebToken = undefined;
          broadcastSSE("web_token_revoked", { all: true, timestamp: new Date().toISOString() });
          return json({ ok: true, revokedAll: true, rawOutput: stdout.trim() || null });
        }
        // Revoke by token name (e.g., "token_5") — NOT the UUID
        const tokenName = body.name;
        if (!tokenName) {
          return json({ ok: false, error: "missing 'name' field (use token name like 'token_5', not the UUID)" }, { status: 400 });
        }
        const proc = Bun.spawn(["zellij", "web", "--revoke-token", tokenName], {
          stdout: "pipe", stderr: "pipe", env,
        });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          return json({
            ok: false,
            error: "zellij web --revoke-token failed",
            exitCode,
            stderr: stderr.trim() || null,
          }, { status: 502 });
        }

        broadcastSSE("web_token_revoked", { name: tokenName, timestamp: new Date().toISOString() });
        return json({
          ok: true,
          revoked: tokenName,
          rawOutput: stdout.trim() || null,
        });
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/web/tokens") {
      // List token names and creation dates (no actual token values)
      if (!isAuthorized(request)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      try {
        const env = {
          ...process.env,
          HOME: process.env.HOME || "/root",
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/0",
        };
        const proc = Bun.spawn(["zellij", "web", "--list-tokens"], {
          stdout: "pipe", stderr: "pipe", env,
        });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          return json({ ok: false, error: "list-tokens failed", exitCode, stderr: stderr.trim() || null }, { status: 502 });
        }
        // Parse output like "token_1: created at 2026-04-26 06:48:42\n token_2: ..."
        const tokens = stdout.trim().split("\n").filter(Boolean).map((line: string) => {
          const match = line.match(/^(\S+):\s+created at\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(?:\s+\[(READ-ONLY)\])?/);
          if (match) return { name: match[1], createdAt: match[2], readOnly: match[3] === "READ-ONLY" };
          return { raw: line.trim() };
        });
        return json({ ok: true, tokens, activeTokenName: config.zellijWebTokenName || null });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }

    // Authenticated endpoint: returns the web token for bridge consumers
    // that need to open the Zellij web terminal programmatically
    if (request.method === "GET" && url.pathname === "/web/token") {
      if (!isAuthorized(request)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      const webUrl = config.zellijWebUrl || null;
      const webToken = config.zellijWebToken || null;
      const sessionName = config.zellijSessionName || null;
      // Construct full attach URL with token for one-click browser launch
      let attachUrl: string | null = null;
      if (webUrl && webToken) {
        try {
          const base = webUrl.replace(/\/$/, "");
          attachUrl = sessionName
            ? `${base.replace(/\/[^/]*$/, "")}/${sessionName}?token=${encodeURIComponent(webToken)}`
            : `${base}?token=${encodeURIComponent(webToken)}`;
        } catch {}
      }
      return json({
        ok: true,
        webUrl,
        webToken,
        sessionName,
        attachUrl,
      });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      // Unified overview combining health + version + web config
      let heapStats: Record<string, unknown> | null = null;
      try {
        const { heapStats: hs } = require("bun:jsc") as { heapStats: () => Record<string, unknown> };
        heapStats = hs();
      } catch {}
      return json({
        ok: true,
        version: "0.10.0",
        runtime: `bun ${Bun.version}`,
        arch: process.arch,
        platform: process.platform,
        uptime: process.uptime(),
        host: config.host,
        port: config.port,
        dryRun: config.dryRun,
        starOfficeUrl: config.starOfficeUrl || null,
        sseClients: sseClients.size,
        sseEventLogSize: sseEventLog.length,
        sessions: registry.list().length,
        heap: heapStats,
        web: {
          url: config.zellijWebUrl || null,
          tokenSet: config.zellijWebToken ? true : false,
          sessionName: config.zellijSessionName || null,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/action") {
      if (!isAuthorized(request)) {
        return json({ ok: false, error: "action endpoint requires authentication" }, { status: 401 });
      }

      let body: { action: string; args?: string[]; session?: string };
      try {
        body = (await request.json()) as { action: string; args?: string[]; session?: string };
      } catch {
        return json({ ok: false, error: "invalid json" }, { status: 400 });
      }

      if (!body.action || !ALLOWED_ACTIONS.has(body.action)) {
        return json({
          ok: false,
          error: "disallowed action",
          action: body.action,
          allowed: [...ALLOWED_ACTIONS].sort(),
        }, { status: 403 });
      }

      const session = body.session || config.zellijSessionName || "main";
      const args = body.args || [];
      const env = {
        ZELLIJ_SESSION_NAME: session,
        HOME: process.env.HOME || "/root",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/0",
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      };

      try {
        const cmd = ["zellij", "action", body.action, ...args];
        const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          return json({
            ok: false,
            action: body.action,
            args,
            session,
            exitCode,
            stderr: stderr.trim() || null,
          }, { status: 502 });
        }

        // Parse JSON output if applicable
        let parsed: unknown = stdout.trim();
        if (typeof parsed === "string" && parsed.startsWith("[")) {
          try { parsed = JSON.parse(parsed); } catch { /* keep as string */ }
        } else if (typeof parsed === "string" && parsed.startsWith("{")) {
          try { parsed = JSON.parse(parsed); } catch { /* keep as string */ }
        }

        broadcastSSE("action_executed", { action: body.action, args, session, exitCode });

        return json({
          ok: true,
          action: body.action,
          args,
          session,
          exitCode,
          result: parsed || null,
        });
      } catch (error) {
        return json({
          ok: false,
          action: body.action,
          error: error instanceof Error ? error.message : String(error),
        }, { status: 500 });
      }
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

// Route table for /help endpoint
const ROUTE_TABLE: { method: string; path: string; description: string; auth: boolean }[] = [
  { method: "POST", path: "/hook/claude", description: "Receive Claude hook events", auth: true },
  { method: "POST", path: "/hook/zellij", description: "Receive Zellij monitor events", auth: true },
  { method: "POST", path: "/hook/zellij/batch", description: "Batch Zellij events (JSON array)", auth: true },
  { method: "GET", path: "/events", description: "SSE stream for real-time subscription", auth: false },
  { method: "GET", path: "/events/recent", description: "Recent event log (sequential IDs)", auth: false },
  { method: "GET", path: "/events/log", description: "Persistent event history from events.ndjson", auth: false },
  { method: "GET", path: "/events/test", description: "HTML SSE test page", auth: false },
  { method: "POST", path: "/event/manual", description: "Submit manual events", auth: true },
  { method: "GET", path: "/health", description: "Bridge health check (JSON)", auth: false },
  { method: "GET", path: "/healthz", description: "Lightweight liveness probe (plain ok)", auth: false },
  { method: "GET", path: "/readyz", description: "Readiness probe (503 during shutdown)", auth: false },
  { method: "GET", path: "/action", description: "List allowed Zellij actions", auth: false },
  { method: "POST", path: "/action", description: "Execute Zellij CLI action (whitelisted)", auth: true },
  { method: "GET", path: "/web", description: "Zellij web config (URL, tokenSet, session)", auth: false },
  { method: "GET", path: "/web/token", description: "Zellij web token (authenticated)", auth: true },
  { method: "GET", path: "/web/token/refresh", description: "Refresh Zellij web token via CLI (authenticated)", auth: true },
  { method: "POST", path: "/web/token/revoke", description: "Revoke token by name or revoke all (authenticated)", auth: true },
  { method: "GET", path: "/web/tokens", description: "List token names and creation dates (authenticated)", auth: true },
  { method: "GET", path: "/status", description: "Unified overview (health+version+web+heap)", auth: false },
  { method: "GET", path: "/snapshot", description: "Full session state for drift correction", auth: false },
  { method: "GET", path: "/sessions", description: "Active session list", auth: false },
  { method: "GET", path: "/sessions/:id", description: "Session detail lookup", auth: false },
  { method: "GET", path: "/sessions/:id/events", description: "Per-session event history", auth: false },
  { method: "GET", path: "/stats", description: "Dedup stats, heap stats, runtime info", auth: false },
  { method: "GET", path: "/version", description: "Bridge version, runtime, arch", auth: false },
  { method: "GET", path: "/ws", description: "WebSocket for bidirectional control (upgrade)", auth: false },
  { method: "GET", path: "/help", description: "This route table", auth: false },
];

console.log(
  `[bridge] listening on http://${server.hostname}:${server.port} dryRun=${config.dryRun} starOffice=${config.starOfficeUrl || "none"}`,
);
