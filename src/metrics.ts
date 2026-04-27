export const LATENCY_BUCKETS = [0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000];
export const SSE_DURATION_BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14440];

export const metrics = {
  httpRequestsTotal: new Map<string, number>(),
  httpResponsesTotal: new Map<string, number>(),
  httpRequestDurationMs: new Map<string, { count: number; sum: number; buckets: Map<string, number> }>(),
  sseBroadcasts: 0,
  sseClientConnected: 0,
  sseClientDisconnected: 0,
  sseClientEvicted: 0,
  sseClientDurationMs: new Map<string, number>(),
  sseClientDurationSum: 0,
  sseClientDurationCount: 0,
  sseReplayRequests: 0,
  sseReplaySuccesses: 0,
  sseReplayGaps: 0,
  signalsProcessed: 0,
  signalsDuplicate: 0,
  signalsSuppressed: 0,
  actionsExecuted: 0,
  ipcActions: new Map<string, number>(),
  cliActions: new Map<string, number>(),
  tokenRefreshes: 0,
  tokenRevocations: 0,
  starOfficeApply: 0,
  starOfficeApplyFailures: 0,
  alertsReceived: 0,
  rateLimitRejections: 0,
  wsConnections: 0,
  wsDisconnects: 0,
  wsMessages: 0,
  wsClientsCurrent: 0,
  dedupEvicted: 0,
  gcTriggers: 0,
  zellijSessionHealthy: 1,
  zellijHealthConsecutiveFailures: 0,
  zellijRecoveryAttempts: 0,
  zellijRecoverySuccesses: 0,
  wsClientTimeouts: 0,
  wsBackpressureDrops: 0,
  zellijSaveSuccesses: 0,
  zellijSaveFailures: 0,
  startTime: Date.now(),
};

export function observeHistogram(path: string, durationMs: number): void {
  let entry = metrics.httpRequestDurationMs.get(path);
  if (!entry) {
    entry = { count: 0, sum: 0, buckets: new Map(LATENCY_BUCKETS.map(b => [`le="${b}"`, 0])) };
    entry.buckets.set('le="+Inf"', 0);
    metrics.httpRequestDurationMs.set(path, entry);
  }
  entry.count++;
  entry.sum += durationMs;
  for (const b of LATENCY_BUCKETS) {
    if (durationMs <= b) {
      entry.buckets.set(`le="${b}"`, (entry.buckets.get(`le="${b}"`) || 0) + 1);
    }
  }
  entry.buckets.set('le="+Inf"', (entry.buckets.get('le="+Inf"') || 0) + 1);
}

