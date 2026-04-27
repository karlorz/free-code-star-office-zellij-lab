---
title: SSE Client Eviction and Backpressure Patterns
date: 2026-04-27
tags:
  - sse
  - backpressure
  - eviction
  - streaming
  - production
  - bun
  - nginx
  - envoy
  - cloudflare
aliases:
  - sse-backpressure
  - sse-slow-consumer
  - sse-eviction
---

# SSE Client Eviction and Backpressure Patterns

Production patterns for detecting slow SSE consumers, managing backpressure, evicting clients, and handling reconnection. Informed by the bridge's SSE implementation (`src/index.ts`) which uses bounded-buffer eviction with `Last-Event-ID` replay.

> [!tip] Key Principle
> For fan-out SSE (dashboards, notifications), ==evict slow clients aggressively== rather than slowing the producer. One slow client should not degrade service for the 99% fast clients. SSE's auto-reconnect + `Last-Event-ID` makes eviction safe.

## 1. Detecting Slow SSE Consumers

### Buffered Message Tracking

Maintain per-client state tracking how many enqueues have failed or are queued:

```typescript
const sseClients = new Map<number, {
  controller: ReadableStreamDefaultController;
  buffered: number;       // count of failed enqueues
  connectedAt: number;    // for duration metrics
}>();
```

On each broadcast, attempt `controller.enqueue()`. If it throws, increment `buffered`. If `buffered` exceeds a threshold (e.g., 32 messages), evict.

### Response Write Failures

- Wrap every `controller.enqueue()` in try/catch -- a throw means the stream's internal queue is full, the client disconnected, or the stream was already closed.
- In Node.js streams, `writable.write()` returns `false` to signal backpressure; listen for `'drain'` to resume.
- In Bun/Web Streams, `enqueue()` **does not throw for backpressure** -- it succeeds even when `desiredSize <= 0`. You must check `controller.desiredSize` manually.

### Detection Summary

| Signal | What It Means | Action |
|--------|---------------|--------|
| `enqueue()` throws | Stream closed/broken | Increment `buffered`; evict if over limit |
| `desiredSize <= 0` | Internal queue at capacity | Stop enqueueing; wait or evict |
| Write timeout (>2-5s) | Socket-level congestion | Flag as slow; consider eviction |
| No heartbeat ACK | Client not reading | Probe liveness; evict if stale |

## 2. Eviction vs. Producer Slowdown

### Decision Framework

> [!warning] Never slow the producer for fan-out SSE
> In broadcast scenarios (many clients, shared producer), one slow client backing up the event pipeline increases latency for everyone. ==Evict the slow client==; let it reconnect with `Last-Event-ID`.

**When to evict (default for most SSE):**
- Broadcast/fan-out with many clients
- Loss-tolerant data (dashboards, tickers, live state)
- Per-client bounded buffer exceeded

**When to slow the producer (rare):**
- Point-to-point streams where data loss is unacceptable
- Backpressure affects a shared upstream (e.g., Kafka consumer lag)
- Critical audit/event log streams

### Handling Options (Priority Order)

1. **Bounded per-client buffer** -- each SSE connection gets a fixed-size queue; when full, apply a policy:
   - Drop oldest (live dashboards -- latest state matters)
   - Drop newest (audit logs -- earlier events matter)
   - Coalesce (merge intermediate updates into a summary)
2. **Eviction** -- disconnect after sustained slowness; send a `backpressure` event before close so the client knows it was evicted (not a crash)
3. **Adaptive rate limiting** -- reduce send frequency for that specific connection (not global)
4. **Producer slowdown** -- last resort; only when backpressure affects shared upstream

### Bridge Implementation

The bridge uses option 1+2: a `SSE_MAX_BUFFERED_MESSAGES = 32` threshold per client. When exceeded:

```
controller.enqueue(backpressure event with reason + buffered count)
controller.close()
sseClients.delete(clientId)
```

This gives the client a "graceful eviction" notice before disconnect.

## 3. Memory Impact of Slow SSE Clients

### Quantification

Memory consumed by slow clients = (number of slow clients) x (per-client buffer size):

$$
M_{slow} = N_{slow} \times (Q_{bytes} + O_{conn})
$$

Where:
- $N_{slow}$ = number of slow clients
- $Q_{bytes}$ = buffered data per client (grows at `event_rate x event_size x lag_time`)
- $O_{conn}$ = per-connection overhead (controller object, state, metadata -- typically 1-5 KB)

