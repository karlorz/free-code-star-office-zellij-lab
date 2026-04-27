---
title: Readiness vs Liveness Probes for Real-Time Bridges
date: 2026-04-27
tags:
  - kubernetes
  - observability
  - sse
  - websocket
  - caddy
  - probes
aliases:
  - readiness-liveness-probes
  - health-check-best-practices
---

# Readiness vs Liveness Probes for Real-Time Bridges

Best practices for Kubernetes-style health probes on SSE/WebSocket backend services. Informed by current implementation in [[zellij-session-resilience]] and the bridge's `/healthz`, `/readyz`, `/health` endpoints.

## Probe Semantics: What Each One Means

| Probe | Question It Answers | Failure Consequence | HTTP Code |
|---|---|---|---|
| **Liveness** (`/healthz`) | "Is the process alive and not deadlocked?" | Container is **killed and restarted** | 200 = alive, anything else = dead |
| **Readiness** (`/readyz`) | "Should new traffic be routed here?" | Pod **removed from Service endpoints** (no restart) | 200 = ready, 503 = not accepting traffic |
| **Startup** | "Has initialization completed?" | Blocks both liveness and readiness until pass | 200 = init done |

> [!warning] Critical Distinction
> Liveness failure = restart the container. Readiness failure = stop routing new requests but keep running. Never conflate these -- a pod can be "alive but not ready" (e.g., draining, dependency warming).

### When `/readyz` Returns 503

- During graceful shutdown (after SIGTERM received)
- When a strictly-required local dependency is down (see caveats below)
- During startup before the service can meaningfully handle requests
- Under intentional load-shedding (overload protection)

### When `/healthz` Returns Non-200

- Application process is deadlocked, crashed, or in an unrecoverable loop
- The event loop is stalled (e.g., GC thrashing, unresponsive main thread)
- **Never** for transient issues, dependency failures, or temporary overload -- these trigger unnecessary restarts that make things worse

> [!tip] Restaurant Analogy
> - Liveness = "Is the kitchen on fire?" If yes, call emergency services (restart).
> - Readiness = "Are we seating new customers?" If no, turn away at the door (remove from endpoints) but keep cooking for seated guests.

## Should Readiness Check Downstream Dependencies?

> [!danger] The Cascading Failure Trap
> If readiness pings a shared downstream dependency and that dependency goes down, **all replicas** fail readiness simultaneously. The entire service disappears from load balancers -- a self-inflicted total outage.

### Recommended Approach

**Default: readiness checks only the service's own ability to accept traffic.**

- Internal state (event loop responsive, not shutting down)
- Local capacity (connection pool not exhausted, memory not critical)
- Basic HTTP responsiveness (the endpoint itself returning)

**Checking downstream deps in readiness is acceptable only when:**

1. The dependency is **private/isolated** to this pod (not shared across all replicas)
2. The service **cannot serve any useful response** without it (partial degradation is impossible)
3. You use **high `failureThreshold`** and **long `periodSeconds`** to tolerate transients
4. You pair it with **circuit breakers** and **graceful degradation** in application code

### For This Bridge: Zellij Session Health

The bridge's `/readyz` currently checks `metrics.zellijSessionHealthy === 0` and returns 503 if the zellij session is unhealthy. This is a **borderline case** -- the bridge exists primarily to relay zellij events, so without a healthy session it cannot fulfill its core purpose. However, it can still serve:

- Dashboard UI (`/events/test`)
- Health/metrics endpoints
- WebSocket/SSE reconnect frames
- Alert webhook ingestion (queued)

> [!question] Current Tradeoff
> If all bridge replicas share the same zellij session and it goes down, every replica returns 503 simultaneously. If each replica has its own isolated session, the check is safer. Consider making zellij health a **weighted factor** rather than a binary gate -- return 503 only after N consecutive failures (already tracked via `zellijHealthConsecutiveFailures`), not on the first miss.

## Caddy Reverse Proxy Integration

Caddy uses upstream health checks to decide which backends receive traffic. Two modes:

### Active Health Checks (Background Probing)

Caddy periodically sends HTTP requests to each upstream, independent of user traffic:

```caddy
reverse_proxy {
    to bridge-a:8080 bridge-b:8080

    lb_policy first  # Primary/failover routing

    # Active checks -- probe /readyz in the background
    health_uri /readyz
    health_interval 10s
    health_timeout 5s
    health_status 200   # Only 200 = healthy (503 marks upstream down)

    # Passive checks -- observe real traffic failures
    fail_duration 30s
    max_fails 3
    unhealthy_status 500 502 503 504
}
```

- Caddy marks an upstream **down** when `health_uri` returns non-200 (e.g., 503 from `/readyz`)
- Down upstreams are excluded from routing until they pass the health check again
- Use `lb_policy first` for active-passive (primary preferred, failover on failure)
- Use `lb_policy least_conn` for active-active with connection-aware distribution

### Passive Health Checks (Observing Real Traffic)

Caddy watches actual proxied requests for failure signals:

- `fail_duration` -- how long to keep an upstream marked down after failures
- `max_fails` -- consecutive failures before marking down
- `unhealthy_status` -- response codes that count as failures
- `unhealthy_latency` -- mark down if responses exceed threshold

> [!tip] Combine Both Modes
> Active checks catch problems before user traffic hits a sick backend. Passive checks catch issues that active probes miss (e.g., slow responses under real load). Use both.

