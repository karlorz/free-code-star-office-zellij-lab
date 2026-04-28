import { readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig, timingSafeCompare } from "./config";
import { CORS_HEADERS, isAuthorized, checkRateLimit } from "./auth";
import {
  SSE_REPLAY_CAPACITY,
  sseEventSeq, sseClientSeq, sseClients, sseEventLog,
  incrementSseEventSeq, incrementSseClientSeq,
  formatSSE, broadcastSSE, broadcastSSEWithId,
} from "./sse";
import { metrics, observeHistogram, buildPrometheusMetrics, SSE_DURATION_BUCKETS } from "./metrics";
import {
  EVENTS_LOG_MAX_BYTES, EVENTS_LOG_KEEP_ROTATED,
  getLogSink, flushLogSink, closeLogSink,
  appendEvent, appendIgnoredEvent,
} from "./eventLog";
import { zellijEnv, mapZellijEvent } from "./zellijEvents";
import { renderDashboard } from "./dashboard";
import { renderStarOffice } from "./starOfficeUI";
import { SessionRegistry } from "./sessionRegistry";
import { StarOfficeClient } from "./starOfficeClient";
import { normalizeClaudeEvent } from "./stateMapper";
import { sendAction as ipcSendAction, ping as ipcPing, listSessionSockets } from "./zellijIpc";
import type {
  BridgeErrorInfo,
  BridgeEventLogEntry,
  ClaudeBridgeEvent,
  NormalizedSignal,
} from "./types";
const BRIDGE_VERSION = "0.66.0";
const encoder = new TextEncoder();

const lastSignalByKey = new Map<string, string>();
const dedupCounts = new Map<string, { seen: number; passed: number; lastSeenAt: number }>();
const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 minutes — evict stale dedup entries
const ALERT_DEDUP_TTL_MS = 60 * 1000; // 1 minute — alert webhook dedup window
const alertDedup = new Map<string, number>(); // groupKey:status -> timestamp

const RATE_LIMIT_WINDOW = 60_000; // 1 minute — exported from auth.ts but also needed here for error messages

const ALLOWED_ACTIONS = new Set([
  "new-tab", "close-tab", "close-tab-by-id", "go-to-tab", "go-to-tab-by-id", "go-to-tab-name",
  "go-to-next-tab", "go-to-previous-tab", "rename-tab",
  "new-pane", "close-pane", "focus-next-pane", "focus-previous-pane", "focus-pane-id",
  "toggle-fullscreen", "toggle-pane-embed-or-floating", "toggle-floating-panes",
  "show-floating-panes", "hide-floating-panes",
  "move-focus", "move-focus-or-tab", "resize",
  "write", "write-chars", "send-keys", "paste", "switch-mode",
  "dump-screen", "dump-layout", "current-tab-info",
  "start-or-reload-plugin", "launch-or-focus-plugin",
  "list-clients", "list-panes", "list-tabs",
  "subscribe", "pipe",
  "scroll-up", "scroll-down", "scroll-up-half", "scroll-down-half", "scroll-to-top", "scroll-to-bottom",
  "detach", "switch-session", "rename-session", "save-session",
  "web --status", "web --create-token", "web --create-read-only-token", "web --revoke-token",
]);

// Actions eligible for direct UDS+protobuf IPC (3.6x faster than CLI spawn)
const IPC_ELIGIBLE = new Set([
  "list-tabs", "list-panes", "list-clients", "current-tab-info",
  "go-to-next-tab", "go-to-previous-tab", "close-tab", "new-tab", "rename-tab",
  "move-focus", "move-focus-or-tab", "toggle-fullscreen", "toggle-pane-frames",
  "toggle-floating-panes", "focus-next-pane", "focus-previous-pane",
  "detach", "no-op", "scroll-up", "scroll-down", "scroll-to-bottom", "scroll-to-top",
  "clear-screen", "dump-layout", "save-session", "rename-session",
  "resize", "write", "write-chars", "move-pane",
])
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
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
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
  const stats = dedupCounts.get(dedupeKey) || { seen: 0, passed: 0, lastSeenAt: Date.now() };
  stats.seen++;
  stats.lastSeenAt = Date.now();
  if (!isDuplicate) stats.passed++;
  dedupCounts.set(dedupeKey, stats);

  if (isDuplicate) {
    metrics.signalsDuplicate++;
    metrics.signalsSuppressed++;
    return json({
      ok: true,
      ignored: true,
      reason: "duplicate signal",
      signal: resolvedSignal,
      snapshot,
    });
  }

  metrics.signalsProcessed++;
  // Enrich signal with bridge operational context before broadcast
  resolvedSignal.context = {
    ...resolvedSignal.context,
    _bridge: {
      zellijSessionHealthy: metrics.zellijSessionHealthy === 1,
      zellijHealthFailures: metrics.zellijHealthConsecutiveFailures,
      zellijRecoveryAttempts: metrics.zellijRecoveryAttempts,
      zellijRecoverySuccesses: metrics.zellijRecoverySuccesses,
    },
  };
  // Process signal asynchronously after fast-ack response.
  // This prevents hook timeouts (10s) when starOfficeClient.apply() is slow.
  // The hook response is ignored by Claude Code for decision purposes anyway.
  const signalId = incrementSseEventSeq();
  broadcastSSEWithId(signalId, "signal", resolvedSignal);

  // Fire-and-forget: append to log + apply to star office
  appendEvent({
    source,
    receivedAt: new Date().toISOString(),
    sseEventSeq: signalId,
    rawEvent: rawEvent ?? null,
    signal: resolvedSignal,
    originalSignal: signal,
    starOfficeResult: null,
    starOfficeError: null,
    ignored: false,
    ignoreReason: null,
  }, config, backgroundProcs).then(async () => {
    try {
      const result = await starOfficeClient.apply(resolvedSignal);
      // Update the event log entry with the star office result
      // (the event is already persisted, the result is a side effect)
      if (result) {
        metrics.starOfficeApply++;
        console.log(`[bridge] star-office apply ok for ${resolvedSignal.eventName}`);
      }
    } catch (error) {
      metrics.starOfficeApplyFailures++;
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

// Cached heapStats — bun:jsc heapStats() costs 15-22ms; sample every 60s
let cachedHeapStats: Record<string, unknown> | null = null;
const heapStatsInterval = setInterval(() => {
  try {
    const { heapStats: hs } = require("bun:jsc") as { heapStats: () => Record<string, unknown> };
    cachedHeapStats = hs();
  } catch {}
}, 60_000);
// Initialize on startup
try {
  const { heapStats: hs } = require("bun:jsc") as { heapStats: () => Record<string, unknown> };
  cachedHeapStats = hs();
} catch {}

// Periodic sweeper: prune stale dedup entries and log summary
// Only logs when state changed since last sweep (clients, events, dedup keys)
let lastSweepSnapshot = { clients: 0, events: 0, dedupKeys: 0 };
const sweeperInterval = setInterval(() => {
  const now = Date.now();
  let evictedByTtl = 0;
  // TTL-based eviction: remove entries not seen in DEDUP_TTL_MS
  for (const [key, stats] of dedupCounts) {
    if (now - stats.lastSeenAt > DEDUP_TTL_MS) {
      dedupCounts.delete(key);
      lastSignalByKey.delete(key);
      evictedByTtl++;
      metrics.dedupEvicted++;
    }
  }
  const snapshot = { clients: sseClients.size, events: sseEventLog.length, dedupKeys: dedupCounts.size };
  const changed = snapshot.clients !== lastSweepSnapshot.clients
    || snapshot.events !== lastSweepSnapshot.events
    || snapshot.dedupKeys !== lastSweepSnapshot.dedupKeys;
  if (changed || evictedByTtl > 0) {
    console.log(`[bridge] sweep: ${snapshot.clients} clients, ${snapshot.events} events, ${snapshot.dedupKeys} dedup keys${evictedByTtl ? `, evicted ${evictedByTtl} by TTL` : ""}, seq=${sseEventSeq}`);
  }
  lastSweepSnapshot = snapshot;
  // Alert dedup cleanup: entries older than ALERT_DEDUP_TTL_MS
  for (const [key, ts] of alertDedup) {
    if (now - ts > ALERT_DEDUP_TTL_MS) alertDedup.delete(key);
  }
}, 60_000);

// Periodic log sink flush — FileSink buffers writes; flush every 5s for durability
const logFlushInterval = setInterval(() => {
  flushLogSink().catch(() => {});
}, 5_000);

// Scheduled log compaction: remove ignored entries every 6 hours
const COMPACTION_INTERVAL_MS = 6 * 3600 * 1000;
const COMPACTION_MAX_AGE_HOURS = 72; // Drop entries older than 72h during scheduled compaction
const compactionInterval = setInterval(async () => {
  try {
    console.log("[bridge] scheduled log compaction starting");
    const { readFile, writeFile, rename: renameFile } = await import("node:fs/promises");
    const content = await readFile(config.eventsLogPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const retained: string[] = [];
    let removedIgnored = 0;
    const cutoffMs = Date.now() - COMPACTION_MAX_AGE_HOURS * 3600 * 1000;
    let removedExpired = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.ignored) { removedIgnored++; continue; }
        if (entry.receivedAt && new Date(entry.receivedAt as string).getTime() < cutoffMs) {
          removedExpired++;
          continue;
        }
        retained.push(line);
      } catch { retained.push(line); }
    }
    if (removedIgnored > 0 || removedExpired > 0) {
      // Flush and close sink before overwriting the file
      await closeLogSink();
      const tmpPath = `${config.eventsLogPath}.compact.tmp`;
      await writeFile(tmpPath, retained.join("\n") + "\n", "utf8");
      await renameFile(tmpPath, config.eventsLogPath);
      console.log(`[bridge] scheduled compaction: removed ${removedIgnored} ignored, ${removedExpired} expired (>${COMPACTION_MAX_AGE_HOURS}h) (${lines.length} → ${retained.length} lines)`);
    } else {
      console.log("[bridge] scheduled compaction: no ignored or expired entries to remove");
    }
  } catch (error) {
    console.warn("[bridge] scheduled compaction failed:", formatError(error));
  }
}, COMPACTION_INTERVAL_MS);

// Periodic snapshot push: broadcasts current session state to all SSE clients
// every 60s for proactive drift correction. Long-lived connections may miss
// events due to network blips; this ensures they self-correct without reconnect.
const snapshotPushInterval = setInterval(() => {
  if (sseClients.size > 0) {
    const snapshot = registry.list();
    broadcastSSE("snapshot_sync", { sessions: snapshot, ts: Date.now() }, metrics);
  }
}, 60_000);

// Periodic zellij session health check: ping via IPC every 30s.
// Tracks consecutive failures and exposes bridge_zellij_session_healthy gauge.
// Logs transitions (healthy→unhealthy, unhealthy→healthy) only.
// On transition to unhealthy, attempts auto-recovery via zellij attach.
let zellijLastRecoveryAttempt = 0;
const ZELLIJ_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between recovery attempts

async function attemptZellijRecovery(session: string): Promise<boolean> {
  // Check if session socket is truly gone (not just a transient error)
  const sockets = listSessionSockets();
  if (sockets.includes(session)) {
    console.log(`[bridge] zellij session "${session}" socket still exists, skipping recovery (may be hung)`);
    return false;
  }

  console.log(`[bridge] attempting zellij session recovery for "${session}"...`);
  metrics.zellijRecoveryAttempts++;
  try {
    const proc = Bun.spawn({
      cmd: ["zellij", "attach", "-c", "--force-run-commands", session],
      env: zellijEnv(session, config),
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await Promise.race([proc.exited, Bun.sleep(10000).then(() => { proc.kill(); return -1; })]);
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.warn(`[bridge] zellij attach failed (exit=${exitCode}): ${stderr.slice(0, 200)}`);
      return false;
    }

    // Wait for session server to be ready, then verify with ping
    await Bun.sleep(2000);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await ipcPing(session);
        console.log(`[bridge] zellij session "${session}" recovered successfully`);
        metrics.zellijRecoverySuccesses++;
        return true;
      } catch {
        await Bun.sleep(2000);
      }
    }
    console.warn(`[bridge] zellij session "${session}" attach succeeded but ping still failing`);
    return false;
  } catch (err) {
    console.warn(`[bridge] zellij recovery spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const zellijHealthInterval = setInterval(async () => {
  if (isShuttingDown) return;
  const session = config.zellijSessionName || "main";
  try {
    await ipcPing(session);
    if (metrics.zellijSessionHealthy === 0) {
      console.log(`[bridge] zellij session "${session}" is healthy again (was unhealthy)`);
    }
    metrics.zellijSessionHealthy = 1;
    metrics.zellijHealthConsecutiveFailures = 0;
  } catch (err) {
    metrics.zellijHealthConsecutiveFailures++;
    if (metrics.zellijSessionHealthy === 1) {
      console.warn(`[bridge] zellij session "${session}" is unhealthy: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Require 3 consecutive failures before flipping gauge to 0
    if (metrics.zellijHealthConsecutiveFailures >= 3 && metrics.zellijSessionHealthy === 1) {
      metrics.zellijSessionHealthy = 0;
      console.warn(`[bridge] zellij session "${session}" marked unhealthy after ${metrics.zellijHealthConsecutiveFailures} consecutive failures`);

      // Auto-recovery: attempt zellij attach with cooldown
      const now = Date.now();
      if (now - zellijLastRecoveryAttempt > ZELLIJ_RECOVERY_COOLDOWN_MS) {
        zellijLastRecoveryAttempt = now;
        attemptZellijRecovery(session).catch(() => {});
      }
    }
  }
}, 30_000);