Example: 1 KB events at 100/s per client. 10 slow clients lagging 30s each = 10 x 100 x 1KB x 30 = **30 MB** of buffered data.

### Per-Client Buffer Budget

Set a hard memory limit per client. The bridge uses 32 messages max; with typical event sizes (~200-500 bytes), that is ~16 KB per slow client before eviction.

For WebSocket backpressure, the bridge uses `backpressureLimit: 1024 * 1024` (1 MB per client).

### Prometheus Alert Rules

```yaml
groups:
- name: sse_memory_alerts
  rules:
  - alert: HighSSEBufferedMemory
    expr: sum(sse_buffered_bytes_total) > 500 * 1024 * 1024
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High SSE buffering due to slow clients ({{ $value }} bytes)"

  - alert: ManySlowSSEClients
    expr: sse_slow_clients_count > 10
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: "Too many slow SSE clients"

  - alert: SSEEvictionRate
    expr: rate(sse_client_evicted_total[5m]) > 0.1
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "SSE eviction rate above 10% -- investigate client health"
```

Key metrics to expose:
- `sse_active_connections` (gauge)
- `sse_buffered_bytes_total` (per connection or aggregated)
- `sse_slow_clients_count` (gauge)
- `sse_client_evicted_total` (counter)
- `sse_replay_requests_total` / `sse_replay_gaps_total` (counters)
- `process_resident_memory_bytes` (correlate with client count)

## 4. SSE Retry/Reconnection After Eviction

### Last-Event-ID Mechanism

The browser `EventSource` API automatically:
1. Stores the last `id:` field received
2. On disconnect, waits `retry:` milliseconds (default ~3s)
3. Reconnects to the same URL with `Last-Event-ID: <id>` header
4. Server replays all events after that ID

### Server-Side Replay Pattern

```typescript
if (lastEventId) {
  const requestedId = Number(lastEventId);
  const oldestId = sseEventLog[0]?.id ?? sseEventSeq + 1;
  const replayIndex = requestedId >= oldestId ? requestedId - oldestId : -1;

  if (replayIndex >= 0 && replayIndex < sseEventLog.length) {
    // Replay events after the requested ID
    for (const entry of sseEventLog.slice(replayIndex + 1)) {
      controller.enqueue(formatSSE(entry.payload, entry.event, entry.id));
    }
  } else {
    // Stale ID -- outside replay window, send gap notification
    controller.enqueue(formatSSE({
      gapStart: requestedId,
      gapEnd: sseEventLog[0].id - 1,
      suggestion: "use /events/log?after_seq=X for persistent log catch-up"
    }, "gap", ++sseEventSeq));
  }
}
```

### Replay Window

The server retains only a bounded event log (`SSE_REPLAY_CAPACITY = 64` events in the bridge). This bounds memory. When a `Last-Event-ID` falls outside this window:
- Send a `gap` event indicating which IDs are missing
- Client can fetch missed events from a persistent log (e.g., `/events/log?after_seq=N`)
- Or do a full state resync (re-fetch snapshot)

### Eviction Notice Best Practice

Before closing a slow client's stream, send a `backpressure` event:

```
event: backpressure
data: {"reason":"backpressure","bufferedMessages":32}
id: 456
```

The client knows it was evicted (not a network failure) and can decide whether to reconnect immediately or back off.

## 5. Proxy SSE Backpressure Comparison

### nginx

| Setting | Value | Purpose |
|---------|-------|---------|
| `proxy_buffering` | `off` | Flush chunks immediately (critical) |
| `proxy_cache` | `off` | Never cache streaming responses |
| `proxy_http_version` | `1.1` | Persistent connection for long-lived stream |
| `proxy_set_header Connection` | `""` | Clear hop-by-hop header |
| `proxy_read_timeout` | `86400` | Prevent premature close (24h) |
| `gzip` | `off` | Compression forces buffering |
| Response header | `X-Accel-Buffering: no` | Per-response disable; nginx honors this |

nginx buffers by default until `proxy_buffer_size` is full or the response ends -- ==deadly for SSE==. Always set `proxy_buffering off` or send `X-Accel-Buffering: no` from the backend.

### Envoy