### Monitoring Caddy Health State

```bash
# Inspect current upstream health via admin API
curl http://localhost:2019/reverse_proxy/upstreams
```

This returns JSON showing each upstream's health status, enabling external alerting.

## Anti-Patterns for Real-Time Services

> [!bug] What NOT to Put in Readiness Checks

1. **Same endpoint for liveness and readiness** -- Conflating them means shutdown/drain causes unnecessary restarts, or dependency failures cause traffic blackholing with no recovery path.

2. **Heavy downstream dependency checks** -- Full DB queries, external API calls, or deep health chains in probes. These cause self-DoS under probe load and cascade failures across the system.

3. **Checking shared downstream deps in readiness** -- If every replica depends on the same DB/cache and it blips, the entire service vanishes from load balancers. Use application-level circuit breakers instead.

4. **No shutdown awareness in readiness** -- If `/readyz` stays 200 during SIGTERM, new connections hit a dying pod. If `/healthz` fails during drain, the pod gets killed before connections close.

5. **Assuming pod removal instantly drains long-lived connections** -- Kubernetes stops routing **new** traffic when readiness fails, but existing SSE/WebSocket connections remain open. SIGKILL after `terminationGracePeriodSeconds` will hard-close them.

6. **Overly aggressive probe tuning** -- Low `failureThreshold` + low `periodSeconds` = rapid flapping. Real-time services need tolerance for brief transients (a single missed health ping should not evict a pod).

7. **Startup traffic before readiness** -- Without `startupProbe` or `initialDelaySeconds`, Kubernetes may route traffic before the SSE/WebSocket server has initialized its event streams or established downstream connections.

## Graceful Shutdown Sequence

The correct order for SIGTERM handling in a real-time bridge:

```
SIGTERM received
    |
    v
1. Set isShuttingDown = true
    |
    v
2. /readyz immediately returns 503
   --> K8s removes pod from Service endpoints
   --> Caddy marks upstream down (if health_uri = /readyz)
   --> No NEW connections/requests routed
    |
    v
3. Send shutdown frames to existing clients
   --> SSE: enqueue shutdown event, close controller
   --> WS: publish shutdown message, send close frames
    |
    v
4. Stop accepting new connections
   --> server.stop(false) -- non-destructive
    |
    v
5. Drain in-flight requests
   --> Wait for active HTTP requests to complete
   --> Wait for SSE/WS clients to receive close frames
   --> Bun.sleep(2000) or configurable drain window
    |
    v
6. /healthz still returns 200 during drain
   --> Prevents K8s from restarting the container
   --> Liveness only fails AFTER drain is complete
    |
    v
7. Clean up background resources
   --> Kill subprocesses (zstd, etc.)
   --> Flush log sinks
   --> Persist final metrics
    |
    v
8. Process exits (or liveness eventually fails)
   --> K8s sends SIGKILL after terminationGracePeriodSeconds
```

### Key Timing Constraints

```yaml
# For WebSocket/SSE services, extend the grace period
terminationGracePeriodSeconds: 60  # Default 30s is often too short

lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 5"]
      # Gives K8s time to update endpoints before SIGTERM
      # (endpoints propagation can take 5-10s)

readinessProbe:
  httpGet:
    path: /readyz
  periodSeconds: 5
  failureThreshold: 1   # Fail fast -- evict immediately on shutdown

livenessProbe:
  httpGet:
    path: /healthz
  periodSeconds: 10
  failureThreshold: 5   # Tolerate slow drain -- don't restart
  initialDelaySeconds: 15
```

> [!warning] The PreStop Delay Matters
> When a pod is deleted, K8s simultaneously: (a) sends SIGTERM to the container, and (b) begins removing the pod from Service endpoints. Endpoint propagation is **asynchronous** and can take 5-10 seconds. Without a `preStop` sleep, new traffic may still arrive between SIGTERM and endpoint removal. The sleep ensures `/readyz` returns 503 and endpoints update **before** the app starts draining.

### Current Bridge Implementation

The bridge at `/src/index.ts` already follows most of this pattern:

- `isShuttingDown` flag set immediately on SIGTERM
- `/readyz` returns 503 when `isShuttingDown` is true
- `/healthz` is a simple "ok" that stays 200 throughout drain
- SSE clients receive shutdown event + controller close
- WebSocket clients receive shutdown publish
- 2-second drain window via `Bun.sleep(2000)`
- Background subprocess cleanup with 5-second timeout

**Potential improvements:**
- Add a `preStop` hook with 5-second sleep for endpoint propagation
- Increase `terminationGracePeriodSeconds` beyond default 30s
- Consider making zellij health a soft factor in readiness (N consecutive failures before 503) rather than a hard gate
- Add `/livez` as a distinct liveness endpoint (separate from the informational `/healthz`) that explicitly checks only process health

## Decision Matrix

| Scenario | /healthz | /readyz | Action |
|---|---|---|---|
| Normal operation | 200 | 200 | Serve traffic |
| Zellij session blip | 200 | 200 (soft) or 503 (hard) | Prefer soft -- tolerate transient |
| Zellij session down N times | 200 | 503 | Stop routing, don't restart |
| During graceful shutdown | 200 | 503 | Drain connections, no restart |
| Process deadlock | non-200 | non-200 | Restart container |
| Startup / init | blocked by startupProbe | blocked by startupProbe | Wait for init |
| Memory pressure / overload | 200 | 503 | Shed load without restart |