// Periodic save-session via IPC: trigger zellij serialization every 60s
// to keep resurrection data fresh. Only runs when session is healthy.
let zellijLastSaveAt: number | null = null;
const zellijSaveInterval = setInterval(async () => {
  if (isShuttingDown || metrics.zellijSessionHealthy === 0) return;
  const session = config.zellijSessionName || "main";
  try {
    await ipcSendAction(session, "save-session");
    metrics.zellijSaveSuccesses++;
    zellijLastSaveAt = Date.now();
  } catch {
    metrics.zellijSaveFailures++;
    // Non-critical — session will auto-serialize periodically anyway
  }
}, 60_000);

// WebSocket client state for heartbeat zombie detection
const wsClientState = new Map<any, { lastActivity: number; pingSent: boolean }>();

// WebSocket heartbeat: detect zombie connections that silently dropped TCP.
// Bun's idleTimeout=0 + sendPings=false (workaround for #26554) means the server
// never probes client liveness. This interval sends app-level pings to idle WS
// clients and closes those that haven't responded within 60s of the first ping.
const wsHeartbeatInterval = setInterval(() => {
  if (isShuttingDown) return;
  const now = Date.now();
  for (const [ws, state] of wsClientState) {
    const idleMs = now - state.lastActivity;
    if (idleMs > 90_000) {
      // No activity for 90s — close as zombie
      console.warn(`[bridge] closing zombie WS client (idle ${Math.round(idleMs / 1000)}s, pingSent=${state.pingSent})`);
      ws.close(4001, "heartbeat timeout");
      wsClientState.delete(ws);
      metrics.wsClientTimeouts++;
    } else if (idleMs > 45_000 && !state.pingSent) {
      // Idle for 45s — send application ping
      try { ws.send(JSON.stringify({ type: "ping", ts: now })); } catch {}
      state.pingSent = true;
    }
  }
}, 30_000);

let isShuttingDown = false;

