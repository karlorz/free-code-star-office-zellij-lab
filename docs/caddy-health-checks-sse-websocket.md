---
title: Caddy Health Checks for SSE/WebSocket Upstreams
date: 2026-04-27
tags:
  - caddy
  - reverse-proxy
  - sse
  - websocket
  - health-checks
  - reliability
aliases:
  - caddy-health-checks-streaming
  - caddy-sse-ws-health
---

# Caddy Health Checks for SSE/WebSocket Upstreams

Practical guide to Caddy reverse proxy health checks and streaming configuration for SSE/WebSocket backends. Complements [[readiness-vs-liveness-probes]] which covers Kubernetes-side probe semantics.

## Active Health Checks (Background Probing)

Caddy periodically sends HTTP requests to each upstream, independent of user traffic. Only **new** connections are affected by health state -- existing streams are never interrupted.

### Caddyfile Directives

| Directive | Default | Purpose |
|---|---|---|
| `health_uri` | `/` | Path (and query) to probe on each upstream |
| `health_interval` | `30s` | Time between probes |
| `health_timeout` | `5s` | Wait time for probe response before marking failure |
| `health_status` | `200` (via `expect_status`) | HTTP status code that means "healthy" |
| `health_port` | upstream dial port | Separate port for health checks |
| `health_headers` | none | Custom headers on probe requests |
| `health_passes` | `1` | Consecutive passes required to mark upstream healthy again |
| `health_fails` | `1` | Consecutive failures required to mark upstream unhealthy |

### How Upstream Selection Works

1. On each `health_interval`, Caddy sends a GET to `health_uri` on every upstream
2. If the response status matches `health_status` (default 200), the upstream is **healthy**
3. If not, or if it times out (`health_timeout`), a failure is counted
4. After `health_fails` consecutive failures, the upstream is marked **unhealthy** and removed from the routing pool
5. After `health_passes` consecutive successes, the upstream is marked **healthy** again and returns to the pool
6. **New requests** are only routed to healthy upstreams; **existing connections are untouched**

```caddy
reverse_proxy {
    to bridge-a:8080 bridge-b:8080

    lb_policy first    # Active-passive: prefer first healthy

    health_uri /readyz
    health_interval 10s
    health_timeout 2s
    health_status 200
    health_fails 2     # Tolerate one blip before marking down
    health_passes 2    # Require two consecutive passes to restore
}
```

> [!tip] Probe Your Readiness Endpoint
> Point `health_uri` at `/readyz` (not `/healthz`). Readiness = "should new traffic come here?" -- exactly the question Caddy is asking. Liveness = "should the container be restarted?" -- that is a Kubernetes concern, not Caddy's.

## What Happens to Existing SSE/WS Connections When an Upstream Goes Unhealthy

**Caddy does NOT terminate existing connections when it marks an upstream unhealthy.** It only prevents new connections from being routed there. This is the correct behavior for streaming:

- Existing SSE streams and WebSocket tunnels continue until they close naturally, the backend drops them, or a configured timeout fires
- The backend itself must close connections during its own graceful shutdown (see [[readiness-vs-liveness-probes]] shutdown sequence)
- Caddy will not sever in-flight streaming connections on health state changes

> [!warning] Implication for Blue-Green Deploys
> Marking an upstream unhealthy stops new traffic but does not drain existing sessions. For SSE/WS backends, you must either:
> 1. Wait for existing streams to close naturally, or
> 2. Have the backend send shutdown frames to its clients (SSE: shutdown event; WS: close frame), or
> 3. Set `stream_timeout` to force-close very long-lived streams eventually

## Passive Health Checks (Observing Real Traffic)

Passive checks watch actual proxied requests for failure signals. No background probing -- decisions are based on real user traffic outcomes.

### Caddyfile Directives

| Directive | Default | Purpose |
|---|---|---|
| `fail_duration` | `0` (disabled) | How long to remember a failure; >0 enables passive checks |
| `max_fails` | `1` | Failures within `fail_duration` window to mark upstream down |
| `unhealthy_status` | none | Response codes that count as failures (e.g., `500 502 503 504`) |
| `unhealthy_latency` | none | Response latency threshold to count as failure |
| `unhealthy_request_count` | none | Concurrent request limit; mark down if exceeded |

### Key Behavioral Differences from Active Checks

| Aspect | Active | Passive |
|---|---|---|
| Traffic required | No (background probes) | Yes (observes real requests) |
| Detects problems before users hit them | Yes | No |
| Detects real-load issues (latency, errors) | Only if probe path exercises same code | Yes |
| Shared state | Per-proxy-handler | Global (shared across handlers) |
| Works with dynamic upstreams | Yes | Only effective for stable, busy upstream pools |
| SSE/WS interaction | Probes are short HTTP -- no streaming concern | A failed SSE/WS response counts against the upstream |

### When to Use Each

**Use active checks when:**
- Upstreams may become unhealthy with no traffic (cold standby detection)
- You need proactive removal before users experience failures
- You want to probe a dedicated readiness endpoint

**Use passive checks when:**
- You want to detect real-load degradation (slow responses under pressure)
- Active probe paths do not exercise the same code as real traffic
- You want to limit concurrent requests per upstream (`unhealthy_request_count`)

**Use both together** -- they complement each other. Active catches dead backends proactively; passive catches degraded ones under real load.

```caddy
reverse_proxy {
    to bridge-a:8080 bridge-b:8080

    # Active: proactive readiness probing
    health_uri /readyz
    health_interval 10s
    health_timeout 2s
    health_status 200

    # Passive: observe real traffic failures
    fail_duration 30s
    max_fails 3
    unhealthy_status 500 502 503 504
}
```