export function buildPrometheusMetrics(deps: {
  sseClientsSize: number;
  sseEventLogLength: number;
  sessionsCount: number;
  dedupCountsSize: number;
  registryList: () => import("./types").SessionSnapshot[];
  cachedHeapStats: Record<string, unknown> | null;
  serverPendingRequests: number;
  serverPendingWebSockets: number;
  version: string;
}): string {
  const lines: string[] = [];
  const uptime = process.uptime();
  lines.push(`# HELP bridge_uptime_seconds Process uptime in seconds`);
  lines.push(`# TYPE bridge_uptime_seconds gauge`);
  lines.push(`bridge_uptime_seconds ${uptime.toFixed(2)}`);
  lines.push(`# HELP bridge_info Bridge build information`);
  lines.push(`# TYPE bridge_info gauge`);
  lines.push(`bridge_info{version="${deps.version}",runtime="bun_${Bun.version}",arch="${process.arch}",platform="${process.platform}"} 1`);
  // SSE metrics
  lines.push(`# HELP bridge_sse_clients_current Current SSE client connections`);
  lines.push(`# TYPE bridge_sse_clients_current gauge`);
  lines.push(`bridge_sse_clients_current ${deps.sseClientsSize}`);
  lines.push(`# HELP bridge_sse_broadcasts_total Total SSE broadcast events`);
  lines.push(`# TYPE bridge_sse_broadcasts_total counter`);
  lines.push(`bridge_sse_broadcasts_total ${metrics.sseBroadcasts}`);
  lines.push(`# HELP bridge_sse_client_connected_total Total SSE client connections established`);
  lines.push(`# TYPE bridge_sse_client_connected_total counter`);
  lines.push(`bridge_sse_client_connected_total ${metrics.sseClientConnected}`);
  lines.push(`# HELP bridge_sse_client_disconnected_total Total SSE client disconnections`);
  lines.push(`# TYPE bridge_sse_client_disconnected_total counter`);
  lines.push(`bridge_sse_client_disconnected_total ${metrics.sseClientDisconnected}`);
  lines.push(`# HELP bridge_sse_client_evicted_total Total SSE clients evicted for slow consumption`);
  lines.push(`# TYPE bridge_sse_client_evicted_total counter`);
  lines.push(`bridge_sse_client_evicted_total ${metrics.sseClientEvicted}`);
  lines.push(`# HELP bridge_sse_replay_requests_total Total SSE Last-Event-ID replay requests`);
  lines.push(`# TYPE bridge_sse_replay_requests_total counter`);
  lines.push(`bridge_sse_replay_requests_total ${metrics.sseReplayRequests}`);
  lines.push(`# HELP bridge_sse_replay_successes_total Total successful SSE replays from ring buffer`);
  lines.push(`# TYPE bridge_sse_replay_successes_total counter`);
  lines.push(`bridge_sse_replay_successes_total ${metrics.sseReplaySuccesses}`);
  lines.push(`# HELP bridge_sse_replay_gaps_total Total SSE replay gaps (stale Last-Event-ID)`);
  lines.push(`# TYPE bridge_sse_replay_gaps_total counter`);
  lines.push(`bridge_sse_replay_gaps_total ${metrics.sseReplayGaps}`);
  lines.push(`# HELP bridge_sse_event_log_size Current event log ring buffer size`);
  lines.push(`# TYPE bridge_sse_event_log_size gauge`);
  lines.push(`bridge_sse_event_log_size ${deps.sseEventLogLength}`);
  // Signal metrics
  lines.push(`# HELP bridge_signals_processed_total Total signals processed (non-duplicate)`);
  lines.push(`# TYPE bridge_signals_processed_total counter`);
  lines.push(`bridge_signals_processed_total ${metrics.signalsProcessed}`);
  lines.push(`# HELP bridge_signals_duplicate_total Total duplicate signals suppressed`);
  lines.push(`# TYPE bridge_signals_duplicate_total counter`);
  lines.push(`bridge_signals_duplicate_total ${metrics.signalsDuplicate}`);
  lines.push(`# HELP bridge_signals_suppressed_total Cumulative duplicate signals suppressed (running total)`);
  lines.push(`# TYPE bridge_signals_suppressed_total counter`);
  lines.push(`bridge_signals_suppressed_total ${metrics.signalsSuppressed}`);
  lines.push(`# HELP bridge_sessions_current Current active sessions`);
  lines.push(`# TYPE bridge_sessions_current gauge`);
  lines.push(`bridge_sessions_current ${deps.sessionsCount}`);
  // Action metrics
  lines.push(`# HELP bridge_actions_executed_total Total Zellij actions executed`);
  lines.push(`# TYPE bridge_actions_executed_total counter`);
  lines.push(`bridge_actions_executed_total ${metrics.actionsExecuted}`);
  // IPC vs CLI action metrics
  lines.push(`# HELP bridge_ipc_actions_total Actions executed via direct UDS IPC, by action name`);
  lines.push(`# TYPE bridge_ipc_actions_total counter`);
  for (const [action, count] of metrics.ipcActions) {
    lines.push(`bridge_ipc_actions_total{action="${action}",via="ipc"} ${count}`);
  }
  lines.push(`# HELP bridge_cli_actions_total Actions executed via CLI spawn fallback, by action name`);
  lines.push(`# TYPE bridge_cli_actions_total counter`);
  for (const [action, count] of metrics.cliActions) {
    lines.push(`bridge_cli_actions_total{action="${action}",via="cli"} ${count}`);
  }
  // Token metrics
  lines.push(`# HELP bridge_token_refreshes_total Total Zellij web token refreshes`);
  lines.push(`# TYPE bridge_token_refreshes_total counter`);
  lines.push(`bridge_token_refreshes_total ${metrics.tokenRefreshes}`);
  lines.push(`# HELP bridge_token_revocations_total Total Zellij web token revocations`);
  lines.push(`# TYPE bridge_token_revocations_total counter`);
  lines.push(`bridge_token_revocations_total ${metrics.tokenRevocations}`);
  // Rate limit metrics
  lines.push(`# HELP bridge_rate_limit_rejections_total Total requests rejected by rate limiter`);
  lines.push(`# TYPE bridge_rate_limit_rejections_total counter`);
  lines.push(`bridge_rate_limit_rejections_total ${metrics.rateLimitRejections}`);
  // Star Office apply metrics
  lines.push(`# HELP bridge_star_office_apply_total Total star-office apply successes`);
  lines.push(`# TYPE bridge_star_office_apply_total counter`);
  lines.push(`bridge_star_office_apply_total ${metrics.starOfficeApply}`);
  lines.push(`# HELP bridge_star_office_apply_failures_total Total star-office apply failures`);
  lines.push(`# TYPE bridge_star_office_apply_failures_total counter`);
  lines.push(`bridge_star_office_apply_failures_total ${metrics.starOfficeApplyFailures}`);
  // Alert webhook metrics
  lines.push(`# HELP bridge_alerts_received_total Total alerts received from Alertmanager webhook`);
  lines.push(`# TYPE bridge_alerts_received_total counter`);
  lines.push(`bridge_alerts_received_total ${metrics.alertsReceived}`);
  // SSE connection duration histogram
  lines.push(`# HELP bridge_sse_client_duration_seconds SSE client connection duration in seconds`);
  lines.push(`# TYPE bridge_sse_client_duration_seconds histogram`);
  if (metrics.sseClientDurationCount > 0) {
    let cumSum = 0;
    for (const b of SSE_DURATION_BUCKETS) {
      cumSum += metrics.sseClientDurationMs.get(`le="${b}"`) || 0;
      lines.push(`bridge_sse_client_duration_seconds_bucket{le="${b}"} ${cumSum}`);
    }
    const infCount = metrics.sseClientDurationMs.get('le="+Inf"') || 0;
    lines.push(`bridge_sse_client_duration_seconds_bucket{le="+Inf"} ${cumSum + infCount}`);
    lines.push(`bridge_sse_client_duration_seconds_sum ${metrics.sseClientDurationSum.toFixed(2)}`);
    lines.push(`bridge_sse_client_duration_seconds_count ${metrics.sseClientDurationCount}`);
  }
  // WebSocket metrics
  lines.push(`# HELP bridge_ws_connections_total Total WebSocket connections established`);
  lines.push(`# TYPE bridge_ws_connections_total counter`);
  lines.push(`bridge_ws_connections_total ${metrics.wsConnections}`);
  lines.push(`# HELP bridge_ws_disconnects_total Total WebSocket disconnections`);
  lines.push(`# TYPE bridge_ws_disconnects_total counter`);
  lines.push(`bridge_ws_disconnects_total ${metrics.wsDisconnects}`);
  lines.push(`# HELP bridge_ws_messages_total Total WebSocket messages received`);
  lines.push(`# TYPE bridge_ws_messages_total counter`);
  lines.push(`bridge_ws_messages_total ${metrics.wsMessages}`);
  lines.push(`# HELP bridge_ws_clients_current Current WebSocket client connections`);
  lines.push(`# TYPE bridge_ws_clients_current gauge`);
  lines.push(`bridge_ws_clients_current ${metrics.wsClientsCurrent}`);
  // HTTP request metrics by path
  lines.push(`# HELP bridge_http_requests_total Total HTTP requests by path`);
  lines.push(`# TYPE bridge_http_requests_total counter`);
  for (const [path, count] of metrics.httpRequestsTotal) {
    lines.push(`bridge_http_requests_total{path="${path}"} ${count}`);
  }
  // HTTP response metrics by path and status
  lines.push(`# HELP bridge_http_responses_total Total HTTP responses by path and status`);
  lines.push(`# TYPE bridge_http_responses_total counter`);
  for (const [key, count] of metrics.httpResponsesTotal) {
    const [path, status] = key.split(":");
    lines.push(`bridge_http_responses_total{path="${path}",status="${status}"} ${count}`);
  }
  // Memory from Bun
  const mem = process.memoryUsage();
  lines.push(`# HELP bridge_process_memory_rss_bytes Process RSS memory in bytes`);
  lines.push(`# TYPE bridge_process_memory_rss_bytes gauge`);
  lines.push(`bridge_process_memory_rss_bytes ${mem.rss}`);
  lines.push(`# HELP bridge_process_memory_heap_bytes Process heap memory in bytes`);
  lines.push(`# TYPE bridge_process_memory_heap_bytes gauge`);
  lines.push(`bridge_process_memory_heap_bytes ${mem.heapUsed}`);
  // Server pending metrics
  lines.push(`# HELP bridge_pending_requests Number of in-flight HTTP requests`);
  lines.push(`# TYPE bridge_pending_requests gauge`);
  lines.push(`bridge_pending_requests ${deps.serverPendingRequests}`);
  lines.push(`# HELP bridge_pending_websockets Number of active WebSocket connections`);
  lines.push(`# TYPE bridge_pending_websockets gauge`);
  lines.push(`bridge_pending_websockets ${deps.serverPendingWebSockets}`);
  // Dedup map metrics
  lines.push(`# HELP bridge_dedup_entries Current number of dedup keys tracked`);
  lines.push(`# TYPE bridge_dedup_entries gauge`);
  lines.push(`bridge_dedup_entries ${deps.dedupCountsSize}`);
  lines.push(`# HELP bridge_dedup_evicted_total Total dedup entries evicted by TTL`);
  lines.push(`# TYPE bridge_dedup_evicted_total counter`);
  lines.push(`bridge_dedup_evicted_total ${metrics.dedupEvicted}`);
  lines.push(`# HELP bridge_gc_triggers_total Number of manual GC triggers via /debug/gc`);
  lines.push(`# TYPE bridge_gc_triggers_total counter`);
  lines.push(`bridge_gc_triggers_total ${metrics.gcTriggers}`);
  // Zellij session health gauge
  lines.push(`# HELP bridge_zellij_session_healthy Whether the zellij session server is responsive via IPC (1=healthy, 0=unhealthy)`);
  lines.push(`# TYPE bridge_zellij_session_healthy gauge`);
  lines.push(`bridge_zellij_session_healthy ${metrics.zellijSessionHealthy}`);
  lines.push(`# HELP bridge_zellij_recovery_attempts_total Total zellij session auto-recovery attempts`);
  lines.push(`# TYPE bridge_zellij_recovery_attempts_total counter`);
  lines.push(`bridge_zellij_recovery_attempts_total ${metrics.zellijRecoveryAttempts}`);
  lines.push(`# HELP bridge_zellij_recovery_successes_total Total successful zellij session recoveries`);
  lines.push(`# TYPE bridge_zellij_recovery_successes_total counter`);
  lines.push(`bridge_zellij_recovery_successes_total ${metrics.zellijRecoverySuccesses}`);
  lines.push(`# HELP bridge_zellij_save_successes_total Periodic save-session IPC successes`);
  lines.push(`# TYPE bridge_zellij_save_successes_total counter`);
  lines.push(`bridge_zellij_save_successes_total ${metrics.zellijSaveSuccesses}`);
  lines.push(`# HELP bridge_zellij_save_failures_total Periodic save-session IPC failures`);
  lines.push(`# TYPE bridge_zellij_save_failures_total counter`);
  lines.push(`bridge_zellij_save_failures_total ${metrics.zellijSaveFailures}`);
  lines.push(`# HELP bridge_ws_client_timeouts_total WebSocket connections closed by heartbeat zombie detection`);
  lines.push(`# TYPE bridge_ws_client_timeouts_total counter`);
  lines.push(`bridge_ws_client_timeouts_total ${metrics.wsClientTimeouts}`);
  lines.push(`# HELP bridge_ws_backpressure_drops_total WebSocket connections dropped for exceeding backpressure limit`);
  lines.push(`# TYPE bridge_ws_backpressure_drops_total counter`);
  lines.push(`bridge_ws_backpressure_drops_total ${metrics.wsBackpressureDrops}`);
  // Heap object count
  const heapObjCount = deps.cachedHeapStats?.objectCount as number | undefined;
  if (heapObjCount !== undefined) {
    lines.push(`# HELP bridge_heap_object_count JSC heap object count (sampled every 60s)`);
    lines.push(`# TYPE bridge_heap_object_count gauge`);
    lines.push(`bridge_heap_object_count ${heapObjCount}`);
  }
  // HTTP request duration histograms
  lines.push(`# HELP bridge_http_request_duration_milliseconds HTTP request latency in milliseconds`);
  lines.push(`# TYPE bridge_http_request_duration_milliseconds histogram`);
  for (const [path, entry] of metrics.httpRequestDurationMs) {
    let cumSum = 0;
    for (const b of LATENCY_BUCKETS) {
      cumSum += entry.buckets.get(`le="${b}"`) || 0;
      lines.push(`bridge_http_request_duration_milliseconds_bucket{path="${path}",le="${b}"} ${cumSum}`);
    }
    cumSum += entry.buckets.get('le="+Inf"') || 0;
    lines.push(`bridge_http_request_duration_milliseconds_bucket{path="${path}",le="+Inf"} ${cumSum}`);
    lines.push(`bridge_http_request_duration_milliseconds_sum{path="${path}"} ${entry.sum.toFixed(2)}`);
    lines.push(`bridge_http_request_duration_milliseconds_count{path="${path}"} ${entry.count}`);
  }
  return lines.join("\n") + "\n";
}