// Track background subprocesses for clean shutdown
const backgroundProcs: Bun.Subprocess[] = [];

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[bridge] received ${signal}, draining ${sseClients.size} SSE clients, ${metrics.wsClientsCurrent} WS clients...`);

  // Notify systemd we're stopping — allows ordered dependency shutdown
  sdNotify("--stopping");

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

  // Send close frames to WebSocket clients — Bun doesn't auto-send on exit
  try {
    server.publish("bridge-events", JSON.stringify({ type: "shutdown", reason: signal }));
  } catch {}
  // Note: Bun's server.stop() handles WebSocket connection cleanup internally
  clearInterval(keepAliveInterval);
  clearInterval(sweeperInterval);
  clearInterval(snapshotPushInterval);
  clearInterval(logFlushInterval);
  clearInterval(heapStatsInterval);
  clearInterval(compactionInterval);
  clearInterval(zellijHealthInterval);
  clearInterval(zellijSaveInterval);
  clearInterval(wsHeartbeatInterval);

  // Drain window for in-flight requests
  await Bun.sleep(2000);

  // Clean up background subprocesses (zstd compression, etc.)
  if (backgroundProcs.length > 0) {
    console.log(`[bridge] terminating ${backgroundProcs.length} background subprocesses...`);
    for (const proc of backgroundProcs) {
      try { proc.kill("SIGTERM"); } catch {}
    }
    await Promise.race([
      Promise.allSettled(backgroundProcs.map(p => p.exited)),
      Bun.sleep(5000),
    ]);
    backgroundProcs.length = 0;
  }

  // Flush and close log sink before persisting metrics
  await flushLogSink();
  await closeLogSink();

  // Persist final metrics snapshot before exit
  try {
    const metricsPath = join(dirname(config.eventsLogPath), "shutdown-metrics.json");
    const { writeFile } = await import("node:fs/promises");
    const snapshot = {
      shutdownAt: new Date().toISOString(),
      reason: signal,
      uptime: process.uptime(),
      finalMetrics: {
        sseBroadcasts: metrics.sseBroadcasts,
        sseClientConnected: metrics.sseClientConnected,
        sseClientDisconnected: metrics.sseClientDisconnected,
        sseClientEvicted: metrics.sseClientEvicted,
        sseReplayRequests: metrics.sseReplayRequests,
        sseReplaySuccesses: metrics.sseReplaySuccesses,
        sseReplayGaps: metrics.sseReplayGaps,
        signalsProcessed: metrics.signalsProcessed,
        signalsDuplicate: metrics.signalsDuplicate,
        signalsSuppressed: metrics.signalsSuppressed,
        actionsExecuted: metrics.actionsExecuted,
        tokenRefreshes: metrics.tokenRefreshes,
        tokenRevocations: metrics.tokenRevocations,
        rateLimitRejections: metrics.rateLimitRejections,
        wsConnections: metrics.wsConnections,
        wsMessages: metrics.wsMessages,
      },
    };
    await writeFile(metricsPath, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(`[bridge] shutdown metrics written to ${metricsPath}`);
  } catch {}

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Crash handlers: log and exit rather than continuing in corrupted state
process.on("uncaughtException", (error) => {
  console.error("[bridge] uncaught exception (exiting):", error);
  gracefulShutdown("uncaughtException").catch(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  console.error("[bridge] unhandled rejection:", reason);
});

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  reusePort: false, // SO_REUSEPORT only useful for multi-process; single service gains nothing
  idleTimeout: 30, // Default for HTTP request timeout; SSE uses server.timeout(req,0) per-request
  fetch: async (request: Request, srv: any): Promise<Response | undefined> => {
    const url = new URL(request.url);

    // WebSocket upgrade for bidirectional interactive consumers
    if (url.pathname === "/ws") {
      // Origin validation: prevent Cross-Site WebSocket Hijacking (CSWSH/OWASP)
      const origin = request.headers.get("origin");
      const allowedOrigins = config.zellijWebUrl
        ? [new URL(config.zellijWebUrl).origin, `https://${new URL(config.zellijWebUrl).hostname}`]
        : [];
      const localOrigins = ["http://localhost:4317", "http://127.0.0.1:4317"];
      const allAllowed = new Set([...allowedOrigins, ...localOrigins]);
      if (origin && !allAllowed.has(origin)) {
        return json({ ok: false, error: "origin not allowed" }, { status: 403 });
      }

      // Browser WebSocket API doesn't support custom headers, so accept secret
      // via query parameter as fallback: /ws?secret=xxx
      const headerSecret = request.headers.get("x-bridge-secret");
      const querySecret = url.searchParams.get("secret");
      const authed = isAuthorized(request, config) || (config.secret && querySecret && timingSafeCompare(querySecret, config.secret));
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
    const duration = performance.now() - start;
    // Track metrics
    const pathKey = url.pathname;
    metrics.httpRequestsTotal.set(pathKey, (metrics.httpRequestsTotal.get(pathKey) || 0) + 1);
    const statusKey = `${pathKey}:${response.status}`;
    metrics.httpResponsesTotal.set(statusKey, (metrics.httpResponsesTotal.get(statusKey) || 0) + 1);
    observeHistogram(pathKey, duration);
    // Suppress noisy log lines for health/metrics probes (polled every 15-30s)
    const SILENT_PATHS = new Set(["/healthz", "/metrics", "/metrics/combined"]);
    if (!SILENT_PATHS.has(pathKey)) {
      console.log(`[bridge] ${request.method} ${url.pathname} ${response.status} ${duration.toFixed(1)}ms`);
    }
    return response;
  },
  websocket: {
    maxPayloadLength: 65536, // 64KB max WS message (default 16MB is too generous for action commands)
    idleTimeout: 0, // Disable Bun's idleTimeout for WS — Bun #26554: sendPings+idleTimeout kills long-lived connections
    sendPings: false, // Disabled: use application-level ping/pong instead (avoids Bun #26554)
    backpressureLimit: 1024 * 1024, // 1MB buffered per client before close — prevents slow clients from consuming unbounded memory
    closeOnBackpressureLimit: true, // Drop clients that can't keep up (fire-and-forget publish() has no retry)
    open(ws) {
      const data = ws.data as unknown as { authenticated: boolean; connectedAt: number; sessionId?: string };
      console.log(`[bridge] ws client connected authed=${data.authenticated} session=${data.sessionId || "none"} total=${server.subscriberCount("bridge-events") + 1}`); // secret param intentionally omitted from log
      metrics.wsConnections++;
      metrics.wsClientsCurrent++;
      // Track for heartbeat zombie detection
      wsClientState.set(ws, { lastActivity: Date.now(), pingSent: false });
      // Subscribe to the event broadcast channel
      ws.subscribe("bridge-events");
      // Send initial snapshot with connection metadata
      const snapshot = registry.list();
      ws.send(JSON.stringify({ type: "snapshot", data: snapshot, connectedAt: data.connectedAt, authenticated: data.authenticated }));
    },
    async message(ws, message) {
      const data = ws.data as unknown as { authenticated: boolean };
      metrics.wsMessages++;
      // Update heartbeat activity tracker
      const hbState = wsClientState.get(ws);
      if (hbState) { hbState.lastActivity = Date.now(); hbState.pingSent = false; }
      const text = typeof message === "string" ? message : message.toString();
      // Reject oversized messages (prevent abuse)
      if (text.length > 65536) {
        ws.send(JSON.stringify({ type: "error", error: "message too large (max 64KB)" }));
        return;
      }
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
        case "recover": {
          // Manual zellij session recovery via WebSocket
          if (metrics.zellijSessionHealthy === 1) {
            ws.send(JSON.stringify({ type: "recover_result", ok: true, recovered: false, reason: "session already healthy" }));
            break;
          }
          zellijLastRecoveryAttempt = 0; // reset cooldown
          try {
            const session = config.zellijSessionName || "main";
            const success = await attemptZellijRecovery(session);
            ws.send(JSON.stringify({ type: "recover_result", ok: true, recovered: success, session }));
          } catch (err) {
            ws.send(JSON.stringify({ type: "recover_result", ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          break;
        }
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
          try {
            // Fast path: IPC for eligible actions
            if (IPC_ELIGIBLE.has(action) && metrics.zellijSessionHealthy === 1) {
              try {
                const responses = await ipcSendAction(session, action, args);
                let stdout = "";
                for (const r of responses) {
                  if ("log" in r && (r as Record<string, unknown>).log) {
                    const logObj = (r as Record<string, unknown>).log as Record<string, unknown>;
                    if (Array.isArray(logObj.lines)) {
                      stdout = (logObj.lines as string[]).join("");
                    }
                  }
                }
                let parsed_output: unknown = stdout.trim();
                if (typeof parsed_output === "string" && (parsed_output.startsWith("[") || parsed_output.startsWith("{"))) {
                  try { parsed_output = JSON.parse(parsed_output); } catch { /* keep as string */ }
                }
                metrics.actionsExecuted++;
                metrics.ipcActions.set(action, (metrics.ipcActions.get(action) || 0) + 1);
                ws.send(JSON.stringify({ type: "action_result", ok: true, action, args, session, exitCode: 0, result: parsed_output || null, via: "ipc" }));
                break;
              } catch {
                // IPC failed — fall through to CLI spawn
              }
            }
            // Slow path: CLI spawn
            const env = zellijEnv(session, config);
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
            metrics.actionsExecuted++;
            metrics.cliActions.set(action, (metrics.cliActions.get(action) || 0) + 1);
            ws.send(JSON.stringify({ type: "action_result", ok: exitCode === 0, action, args, session, exitCode, result: parsed_output || null, stderr: stderr.trim().slice(0, 1024) || null, via: "cli" }));
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
      const data = ws.data as unknown as { sessionId?: string; connectedAt: number };
      const connDuration = data.connectedAt ? ((Date.now() - data.connectedAt) / 1000).toFixed(1) : "?";
      console.log(`[bridge] ws client disconnected code=${code} session=${data.sessionId || "none"} duration=${connDuration}s`);
      metrics.wsClientsCurrent--;
      metrics.wsDisconnects++;
      // Track backpressure drops separately from normal disconnects
      if (code === 1018 || (code >= 4000 && code <= 4003)) {
        metrics.wsBackpressureDrops++;
      }
      wsClientState.delete(ws);
      ws.unsubscribe("bridge-events");
    },
    // drain handler: called when a previously-backpressured socket is ready to send again
    // ws.send() returns -1 when buffer is full; Bun calls drain when space is available
    drain(ws) {
      // No buffered messages to retry — we use fire-and-forget publish()
      // Future: if we add per-client buffered queue, flush it here
    },
    // error handler: Bun doesn't expose this in WebSocketHandler types yet,
    // but catching unhandled errors prevents silent connection drops
    // @ts-expect-error — Bun supports error handler but types lag behind
    error(ws: any, error: unknown) {
      const data = ws.data as unknown as { sessionId?: string };
      console.error(`[bridge] ws error session=${data.sessionId || "none"}: ${error instanceof Error ? error.message : String(error)}`);
      metrics.wsDisconnects++;
      wsClientState.delete(ws);
      ws.unsubscribe("bridge-events");
    },
  },
});

async function handleRequest(request: Request, url: URL): Promise<Response> {
    // Rate limit POST endpoints
    if (request.method === "POST") {
      const limited = checkRateLimit(request);
      if (limited) {
        metrics.rateLimitRejections++;
        return json({ ok: false, error: "rate limited", retryAfterMs: RATE_LIMIT_WINDOW }, { status: 429 });
      }
    }

    // Alertmanager webhook — must be before global POST auth check (Alertmanager cannot send custom headers)
    if (request.method === "POST" && url.pathname === "/alert") {
      // Return 503 during shutdown so Alertmanager retries delivery
      if (isShuttingDown) {
        return json({ ok: false, error: "shutting down" }, { status: 503 });
      }
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return json({ ok: false, error: "invalid json" }, { status: 400 });
      }
      const status = body.status as string || "unknown";
      const alerts = (body.alerts || []) as Record<string, unknown>[];

      // Idempotency: skip duplicate alert notifications within 60s window
      const dedupKey = `${body.groupKey || "none"}:${status}`;
      const dedupEntry = alertDedup.get(dedupKey);
      if (dedupEntry && Date.now() - dedupEntry < ALERT_DEDUP_TTL_MS) {
        return json({ ok: true, broadcast: false, reason: "dedup" });
      }
      alertDedup.set(dedupKey, Date.now());

      const summary = {
        status,
        alertCount: alerts.length,
        alerts: alerts.map(a => ({
          status: a.status,
          labels: a.labels,
          annotations: a.annotations,
          startsAt: a.startsAt,
          endsAt: a.endsAt,
        })),
        externalURL: body.externalURL,
        groupKey: body.groupKey,
        receiver: body.receiver,
        _bridge: {
          zellijSessionHealthy: metrics.zellijSessionHealthy === 1,
          zellijHealthFailures: metrics.zellijHealthConsecutiveFailures,
          zellijRecoveryAttempts: metrics.zellijRecoveryAttempts,
          zellijRecoverySuccesses: metrics.zellijRecoverySuccesses,
          zellijLastRecoveryAttempt: zellijLastRecoveryAttempt || null,
        },
      };
      broadcastSSE("alert", summary, metrics);
      metrics.alertsReceived++;
      console.log(`[bridge] alert webhook: status=${status} count=${alerts.length}`);
      return json({ ok: true, broadcast: true });
    }

    if (!isAuthorized(request, config) && request.method !== "GET"
        && url.pathname !== "/hook/zellij" && url.pathname !== "/hook/zellij/batch") {
      return json({ ok: false, error: "unauthorized" }, { status: 401, headers: CORS_HEADERS });
    }

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/events") {
      server.timeout(request, 0);
      const lastEventId = request.headers.get("Last-Event-ID");
      const clientId = incrementSseClientSeq();
      const stream = new ReadableStream({
        start(controller) {
          sseClients.set(clientId, { controller, buffered: 0, connectedAt: Date.now() });
          metrics.sseClientConnected++;
          // Notify other clients about new connection
          broadcastSSE("client_connected", { clientId, totalClients: sseClients.size }, metrics);
          // Send full snapshot on connect so new clients have current state
          const snapshot = registry.list();
          try {
            controller.enqueue(formatSSE({ ...snapshot, _clientId: clientId }, "snapshot", incrementSseEventSeq()));
          } catch {
            sseClients.delete(clientId);
            return;
          }
          // Replay recent events to new clients if they send Last-Event-ID
          if (lastEventId) {
            const requestedId = Number(lastEventId);
            if (!isNaN(requestedId)) {
              metrics.sseReplayRequests++;
              // O(1) replay index: since IDs are sequential integers, compute directly
              const oldestId = sseEventLog.length > 0 ? sseEventLog[0].id : sseEventSeq + 1;
              const replayIndex = requestedId >= oldestId ? requestedId - oldestId : -1;
              if (replayIndex >= 0 && replayIndex < sseEventLog.length) {
                metrics.sseReplaySuccesses++;
                // Found the event — replay everything after it (skip ephemeral client events)
                for (const entry of sseEventLog.slice(replayIndex + 1)) {
                  if (entry.event === "client_connected" || entry.event === "client_disconnected" || entry.event === "snapshot") continue;
                  try {
                    controller.enqueue(formatSSE(entry.payload, entry.event, entry.id));
                  } catch {
                    sseClients.delete(clientId);
                    return;
                  }
                }
              } else {
                metrics.sseReplayGaps++;
                // Stale Last-Event-ID: event older than ring buffer — send gap notification
                const gapStart = requestedId;
                const gapEnd = sseEventLog.length > 0 ? sseEventLog[0].id - 1 : sseEventSeq;
                const gapSize = gapEnd - gapStart;
                try {
                  controller.enqueue(formatSSE({
                    gapStart,
                    gapEnd,
                    gapSize,
                    suggestion: `replay unavailable for events ${gapStart}-${gapEnd} — use /events/log?after_seq=${gapStart} for persistent log catch-up`,
                  }, "gap", incrementSseEventSeq()));
                } catch {
                  sseClients.delete(clientId);
                  return;
                }
              }
            }
          }
          request.signal.addEventListener("abort", () => {
            // Bun may fire abort twice on disconnect — guard against double cleanup
            if (!sseClients.has(clientId)) return;
            const client = sseClients.get(clientId);
            if (client) {
              // Record SSE connection duration
              const durationSec = (Date.now() - client.connectedAt) / 1000;
              metrics.sseClientDurationCount++;
              metrics.sseClientDurationSum += durationSec;
              for (const b of SSE_DURATION_BUCKETS) {
                if (durationSec <= b) {
                  metrics.sseClientDurationMs.set(`le="${b}"`, (metrics.sseClientDurationMs.get(`le="${b}"`) || 0) + 1);
                }
              }
              metrics.sseClientDurationMs.set('le="+Inf"', (metrics.sseClientDurationMs.get('le="+Inf"') || 0) + 1);
            }
            sseClients.delete(clientId);
            metrics.sseClientDisconnected++;
            broadcastSSE("client_disconnected", { clientId, totalClients: sseClients.size }, metrics);
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
      const mem = process.memoryUsage();
      return json({
        ok: true,
        version: BRIDGE_VERSION,
        host: config.host,
        port: config.port,
        dryRun: config.dryRun,
        starOfficeUrl: config.starOfficePublicUrl || config.starOfficeUrl || null,
        sseClients: sseClients.size,
        wsClients: metrics.wsClientsCurrent,
        pendingRequests: server.pendingRequests,
        pendingWebSockets: server.pendingWebSockets,
        sseEventLogSize: sseEventLog.length,
        sessions: registry.list().length,
        sseClientIds: [...sseClients.keys()],
        uptime: process.uptime(),
        memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
        processMemoryRssMb: Math.round(mem.rss / 1024 / 1024),
        dedupEntries: dedupCounts.size,
        zellijSessionHealthy: metrics.zellijSessionHealthy === 1,
        zellijHealthFailures: metrics.zellijHealthConsecutiveFailures,
        zellijRecoveryAttempts: metrics.zellijRecoveryAttempts,
        zellijRecoverySuccesses: metrics.zellijRecoverySuccesses,
        zellijLastRecoveryAttempt: zellijLastRecoveryAttempt || null,
        zellijSaveSuccesses: metrics.zellijSaveSuccesses,
        zellijSaveFailures: metrics.zellijSaveFailures,
        zellijLastSaveAt: zellijLastSaveAt || null,
        ipcActions: Object.fromEntries(metrics.ipcActions),
        cliActions: Object.fromEntries(metrics.cliActions),
        isShuttingDown,
      });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain", ...CORS_HEADERS } });
    }

    if (request.method === "GET" && url.pathname === "/readyz") {
      // Readiness probe: 503 during graceful shutdown or if zellij session is down
      // Load balancers and Caddy should use this (not /healthz) to route traffic
      // Startup grace: don't report zellij unhealthy until bridge has been up 30s+
      // (avoids false 503 during initial health check cycle)
      if (isShuttingDown) {
        return new Response("shutting down", { status: 503, headers: { "content-type": "text/plain", ...CORS_HEADERS } });
      }
      const startupGraceExpired = process.uptime() > 30;
      if (startupGraceExpired && metrics.zellijSessionHealthy === 0) {
        return new Response("zellij session unhealthy", { status: 503, headers: { "content-type": "text/plain", ...CORS_HEADERS } });
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain", ...CORS_HEADERS } });
    }

    if (request.method === "GET" && url.pathname === "/events/test") {
      return renderStarOffice(config);
    }

    if (request.method === "GET" && url.pathname === "/help") {
      return json({
        ok: true,
        version: BRIDGE_VERSION,
        routes: ROUTE_TABLE,
      });
    }

    if (request.method === "GET" && url.pathname === "/dashboard") {
      return renderDashboard(config);
    }

    if (request.method === "GET" && url.pathname === "/version") {
      return json({
        ok: true,
        version: BRIDGE_VERSION,
        runtime: `bun ${Bun.version}`,
        arch: process.arch,
        platform: process.platform,
        uptime: process.uptime(),
      });
    }

    if (request.method === "POST" && url.pathname === "/debug/gc") {
      if (!isAuthorized(request, config)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      const before = process.memoryUsage();
      const force = url.searchParams.get("force") === "true";
      const shrink = url.searchParams.get("shrink") !== "false"; // default true
      // Bun.gc(true) forces synchronous full GC + mimalloc purge (returns OS pages)
      // Bun.gc() or Bun.gc(false) only does incremental GC — doesn't reduce RSS
      // Bun.shrink() only trims ArrayBuffer buffers, does NOT shrink heap or return pages
      if (force) {
        Bun.gc(true); // Full GC + mimalloc purge for maximum RSS reduction
      } else {
        Bun.gc(false);
      }
      if (shrink) Bun.shrink();
      const after = process.memoryUsage();
      metrics.gcTriggers++;
      console.log(`[bridge] manual gc triggered force=${force} shrink=${shrink} rss: ${before.rss} → ${after.rss} heapUsed: ${before.heapUsed} → ${after.heapUsed}`);
      return json({
        ok: true,
        force,
        shrink,
        before: { rss: before.rss, heapUsed: before.heapUsed, heapTotal: before.heapTotal },
        after: { rss: after.rss, heapUsed: after.heapUsed, heapTotal: after.heapTotal },
        freedHeap: before.heapUsed - after.heapUsed,
        freedRss: before.rss - after.rss,
      });
    }

    // POST /recover — manually trigger zellij session recovery
    if (request.method === "POST" && url.pathname === "/recover") {
      if (!isAuthorized(request, config)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      const session = url.searchParams.get("session") || config.zellijSessionName || "main";
      if (metrics.zellijSessionHealthy === 1) {
        return json({ ok: true, recovered: false, reason: "session already healthy" });
      }
      // Reset cooldown to allow immediate attempt
      zellijLastRecoveryAttempt = 0;
      try {
        const success = await attemptZellijRecovery(session);
        return json({ ok: true, recovered: success, session });
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/debug/heap-snapshot") {
      if (!isAuthorized(request, config)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      try {
        const v8 = require("node:v8") as typeof import("node:v8");
        const snapshotPath = `/tmp/bridge-heap-${Date.now()}.heapsnapshot`;
        const written = v8.writeHeapSnapshot(snapshotPath);
        console.log(`[bridge] heap snapshot written to ${written}`);
        return json({ ok: true, path: written, note: "Load in Chrome DevTools > Memory tab" });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/debug/reload") {
      if (!isAuthorized(request, config)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      try {
        server.reload({
          fetch: server.fetch,  // Re-read current handler (no-op for now, but enables future hot config swap)
        });
        console.log(`[bridge] server.reload() called — handlers swapped, connections preserved`);
        return json({ ok: true, message: "handlers reloaded, SSE/WS connections preserved" });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/diagnostics") {
      if (!isAuthorized(request, config)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      const diag: Record<string, unknown> = {
        ok: true,
        timestamp: new Date().toISOString(),
        bridge: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          sseClients: sseClients.size,
          sseEventLogSize: sseEventLog.length,
          sessions: registry.list().length,
          zellijSessionHealthy: metrics.zellijSessionHealthy === 1,
          zellijHealthFailures: metrics.zellijHealthConsecutiveFailures,
          zellijRecoveryAttempts: metrics.zellijRecoveryAttempts,
          zellijRecoverySuccesses: metrics.zellijRecoverySuccesses,
          zellijLastRecoveryAttempt: zellijLastRecoveryAttempt || null,
          isShuttingDown,
        },
      };
      // Detect stale zellij pipe processes
      try {
        const pipeProc = Bun.spawn(["pgrep", "-af", "zellij pipe"], {
          stdout: "pipe", stderr: "pipe",
          env: zellijEnv(undefined, config),
        });
        const pipeOutput = await new Response(pipeProc.stdout).text();
        const pipeExit = await pipeProc.exited;
        const pipeLines = pipeOutput.trim().split("\n").filter(Boolean);
        const stalePipes = pipeLines.filter(l =>
          l.includes("push_state") && l.includes("init") && !l.includes("zellij-subscribe")
        );
        diag.staleZellijPipes = {
          totalPipeProcesses: pipeLines.length,
          staleInitPipes: stalePipes.length,
          details: stalePipes.slice(0, 10),
        };
      } catch {
        diag.staleZellijPipes = { error: "pgrep unavailable" };
      }
      // Check events log size
      try {
        const logStat = await stat(config.eventsLogPath);
        diag.eventsLog = {
          path: config.eventsLogPath,
          sizeBytes: logStat.size,
          sizeMB: Number((logStat.size / 1024 / 1024).toFixed(2)),
          maxMB: EVENTS_LOG_MAX_BYTES / 1024 / 1024,
          rotationNeeded: logStat.size > EVENTS_LOG_MAX_BYTES,
        };
      } catch {
        diag.eventsLog = { path: config.eventsLogPath, exists: false };
      }
      // Dedup summary
      const totalSeen = [...dedupCounts.values()].reduce((sum, s) => sum + s.seen, 0);
      const totalPassed = [...dedupCounts.values()].reduce((sum, s) => sum + s.passed, 0);
      diag.dedupSummary = {
        keysTracked: dedupCounts.size,
        totalSeen,
        totalPassed,
        suppressionRate: totalSeen > 0 ? Number(((1 - totalPassed / totalSeen) * 100).toFixed(1)) : 0,
      };
      return json(diag);
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
      let heapStats: Record<string, unknown> | null = cachedHeapStats;
      // Build Prometheus exposition format for /metrics endpoint reuse
      const prometheusLines = buildPrometheusMetrics({
        sseClientsSize: sseClients.size,
        sseEventLogLength: sseEventLog.length,
        sessionsCount: registry.list().length,
        dedupCountsSize: dedupCounts.size,
        registryList: () => registry.list(),
        cachedHeapStats,
        serverPendingRequests: server.pendingRequests,
        serverPendingWebSockets: server.pendingWebSockets,
        version: BRIDGE_VERSION,
      });
      return json({
        ok: true,
        uptime: process.uptime(),
        sseClients: sseClients.size,
        sseClientIds: [...sseClients.keys()],
        sseEventLogSize: sseEventLog.length,
        sessions: registry.list().length,
        heap: heapStats,
        metrics: {
          httpRequestsTotal: Object.fromEntries(metrics.httpRequestsTotal),
          httpResponsesTotal: Object.fromEntries(metrics.httpResponsesTotal),
          sseBroadcasts: metrics.sseBroadcasts,
          sseClientConnected: metrics.sseClientConnected,
          sseClientDisconnected: metrics.sseClientDisconnected,
          sseClientEvicted: metrics.sseClientEvicted,
          sseReplayRequests: metrics.sseReplayRequests,
          sseReplaySuccesses: metrics.sseReplaySuccesses,
          sseReplayGaps: metrics.sseReplayGaps,
          signalsProcessed: metrics.signalsProcessed,
          signalsDuplicate: metrics.signalsDuplicate,
          signalsSuppressed: metrics.signalsSuppressed,
          actionsExecuted: metrics.actionsExecuted,
          alertsReceived: metrics.alertsReceived,
          tokenRefreshes: metrics.tokenRefreshes,
          tokenRevocations: metrics.tokenRevocations,
          rateLimitRejections: metrics.rateLimitRejections,
          wsConnections: metrics.wsConnections,
          wsDisconnects: metrics.wsDisconnects,
          wsMessages: metrics.wsMessages,
          wsClientsCurrent: metrics.wsClientsCurrent,
        },
        dedup: {
          totalSeen,
          totalPassed,
          totalSuppressed: totalSeen - totalPassed,
          keysTracked: dedupCounts.size,
          perKey: dedupEntries,
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/metrics") {
      return new Response(buildPrometheusMetrics({
        sseClientsSize: sseClients.size,
        sseEventLogLength: sseEventLog.length,
        sessionsCount: registry.list().length,
        dedupCountsSize: dedupCounts.size,
        registryList: () => registry.list(),
        cachedHeapStats,
        serverPendingRequests: server.pendingRequests,
        serverPendingWebSockets: server.pendingWebSockets,
        version: BRIDGE_VERSION,
      }), {
        headers: {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          ...CORS_HEADERS,
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/metrics/caddy") {
      // Proxy Caddy's built-in Prometheus metrics from admin API
      try {
        const caddyResp = await fetch("http://127.0.0.1:2019/metrics", { signal: AbortSignal.timeout(3000) });
        const body = await caddyResp.text();
        return new Response(body, {
          headers: {
            "content-type": "text/plain; version=0.0.4; charset=utf-8",
            ...CORS_HEADERS,
          },
        });
      } catch {
        return json({ ok: false, error: "caddy admin api unreachable" }, { status: 502 });
      }
    }

    if (request.method === "GET" && url.pathname === "/metrics/combined") {
      // Merge bridge + caddy metrics into single Prometheus scrape target
      try {
        const bridgeMetrics = buildPrometheusMetrics({
        sseClientsSize: sseClients.size,
        sseEventLogLength: sseEventLog.length,
        sessionsCount: registry.list().length,
        dedupCountsSize: dedupCounts.size,
        registryList: () => registry.list(),
        cachedHeapStats,
        serverPendingRequests: server.pendingRequests,
        serverPendingWebSockets: server.pendingWebSockets,
        version: BRIDGE_VERSION,
      });
        let caddyMetrics = "";
        try {
          const caddyResp = await fetch("http://127.0.0.1:2019/metrics", { signal: AbortSignal.timeout(3000) });
          caddyMetrics = await caddyResp.text();
        } catch {}
        const separator = caddyMetrics ? "\n# Caddy reverse proxy metrics\n" : "\n# Caddy metrics unavailable\n";
        return new Response(bridgeMetrics + separator + caddyMetrics, {
          headers: {
            "content-type": "text/plain; version=0.0.4; charset=utf-8",
            ...CORS_HEADERS,
          },
        });
      } catch {
        return json({ ok: false, error: "failed to combine metrics" }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/events/recent") {
      const afterId = url.searchParams.get("after_id");
      let events = sseEventLog;
      if (afterId) {
        const requestedId = Number(afterId);
        if (!isNaN(requestedId)) {
          // O(1) index computation for sequential integer IDs
          const oldestId = sseEventLog.length > 0 ? sseEventLog[0].id : sseEventSeq + 1;
          const afterIndex = requestedId >= oldestId ? requestedId - oldestId : -1;
          if (afterIndex >= 0 && afterIndex < sseEventLog.length) {
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

    if (request.method === "GET" && url.pathname === "/events/log/tail") {
      // Efficient tail of the events log: reads only the last N lines
      // by scanning backwards from EOF. No full-file read needed.
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      try {
        const { open } = await import("node:fs/promises");
        const fileHandle = await open(config.eventsLogPath);
        const fileStat = await fileHandle.stat();
        const fileSize = fileStat.size;
        if (fileSize === 0) {
          await fileHandle.close();
          return json({ ok: true, count: 0, entries: [] });
        }
        // Read last chunk: estimate ~1KB per NDJSON line, read generous buffer
        const readSize = Math.min(fileSize, limit * 2048 + 4096);
        const offset = Math.max(0, fileSize - readSize);
        const { createReadStream } = await import("node:fs");
        const { createInterface } = await import("node:readline");
        const entries: Record<string, unknown>[] = [];
        const stream = createReadStream(config.eventsLogPath, { start: offset, encoding: "utf8" });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        let lineCount = 0;
        for await (const line of rl) {
          if (!line.trim()) continue;
          lineCount++;
          // If we started mid-file, skip partial first line
          if (offset > 0 && lineCount === 1 && !line.startsWith("{")) continue;
          try {
            const entry = JSON.parse(line);
            entries.push(entry);
          } catch { /* skip malformed */ }
        }
        // Take only the last N entries
        const tailEntries = entries.slice(-limit);
        return json({
          ok: true,
          count: tailEntries.length,
          fileSize,
          entries: tailEntries,
        });
      } catch {
        return json({ ok: true, count: 0, entries: [] });
      }
    }

    if (request.method === "GET" && url.pathname === "/events/log") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      const afterSeq = url.searchParams.get("after_seq") ? Number(url.searchParams.get("after_seq")) : undefined;
      const sourceFilter = url.searchParams.get("source") || undefined;
      const eventTypeFilter = url.searchParams.get("event_type") || undefined;

      // Fast path: no filters, no after_seq → use efficient tail read
      if (!afterSeq && !sourceFilter && !eventTypeFilter) {
        try {
          const { createReadStream } = await import("node:fs");
          const { createInterface } = await import("node:readline");
          const entries: Record<string, unknown>[] = [];
          const stream = createReadStream(config.eventsLogPath, { encoding: "utf8" });
          const rl = createInterface({ input: stream, crlfDelay: Infinity });
          for await (const line of rl) {
            if (!line.trim()) continue;
            try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
          }
          return json({
            ok: true,
            count: entries.length,
            entries: entries.slice(-limit),
          });
        } catch {
          return json({ ok: true, count: 0, entries: [] });
        }
      }

      // Slow path: filters or after_seq require full read + rotated files
      try {
        const { readFile } = await import("node:fs/promises");
        const filesToRead = [config.eventsLogPath];
        for (let i = 1; i <= EVENTS_LOG_KEEP_ROTATED; i++) {
          const plainPath = `${config.eventsLogPath}.${i}`;
          const zstPath = `${plainPath}.zst`;
          try {
            const { stat: statFile } = await import("node:fs/promises");
            try { await statFile(zstPath); filesToRead.push(zstPath); }
            catch { await statFile(plainPath); filesToRead.push(plainPath); }
          } catch { /* rotated file doesn't exist */ }
        }
        let allEntries: Record<string, unknown>[] = [];
        for (const filePath of filesToRead) {
          try {
            let content: string;
            if (filePath.endsWith(".zst")) {
              // Decompress zstd on the fly via Bun.spawn
              const proc = Bun.spawn(["zstd", "-d", "--stdout", filePath], { stdout: "pipe", stderr: "pipe", onExit: () => {} });
              const exitCode = await proc.exited;
              if (exitCode !== 0) {
                const stderr = await new Response(proc.stderr).text();
                console.warn(`[bridge] zstd decompression failed for ${filePath}: exit=${exitCode} stderr=${stderr}`);
                continue;
              }
              content = await new Response(proc.stdout).text();
            } else {
              content = await readFile(filePath, "utf8");
            }
            const lines = content.trim().split("\n").filter(Boolean);
            for (const line of lines) {
              try { allEntries.push(JSON.parse(line)); } catch { /* skip malformed */ }
            }
          } catch { /* file not found */ }
        }
        allEntries.sort((a, b) => {
          const seqA = (a.sseEventSeq as number) ?? 0;
          const seqB = (b.sseEventSeq as number) ?? 0;
          return seqA - seqB;
        });
        if (afterSeq !== undefined && !isNaN(afterSeq)) {
          allEntries = allEntries.filter((e) => {
            const seq = e.sseEventSeq as number | null;
            return seq !== null && seq > afterSeq;
          });
        }
        if (sourceFilter || eventTypeFilter) {
          allEntries = allEntries.filter((e: Record<string, unknown>) => {
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
        allEntries = allEntries.slice(-limit);
        return json({
          ok: true,
          count: allEntries.length,
          entries: allEntries,
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

    if (request.method === "GET" && url.pathname === "/events/log/stats") {
      try {
        const { createReadStream } = await import("node:fs");
        const { createInterface } = await import("node:readline");
        const logStat = await stat(config.eventsLogPath);
        const stream = createReadStream(config.eventsLogPath, { encoding: "utf8" });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        const sourceCounts: Record<string, number> = {};
        const eventCounts: Record<string, number> = {};
        let totalEntries = 0;
        let ignoredEntries = 0;
        let oldestTs: string | null = null;
        let newestTs: string | null = null;
        let minSeq: number | null = null;
        let maxSeq: number | null = null;
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            totalEntries++;
            const src = typeof entry.source === "string" ? entry.source : "unknown";
            sourceCounts[src] = (sourceCounts[src] || 0) + 1;
            if (entry.ignored) ignoredEntries++;
            const sig = entry.signal as Record<string, unknown> | null;
            if (sig) {
              const evt = typeof sig.eventName === "string" ? sig.eventName : "unknown";
              eventCounts[evt] = (eventCounts[evt] || 0) + 1;
            }
            const ts = typeof entry.receivedAt === "string" ? entry.receivedAt : null;
            if (ts) {
              if (!oldestTs || ts < oldestTs) oldestTs = ts;
              if (!newestTs || ts > newestTs) newestTs = ts;
            }
            const seq = typeof entry.sseEventSeq === "number" ? entry.sseEventSeq : null;
            if (seq !== null) {
              if (minSeq === null || seq < minSeq) minSeq = seq;
              if (maxSeq === null || seq > maxSeq) maxSeq = seq;
            }
          } catch { /* skip malformed */ }
        }
        return json({
          ok: true,
          fileSizeBytes: logStat.size,
          fileSizeMB: Number((logStat.size / 1024 / 1024).toFixed(2)),
          maxFileSizeMB: EVENTS_LOG_MAX_BYTES / 1024 / 1024,
          rotationNeeded: logStat.size > EVENTS_LOG_MAX_BYTES * 0.8,
          totalEntries,
          ignoredEntries,
          activeEntries: totalEntries - ignoredEntries,
          oldestTimestamp: oldestTs,
          newestTimestamp: newestTs,
          seqRange: minSeq !== null && maxSeq !== null ? { min: minSeq, max: maxSeq, span: maxSeq - minSeq } : null,
          bySource: sourceCounts,
          byEvent: eventCounts,
        });
      } catch {
        return json({ ok: true, fileSizeBytes: 0, totalEntries: 0, error: "log file not found" });
      }
    }

    if (request.method === "POST" && url.pathname === "/events/log/compact") {
      if (!isAuthorized(request, config)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      try {
        const { readFile, writeFile, rename: renameFile } = await import("node:fs/promises");
        const content = await readFile(config.eventsLogPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        const retained: string[] = [];
        let removedIgnored = 0;
        const maxAge = url.searchParams.get("max_age_hours");
        const cutoffMs = maxAge ? Date.now() - Number(maxAge) * 3600 * 1000 : 0;
        let removedExpired = 0;
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            // Remove ignored events (they have no signal data worth keeping)
            if (entry.ignored) {
              removedIgnored++;
              continue;
            }
            // Remove entries older than max_age_hours if specified
            if (maxAge && entry.receivedAt) {
              const entryMs = new Date(entry.receivedAt as string).getTime();
              if (entryMs < cutoffMs) {
                removedExpired++;
                continue;
              }
            }
            retained.push(line);
          } catch {
            // Keep malformed lines (don't lose data we can't parse)
            retained.push(line);
          }
        }
        // Write compacted log atomically: write to temp then rename
        const tmpPath = `${config.eventsLogPath}.compact.tmp`;
        await writeFile(tmpPath, retained.join("\n") + "\n", "utf8");
        await renameFile(tmpPath, config.eventsLogPath);
        const newSize = (await stat(config.eventsLogPath)).size;
        return json({
          ok: true,
          originalLines: lines.length,
          retainedLines: retained.length,
          removedIgnored,
          removedExpired,
          originalSizeMB: Number((content.length / 1024 / 1024).toFixed(2)),
          newSizeMB: Number((newSize / 1024 / 1024).toFixed(2)),
          savingsMB: Number(((content.length - newSize) / 1024 / 1024).toFixed(2)),
        });
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/hook/claude") {
      const rawBody = await request.text();
      let body: ClaudeBridgeEvent;

      try {
        body = JSON.parse(rawBody) as ClaudeBridgeEvent;
      } catch {
        await appendIgnoredEvent("claude-hook", "invalid json", { rawBody }, config, metrics);
        return json({ ok: false, error: "invalid json" }, { status: 400 });
      }

      if (!body || (typeof body.event_name !== "string" || body.event_name.trim() === "") && (typeof body.hook_event_name !== "string" || body.hook_event_name.trim() === "")) {
        await appendIgnoredEvent("claude-hook", "missing event_name", { rawEvent: body ?? null }, config, metrics);
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
        await appendIgnoredEvent("claude-hook", "event did not map to an office state", { rawEvent: event }, config, metrics);
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
        const stats = dedupCounts.get(dedupeKey) || { seen: 0, passed: 0, lastSeenAt: Date.now() };
        stats.seen++;
        stats.lastSeenAt = Date.now();
        if (!isDuplicate) stats.passed++;
        dedupCounts.set(dedupeKey, stats);

        if (isDuplicate) {
          metrics.signalsDuplicate++;
          metrics.signalsSuppressed++;
          results.push({ index: i, ok: true, ignored: true, reason: "duplicate signal" });
        } else {
          metrics.signalsProcessed++;
          broadcastSSE("signal", resolvedSignal, metrics);
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

    if (request.method === "POST" && url.pathname === "/web/token/refresh") {
      if (!isAuthorized(request, config)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      // Revoke old token first, then create new one — prevents stale token accumulation
      try {
        const env = zellijEnv(undefined, config);

        // Step 1: Revoke old token if we know its name
        const oldTokenName = config.zellijWebTokenName;
        let revokedOld = false;
        if (oldTokenName) {
          try {
            const revokeProc = Bun.spawn(["zellij", "web", "--revoke-token", oldTokenName], {
              stdout: "pipe", stderr: "pipe", env,
            });
            const revokeExit = await revokeProc.exited;
            revokedOld = revokeExit === 0;
            if (!revokedOld) console.warn(`[bridge] failed to revoke old token ${oldTokenName}`);
          } catch (err) {
            console.warn("[bridge] error revoking old token:", err);
          }
        }

        // Step 2: Create new token
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

        // Parse token from output like "token_<N>: <UUID>"
        const tokenMatch = stdout.match(/(token_\d+)\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        const newToken = tokenMatch ? tokenMatch[2] : null;
        const newTokenName = tokenMatch ? tokenMatch[1] : null;

        if (newToken) {
          (config as unknown as Record<string, unknown>).zellijWebToken = newToken;
          (config as unknown as Record<string, unknown>).zellijWebTokenName = newTokenName;
          // Persist to env file so token survives restart
          try {
            const envPath = config.envFile;
            let envContent = "";
            try { envContent = await readFile(envPath, "utf8"); } catch { /* first write */ }
            const lines = envContent.split("\n");
            let foundToken = false, foundName = false;
            const updated = lines.map(line => {
              if (line.startsWith("ZELLIJ_WEB_TOKEN=")) { foundToken = true; return `ZELLIJ_WEB_TOKEN=${newToken}`; }
              if (line.startsWith("ZELLIJ_WEB_TOKEN_NAME=")) { foundName = true; return `ZELLIJ_WEB_TOKEN_NAME=${newTokenName}`; }
              return line;
            });
            if (!foundToken) updated.push(`ZELLIJ_WEB_TOKEN=${newToken}`);
            if (!foundName) updated.push(`ZELLIJ_WEB_TOKEN_NAME=${newTokenName}`);
            const { writeFile } = await import("node:fs/promises");
            await writeFile(envPath, updated.filter(l => l.trim()).join("\n") + "\n", "utf8");
          } catch (err) {
            console.warn("[bridge] failed to persist token to env file:", err);
          }
          broadcastSSE("web_token_refreshed", { tokenSet: true, tokenName: newTokenName, timestamp: new Date().toISOString() }, metrics);
          metrics.tokenRefreshes++;
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
          revokedOld,
          oldTokenName,
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
      if (!isAuthorized(request, config)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      let body: { name?: string; revokeAll?: boolean };
      try {
        body = (await request.json()) as { name?: string; revokeAll?: boolean };
      } catch {
        return json({ ok: false, error: "invalid json" }, { status: 400 });
      }
      try {
        const env = zellijEnv(undefined, config);
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
          broadcastSSE("web_token_revoked", { all: true, timestamp: new Date().toISOString() }, metrics);
          metrics.tokenRevocations++;          return json({ ok: true, revokedAll: true, rawOutput: stdout.trim() || null });
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

        broadcastSSE("web_token_revoked", { name: tokenName, timestamp: new Date().toISOString() }, metrics);
        metrics.tokenRevocations++;
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
      if (!isAuthorized(request, config)) {
        return json({ ok: false, error: "authentication required" }, { status: 401 });
      }
      try {
        const env = zellijEnv(undefined, config);
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
      if (!isAuthorized(request, config)) {
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
      // Unified overview combining health + version + web config + caddy health
      let heapStats: Record<string, unknown> | null = cachedHeapStats;
      let caddyHealth: { healthy: boolean; upstreamsHealthy: number; upstreamsTotal: number } | null = null;
      try {
        const caddyResp = await fetch("http://127.0.0.1:2019/metrics", { signal: AbortSignal.timeout(3000) });
        const caddyText = await caddyResp.text();
        const healthyLines = caddyText.split("\n").filter(l => l.startsWith("caddy_reverse_proxy_upstreams_healthy{"));
        const upstreamsTotal = healthyLines.length;
        const upstreamsHealthy = healthyLines.filter(l => l.endsWith(" 1")).length;
        caddyHealth = { healthy: upstreamsHealthy === upstreamsTotal && upstreamsTotal > 0, upstreamsHealthy, upstreamsTotal };
      } catch {}
      return json({
        ok: true,
        version: BRIDGE_VERSION,
        runtime: `bun ${Bun.version}`,
        arch: process.arch,
        platform: process.platform,
        uptime: process.uptime(),
        host: config.host,
        port: config.port,
        dryRun: config.dryRun,
        starOfficeUrl: config.starOfficePublicUrl || config.starOfficeUrl || null,
        sseClients: sseClients.size,
        sseEventLogSize: sseEventLog.length,
        sessions: registry.list().length,
        heap: heapStats,
        caddy: caddyHealth,
        web: {
          url: config.zellijWebUrl || null,
          tokenSet: config.zellijWebToken ? true : false,
          sessionName: config.zellijSessionName || null,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/action") {
      if (!isAuthorized(request, config)) {
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

      try {
        let stdout = "";
        let stderr = "";
        let exitCode = 0;

        // HTTP-fast path: web --status calls zellij web server directly
        if (body.action === "web --status") {
          try {
            const webBaseUrl = config.zellijWebUrl?.replace(/\/$/, "") || "http://127.0.0.1:8082";
            // Extract host:port from web URL for direct local call
            const webUrl = new URL(webBaseUrl);
            const localUrl = `http://127.0.0.1:${webUrl.port || 8082}/info/version`;
            const resp = await fetch(localUrl, { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
              stdout = await resp.text();
              broadcastSSE("action_executed", { action: body.action, args, session, exitCode: 0, via: "http" }, metrics);
              metrics.actionsExecuted++;
              metrics.ipcActions.set("web --status", (metrics.ipcActions.get("web --status") || 0) + 1);
              return json({
                ok: true,
                action: body.action,
                args,
                session,
                exitCode: 0,
                via: "http",
                result: `Web server online with version: ${stdout.trim()}. Checked: ${config.zellijWebUrl || localUrl}`,
              });
            }
          } catch {
            // HTTP failed — fall through to CLI spawn
          }
        }

        const env = zellijEnv(session, config);

        if (IPC_ELIGIBLE.has(body.action) && metrics.zellijSessionHealthy === 1) {
          // Fast path: direct UDS+protobuf IPC (avg 13ms vs 48ms CLI)
          try {
            const responses = await ipcSendAction(session, body.action, args);
            // Extract output from Log messages (query results come via log channel)
            for (const r of responses) {
              if ("log" in r && (r as Record<string, unknown>).log) {
                const logObj = (r as Record<string, unknown>).log as Record<string, unknown>;
                if (Array.isArray(logObj.lines)) {
                  stdout = (logObj.lines as string[]).join("");
                }
              }
            }
            // Parse JSON output if applicable
            let parsed: unknown = stdout.trim();
            if (typeof parsed === "string" && parsed.startsWith("[")) {
              try { parsed = JSON.parse(parsed); } catch { /* keep as string */ }
            } else if (typeof parsed === "string" && parsed.startsWith("{")) {
              try { parsed = JSON.parse(parsed); } catch { /* keep as string */ }
            }

            broadcastSSE("action_executed", { action: body.action, args, session, exitCode: 0, via: "ipc" }, metrics);
            metrics.actionsExecuted++;
            metrics.ipcActions.set(body.action, (metrics.ipcActions.get(body.action) || 0) + 1);

            return json({
              ok: true,
              action: body.action,
              args,
              session,
              exitCode: 0,
              via: "ipc",
              result: parsed || null,
            });
          } catch (ipcError) {
            // IPC failed — fall through to CLI spawn
            console.warn(`[bridge] IPC failed for ${body.action}, falling back to CLI:`, ipcError instanceof Error ? ipcError.message : String(ipcError));
          }
        }

        // Slow path: CLI spawn (fallback for IPC failures and non-eligible actions)
        const cmd = ["zellij", "action", body.action, ...args];
        const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
        stdout = await new Response(proc.stdout).text();
        stderr = await new Response(proc.stderr).text();
        exitCode = await proc.exited;

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

        broadcastSSE("action_executed", { action: body.action, args, session, exitCode }, metrics);
        metrics.actionsExecuted++;
        metrics.cliActions.set(body.action, (metrics.cliActions.get(body.action) || 0) + 1);

        return json({
          ok: true,
          action: body.action,
          args,
          session,
          exitCode,
          via: "cli",
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

    if (request.method === "POST" && url.pathname === "/action/batch") {
      if (!isAuthorized(request, config)) {
        return json({ ok: false, error: "action endpoint requires authentication" }, { status: 401 });
      }
      let actions: { action: string; args?: string[]; session?: string }[];
      try {
        const body = (await request.json()) as { actions: { action: string; args?: string[]; session?: string }[] };
        actions = body.actions;
        if (!Array.isArray(actions) || actions.length === 0) {
          return json({ ok: false, error: "expected non-empty 'actions' array" }, { status: 400 });
        }
        if (actions.length > 20) {
          return json({ ok: false, error: "batch limit is 20 actions" }, { status: 400 });
        }
      } catch {
        return json({ ok: false, error: "invalid json" }, { status: 400 });
      }

      const results: { index: number; ok: boolean; action: string; exitCode?: number; result?: unknown; stderr?: string | null; error?: string; via?: string }[] = [];
      // Run actions concurrently — each is independent, reduces wall-clock from N*latency to max(latency)
      const batchPromises = actions.map(async ({ action, args: rawArgs, session: rawSession }, i) => {
        if (!action || !ALLOWED_ACTIONS.has(action)) {
          return { index: i, ok: false, action: action || "", error: "disallowed action" };
        }
        const session = rawSession || config.zellijSessionName || "main";
        const args = rawArgs || [];
        try {
          // Fast path: IPC for eligible actions
          if (IPC_ELIGIBLE.has(action) && metrics.zellijSessionHealthy === 1) {
            try {
              const responses = await ipcSendAction(session, action, args);
              let stdout = "";
              for (const r of responses) {
                if ("log" in r && (r as Record<string, unknown>).log) {
                  const logObj = (r as Record<string, unknown>).log as Record<string, unknown>;
                  if (Array.isArray(logObj.lines)) {
                    stdout = (logObj.lines as string[]).join("");
                  }
                }
              }
              let parsed: unknown = stdout.trim();
              if (typeof parsed === "string" && (parsed.startsWith("[") || parsed.startsWith("{"))) {
                try { parsed = JSON.parse(parsed); } catch { /* keep as string */ }
              }
              metrics.actionsExecuted++;
              metrics.ipcActions.set(action, (metrics.ipcActions.get(action) || 0) + 1);
              return { index: i, ok: true, action, exitCode: 0, result: parsed || null, via: "ipc" };
            } catch {
              // IPC failed — fall through to CLI spawn
            }
          }
          // Slow path: CLI spawn (fallback for IPC failures and non-eligible actions)
          const env = zellijEnv(session, config);
          const cmd = ["zellij", "action", action, ...args];
          const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;
          let parsed: unknown = stdout.trim();
          if (typeof parsed === "string" && (parsed.startsWith("[") || parsed.startsWith("{"))) {
            try { parsed = JSON.parse(parsed); } catch { /* keep as string */ }
          }
          metrics.actionsExecuted++;
          metrics.cliActions.set(action, (metrics.cliActions.get(action) || 0) + 1);
          return { index: i, ok: exitCode === 0, action, exitCode, result: parsed || null, stderr: stderr.trim() || null, via: "cli" };
        } catch (error) {
          return { index: i, ok: false, action, error: error instanceof Error ? error.message : String(error) };
        }
      });
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      const okCount = results.filter(r => r.ok).length;
      broadcastSSE("action_batch_executed", { total: actions.length, ok: okCount, failed: actions.length - okCount }, metrics);
      return json({ ok: okCount === actions.length, total: actions.length, okCount, results });
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
        context: { manualState: body.state, manualDetail: body.detail || body.state },
      };

      return processSignal(signal, "manual");
    }

    return json({ ok: false, error: "not found" }, { status: 404 });
}

// Route table for /help endpoint
const ROUTE_TABLE: { method: string; path: string; description: string; auth: boolean }[] = [
  { method: "POST", path: "/hook/claude", description: "Receive Claude hook events", auth: true },
  { method: "POST", path: "/hook/zellij", description: "Receive Zellij monitor events", auth: false },
  { method: "POST", path: "/hook/zellij/batch", description: "Batch Zellij events (JSON array)", auth: false },
  { method: "GET", path: "/events", description: "SSE stream for real-time subscription", auth: false },
  { method: "GET", path: "/events/recent", description: "Recent event log (sequential IDs)", auth: false },
  { method: "GET", path: "/events/log", description: "Persistent event history (supports after_seq for catch-up, reads rotated logs)", auth: false },
  { method: "GET", path: "/events/log/tail", description: "Efficient tail of events log (no full-file read, last N lines)", auth: false },
  { method: "GET", path: "/events/log/stats", description: "Event log statistics: size, entry counts by source/event, seq range", auth: false },
  { method: "POST", path: "/events/log/compact", description: "Compact log: remove ignored/expired entries (auth required)", auth: true },
  { method: "GET", path: "/events/test", description: "HTML SSE test page", auth: false },
  { method: "POST", path: "/event/manual", description: "Submit manual events", auth: true },
  { method: "POST", path: "/alert", description: "Alertmanager webhook (broadcasts alerts as SSE events)", auth: false },
  { method: "GET", path: "/health", description: "Bridge health check (JSON)", auth: false },
  { method: "GET", path: "/healthz", description: "Lightweight liveness probe (plain ok)", auth: false },
  { method: "GET", path: "/readyz", description: "Readiness probe (503 during shutdown or zellij down, 30s startup grace)", auth: false },
  { method: "GET", path: "/action", description: "List allowed Zellij actions", auth: false },
  { method: "POST", path: "/action", description: "Execute Zellij CLI action (whitelisted)", auth: true },
  { method: "POST", path: "/action/batch", description: "Execute multiple Zellij actions sequentially (max 20)", auth: true },
  { method: "GET", path: "/web", description: "Zellij web config (URL, tokenSet, session)", auth: false },
  { method: "GET", path: "/web/token", description: "Zellij web token (authenticated)", auth: true },
  { method: "POST", path: "/web/token/refresh", description: "Refresh Zellij web token via CLI (authenticated)", auth: true },
  { method: "POST", path: "/web/token/revoke", description: "Revoke token by name or revoke all (authenticated)", auth: true },
  { method: "GET", path: "/web/tokens", description: "List token names and creation dates (authenticated)", auth: true },
  { method: "GET", path: "/status", description: "Unified overview (health+version+web+heap+caddy)", auth: false },
  { method: "GET", path: "/snapshot", description: "Full session state for drift correction", auth: false },
  { method: "GET", path: "/sessions", description: "Active session list", auth: false },
  { method: "GET", path: "/sessions/:id", description: "Session detail lookup", auth: false },
  { method: "GET", path: "/sessions/:id/events", description: "Per-session event history", auth: false },
  { method: "GET", path: "/stats", description: "Dedup stats, heap stats, runtime info", auth: false },
  { method: "GET", path: "/metrics", description: "Prometheus exposition format metrics (bridge only)", auth: false },
  { method: "GET", path: "/metrics/caddy", description: "Proxy Caddy admin API metrics", auth: false },
  { method: "GET", path: "/metrics/combined", description: "Bridge + Caddy merged metrics (single scrape target)", auth: false },
  { method: "GET", path: "/version", description: "Bridge version, runtime, arch", auth: false },
  { method: "GET", path: "/diagnostics", description: "Stale pipe detection, log size, dedup summary (authenticated)", auth: true },
  { method: "POST", path: "/recover", description: "Manually trigger zellij session recovery (authenticated)", auth: true },
  { method: "POST", path: "/debug/gc", description: "Trigger Bun.gc() for production debugging (authenticated)", auth: true },
  { method: "GET", path: "/debug/heap-snapshot", description: "Generate heap snapshot for leak debugging (authenticated)", auth: true },
  { method: "POST", path: "/debug/reload", description: "Hot-reload handlers without dropping connections (authenticated)", auth: true },
  { method: "GET", path: "/ws", description: "WebSocket for bidirectional control (upgrade, auth optional — unauth=read-only)", auth: false },
  { method: "GET", path: "/help", description: "This route table", auth: false },
  { method: "GET", path: "/dashboard", description: "Star Office Bridge Dashboard (HTML)", auth: false },
];

console.log(
  `[bridge] listening on http://${server.hostname}:${server.port} dryRun=${config.dryRun} starOffice=${config.starOfficeUrl || "none"}`,
);

// Notify systemd of service state changes (Type=notify)
// Uses systemd-notify CLI which writes to NOTIFY_SOCKET via AF_UNIX datagram.
// The bridge is the authoritative source for READY=1 — the watchdog wrapper
// does NOT send --ready (it only sends WATCHDOG=1).
function sdNotify(state: string): void {
  if (!process.env.NOTIFY_SOCKET) return;
  try {
    Bun.spawn(["systemd-notify", state], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Non-critical: systemd Type=notify just takes longer to report ready
  }
}

// Extend startup timeout by 60s in case init takes longer than TimeoutStartSec
// Must be sent BEFORE READY=1 — only effective during the startup phase
sdNotify("EXTEND_TIMEOUT_USEC=60000000");

// Notify systemd that the bridge is ready to accept connections
// This is the authoritative READY=1 — the watchdog wrapper does NOT send --ready
sdNotify("--ready");