> [!caution] Passive Checks and SSE/WS
> If your SSE backend sends a 500 on stream close, that counts as a failure against the upstream. Be careful with `unhealthy_status` -- only list codes that indicate a truly broken backend, not transient stream terminations.

## Streaming Configuration for SSE Backends

### flush_interval

Controls how often Caddy flushes the response buffer to the client. Critical for SSE latency.

| Value | Behavior |
|---|---|
| Default (unset) | Partial buffering for wire efficiency; streaming responses auto-detected and flushed immediately |
| `-1` | Disables all buffering; flushes immediately after every write to the client |
| `100ms` | Periodic flushing every 100ms |

Caddy auto-detects streaming responses (`Content-Type: text/event-stream`, `Content-Length: -1`, chunked transfer) and flushes them immediately. However, **explicitly set `flush_interval -1`** to guarantee correct behavior, especially when:

- Compression (`encode gzip`) is active globally (compression buffers data into blocks)
- The backend does not set the correct `Content-Type` header
- There are intermediate encoding layers that might enable buffering

```caddy
reverse_proxy /events/* {
    to backend:8080
    flush_interval -1
}
```

### stream_timeout

Maximum duration a streaming connection may remain open. After this duration, Caddy forcibly closes the stream.

- Default: no timeout (streams live as long as the backend keeps them open)
- Use to prevent connection leaks from abandoned clients
- For SSE/WS services, set to a generous value (e.g., `24h` or `72h`) or leave unset if your backend handles its own timeouts

### Full SSE-Optimized Block

```caddy
yourdomain.com {
    # SSE endpoint -- no compression, immediate flush
    reverse_proxy /events/* {
        to bridge-a:8080 bridge-b:8080

        # Streaming
        flush_interval -1
        stream_timeout 24h
        stream_close_delay 5m

        # Load balancing
        lb_policy first

        # Health checks
        health_uri /readyz
        health_interval 10s
        health_timeout 2s
        health_status 200

        fail_duration 30s
        max_fails 3
        unhealthy_status 500 502 503 504
    }

    # WebSocket endpoint
    reverse_proxy /ws/* {
        to bridge-a:8080 bridge-b:8080

        # Streaming (WS upgrade handled transparently)
        stream_timeout 24h
        stream_close_delay 5m

        # Health checks (same config)
        health_uri /readyz
        health_interval 10s
        health_timeout 2s
        health_status 200
    }
}
```

> [!warning] Compression Breaks SSE
> Do not enable `encode gzip` (or any compression) on SSE paths. Compression buffers data until a full block is ready, which delays event delivery. Use separate `handle` blocks so compression only applies to non-streaming paths.

## Reload Behavior: caddy reload and Active Streams

### Default Behavior (No stream_close_delay)

On `caddy reload`, Caddy loads the new config into a fresh server instance and begins draining the old one. By default, **streaming connections (WebSocket, SSE) are closed immediately** when the old proxy handler is unloaded. This causes:

- All active SSE streams terminate abruptly
- All WebSocket connections close without close frames
- Clients attempt reconnection simultaneously (thundering herd)

### With stream_close_delay

Setting `stream_close_delay` to a non-zero duration changes this behavior:

- Streaming connections are **not closed** when the old proxy config is unloaded
- They remain open until the delay expires
- This gives clients time to finish naturally or for the backend to send close frames
- After the delay expires, any remaining streams are forcibly closed

```caddy
reverse_proxy {
    stream_close_delay 5m   # 5-minute grace for active streams on reload
}
```

### Global grace_period (Complement)

The global `grace_period` option controls how long the old server instance waits for active HTTP requests during reload/shutdown:

```caddy
{
    grace_period 30s
}
```

This applies to regular HTTP requests. For streaming connections, `stream_close_delay` is the primary control.

### Reload Best Practices for Streaming Services

1. **Always set `stream_close_delay`** -- 5 minutes is a reasonable starting value
2. **Implement client-side reconnect logic** -- streams will eventually close; clients must handle this gracefully (exponential backoff, jitter)
3. **Reload during low-traffic windows** -- even with the delay, fewer active streams means less disruption
4. **Combine with backend shutdown frames** -- on reload, have the backend send shutdown events to SSE clients or close frames to WS clients so they reconnect promptly rather than waiting for the delay to expire
5. **Monitor with admin API** -- `curl http://localhost:2019/reverse_proxy/upstreams` shows current health state and active request counts

> [!note] Full Config Replacement
> Caddy reloads replace the entire server instance, even if only part of the config changed. Unchanged routes are still affected because the old handler is unloaded. There is no partial reload yet (open GitHub issue).

## Monitoring Health State

```bash
# Current upstream health and active request counts
curl http://localhost:2019/reverse_proxy/upstreams

# Prometheus metrics
caddy_reverse_proxy_upstreams_healthy{upstream="bridge-a:8080"} 1
caddy_reverse_proxy_upstreams_healthy{upstream="bridge-b:8080"} 0
```

Caddy emits events when upstream health transitions:
- `healthy` event -- upstream recovered from unhealthy state
- `unhealthy` event -- upstream became unhealthy

Use these for external alerting or logging.

## Quick Reference: Health Check Decision Tree

```
Do you have multiple upstreams?
├── No → Health checks provide little value (single point of failure anyway)
└── Yes
    ├── Do upstreams go offline unpredictably?
    │   └── Yes → Enable ACTIVE checks (health_uri /readyz, health_interval 10s)
    ├── Do upstreams degrade under load (slow responses, errors)?
    │   └── Yes → Enable PASSIVE checks (fail_duration, unhealthy_status)
    └── Do you serve SSE/WebSocket through this proxy?
        └── Yes → Set flush_interval -1, stream_close_delay 5m
                  Be careful with unhealthy_status on SSE paths
                  Disable compression on streaming paths
```