| Setting | Value | Purpose |
|---------|-------|---------|
| Route `timeout` | `0s` | Disable 15s default; use `stream_idle_timeout` instead |
| Buffer filter | `disabled: true` | Skip response buffering on SSE routes |
| `http2_max_outbound_frames` | tuned | Prevent HTTP/2 flood from backpressure |
| Watermark callbacks | high/low | Envoy applies backpressure by pausing reads or withholding HTTP/2 window updates when downstream is slow |

Envoy has the most sophisticated backpressure: it uses high/low watermark callbacks on internal buffers. When a downstream client is slow, Envoy pauses reads from upstream ==naturally propagating backpressure== without OOM.

### Cloudflare

| Setting | Value | Purpose |
|---------|-------|---------|
| Configuration Rule | Response Body Buffering: none | Available since early 2026 |
| Cache Rule | Bypass cache | Never cache SSE endpoints |
| Response header | `X-Accel-Buffering: no` | Cloudflare often respects this nginx-style header |
| `Content-Type` | `text/event-stream` | Helps Cloudflare identify streaming |

> [!bug] Known Cloudflare Issue
> Cloudflare's proxy (orange cloud) can buffer `text/event-stream` responses until ~100 KB or connection close, even with caching bypassed. The Configuration Rule for "Response Body Buffering: none" is the most reliable fix. Always verify with `curl -N` after config changes.

### Summary

| Proxy | Default Behavior | Key Fix | Backpressure Propagation |
|-------|-----------------|---------|--------------------------|
| nginx | Buffers until full/close | `proxy_buffering off` | None -- relies on TCP backpressure |
| Envoy | Buffers with watermarks | `timeout: 0s` + disable buffer filter | Native: pauses reads on slow downstream |
| Cloudflare | Buffers ~100 KB | Response Body Buffering: none | None -- black box |

## 6. Bun-Specific: ReadableStream enqueue Backpressure

### Key Behavior

> [!danger] enqueue() does NOT throw for backpressure
> `controller.enqueue()` always succeeds, even when `desiredSize` is zero or negative. The Web Streams API spec does not prevent enqueue when the internal queue is full. ==Ignoring `desiredSize` leads to unbounded memory growth.==

### desiredSize Semantics

| `desiredSize` | Meaning |
|---------------|---------|
| Positive | Consumer wants more data -- enqueue freely |
| 0 | Queue at capacity -- pause enqueueing |
| Negative | Queue over capacity -- ==stop enqueueing now== |
| `null` | Stream closed or errored |

### What Happens When enqueue Throws

`enqueue()` only throws when:
1. The stream has been closed (`controller.close()` already called)
2. The stream has been errored (`controller.error()` already called)
3. The chunk type is wrong (e.g., string instead of `Uint8Array` for byte streams)

It does **not** throw for backpressure. A slow client will cause `desiredSize` to go negative, but enqueue still "succeeds" -- the data piles up in memory.

### Bun Direct Streams (Zero-Copy)

Bun offers `type: "direct"` ReadableStream that bypasses the standard internal queue:

```typescript
const stream = new ReadableStream({
  type: "direct",
  async pull(controller) {
    controller.write(chunk);  // zero-copy, no intermediate queue
  }
});
```

Direct streams handle backpressure at the destination (network socket) level rather than in an intermediate queue. More efficient but less observable.

### Bun Version Notes

- v1.2+: Fixed backpressure for ReadableStream bodies -- pauses reading when network socket is busy.
- v1.3.x: Fixed memory leaks in HTTP streaming responses.
- Some versions batch multiple enqueue calls into a single TCP send (events arrive in bursts on client).
- `idleTimeout` can cause SSE stream disconnects; set `server.timeout(request, 0)` for SSE endpoints.

### Robust Pattern

```typescript
const stream = new ReadableStream({
  start(controller) {
    // Set up event source, timers, etc.
    const interval = setInterval(() => {
      if (controller.desiredSize !== null && controller.desiredSize <= 0) {
        // Backpressured -- skip or evict
        return;
      }
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      } catch {
        // Stream closed -- clean up
        clearInterval(interval);
      }
    }, 1000);
  },
  cancel() {
    // Client disconnected -- release resources
  }
});
```

Or use `pull()` instead of `start()` for natural backpressure (runtime calls `pull` only when the consumer is ready).

## Related Notes

- [[caddy-health-checks-sse-websocket]] -- Caddy reverse proxy for SSE/WebSocket
- [[readiness-vs-liveness-probes]] -- Kubernetes probe semantics for streaming endpoints
