---
title: Systemd Service Lifecycle for Long-Running HTTP Services
date: 2026-04-27
tags:
  - systemd
  - linux
  - sre
  - sse
  - production
  - service-management
aliases:
  - systemd-lifecycle
  - systemd-restart-policy
  - systemd-watchdog
---

# Systemd Service Lifecycle for Long-Running HTTP Services

Configuration patterns for systemd directives that control restart behavior, timeout handling, watchdog health-checking, OOM response, and automated actions on state transitions. Tailored for HTTP/SSE/WebSocket services that must stay up but not restart-storm when things go wrong.

> [!tip] Guiding Principle
> ==Quick recovery for transient failures, slow retries for persistent ones, hard stops for unrecoverable states.== Every directive here exists to answer: "what should the system do when the service isn't behaving?"

---

## 1. Restart Storm Prevention: StartLimitBurst / StartLimitIntervalSec

These two directives form a **rate limiter** on start attempts. They live in `[Unit]` (not `[Service]`).

| Directive | Default | Purpose |
|---|---|---|
| `StartLimitBurst` | 5 | Max start attempts within the interval window |
| `StartLimitIntervalSec` | 10s | Rolling window for counting bursts |

**How it works:** If the service is started (or auto-restarted) more than `StartLimitBurst` times within `StartLimitIntervalSec`, systemd marks the unit as **failed with result `start-limit-hit`** and refuses further restarts until:

- The interval fully elapses, or
- You manually reset via `systemctl reset-failed <unit>`

> [!warning] Default Is Aggressive
> The default 5 starts in 10 seconds is very tight. With the default `RestartSec=100ms`, a service that exits immediately will hit the start limit in ~0.5 seconds. The error message is "Start request repeated too quickly."

**Production tuning for HTTP/SSE services:**

```ini
[Unit]
StartLimitIntervalSec=120    # 2-minute rolling window
StartLimitBurst=5             # 5 restarts allowed in that window
```

This gives the service multiple chances during transient failures while preventing runaway restart loops. See also [[#6. FailureAction / SuccessAction]] for what happens when the limit is hit.

---

## 2. Exponential Backoff: RestartSec + RestartSteps + RestartMaxDelaySec

Added in **systemd >= 254**. These control how long systemd waits between restart attempts, and whether the delay grows.

| Directive | Default | Purpose |
|---|---|---|
| `RestartSec` | 100ms | Base delay before each restart attempt |
| `RestartSteps` | 0 (disabled) | Number of exponential growth steps |
| `RestartMaxDelaySec` | infinity | Cap on the maximum delay |

### How Exponential Backoff Works

When `RestartSteps > 0` and `RestartMaxDelaySec` is finite, the delay grows geometrically from `RestartSec` toward `RestartMaxDelaySec` over the specified number of steps.

**Example: `RestartSec=10s`, `RestartSteps=4`, `RestartMaxDelaySec=160s`**

```
10s -> 20s -> 40s -> 80s -> 160s (then stays at 160s)
```

**Example: `RestartSec=100ms`, `RestartSteps=5`, `RestartMaxDelaySec=10s`**

```
100ms -> ~250ms -> ~630ms -> ~1.58s -> ~3.98s -> 10s (capped)
```

> [!note] Formula
> The delay roughly doubles (factor ~2) each step, though systemd uses an internal geometric calculation for smoothness. After all steps are exhausted, the delay stays at `RestartMaxDelaySec` indefinitely.

**When `RestartSteps=0` (default):** No growth -- every restart waits exactly `RestartSec`. This is the legacy behavior.

**Production tuning for HTTP/SSE services:**

```ini
[Service]
Restart=on-failure
RestartSec=2s               # Start with a 2-second pause
RestartSteps=5              # Grow the delay over 5 steps
RestartMaxDelaySec=120s     # Cap at 2 minutes between attempts
```

This pattern gives rapid recovery for a single blip, but backs off quickly if the service is persistently failing -- preventing CPU waste, log spam, and connection churn against upstream dependencies.

> [!tip] Reset the Backoff
> After a successful run (the service stays up for at least `RestartSec`), the backoff counter resets. `systemctl reset-failed <unit>` also resets it manually.

---

## 3. Timeout Handling: TimeoutStartSec / TimeoutStopSec

These define how long systemd waits for lifecycle transitions before forcing termination. They live in `[Service]`.

| Directive | Default | Purpose |
|---|---|---|
| `TimeoutStartSec` | 90s | Max time to wait for startup signaling readiness |
| `TimeoutStopSec` | 90s | Max time to wait for graceful shutdown after SIGTERM |
| `TimeoutSec` | (shorthand) | Sets both start and stop to the same value |

### What Happens When TimeoutStartSec Expires

1. The service is considered **failed** with result `timeout`
2. systemd applies `TimeoutStartFailureMode=` (default: `terminate`):
   - **`terminate`** -- sends `KillSignal=` (default SIGTERM), then SIGKILL after `TimeoutStopSec`
   - **`abort`** -- sends `WatchdogSignal=` (default SIGABRT) for core dump, then SIGKILL after `TimeoutAbortSec`
   - **`kill`** -- sends `FinalKillSignal=` (SIGKILL) immediately, no grace period
3. The `Restart=` policy is evaluated (e.g., `on-failure` will trigger a restart)

### What Happens When TimeoutStopSec Expires

1. systemd has already sent SIGTERM (or `KillSignal=`)
2. If the process is still running after `TimeoutStopSec`, systemd sends **SIGKILL** (unless `SendSIGKILL=no`)
3. The service enters **failed** state with result `timeout`
4. `KillMode=` controls scope: `control-group` (entire cgroup), `mixed`, `process` (main PID only)

> [!danger] SIGKILL Is Unrecoverable
> SIGKILL cannot be caught, blocked, or ignored. The process gets no chance to flush buffers, close connections, or drain SSE/WebSocket clients. For real-time services, set `TimeoutStopSec` high enough for a full graceful drain, and implement SIGTERM handling in the application.

**Production tuning for HTTP/SSE services:**

```ini
[Service]
TimeoutStartSec=60s          # 1 minute to bind ports + signal readiness
TimeoutStopSec=30s           # 30 seconds for graceful drain of clients
# If using Type=notify + sd_notify("READY=1"):
# TimeoutStartSec=30s is reasonable since you control the signal

SendSIGKILL=yes              # Default; set to 'no' only if you handle cleanup externally
KillSignal=SIGTERM           # Default; SIGTERM gives the app a chance to drain
KillMode=control-group       # Default; kills entire cgroup (subprocesses too)
```

> [!warning] SSE/WebSocket Drain Window
> For services with long-lived connections, `TimeoutStopSec` must exceed the time needed to:
> 1. Stop accepting new connections
> 2. Send shutdown frames to SSE/WS clients
> 3. Wait for clients to close
> 4. Clean up subprocesses
>
> See [[readiness-vs-liveness-probes]] for the full graceful shutdown sequence.

---

## 4. WatchdogSec: Hang Detection vs. Slow Service

A **software watchdog** that detects runtime hangs even when the process is still alive. Lives in `[Service]`.

| Directive | Default | Purpose |
|---|---|---|
| `WatchdogSec` | 0 (disabled) | Max interval between watchdog pings |
| `WatchdogSignal` | SIGABRT | Signal sent when watchdog fires |

### How It Works

1. After the service reaches "running" state, systemd expects it to send `sd_notify("WATCHDOG=1")` at least every `WatchdogSec` interval
2. The environment variable `WATCHDOG_USEC` is set automatically so the process knows the deadline
3. If no ping arrives within the interval, systemd considers the service **hung** and sends `WatchdogSignal` (default SIGABRT)
4. The service is placed in failed state with result `watchdog`
5. The `Restart=` policy is evaluated (use `Restart=on-watchdog` or `on-failure` to auto-restart)

### Hang vs. Slow: How Systemd Decides

- **Hung** = no watchdog ping received. The process may be alive but is making zero forward progress (deadlock, infinite loop, frozen event loop). systemd acts decisively: SIGABRT + restart.
- **Slow but progressing** = the process sends pings but operations take time. This is ==not detected by the watchdog==. The service must either:
  - Send pings frequently enough (recommended: every `WatchdogSec / 2`)
  - Temporarily extend the deadline via `sd_notify("EXTEND_TIMEOUT_USEC=...")`

> [!note] Requires Code Changes
> WatchdogSec only works if the application calls `sd_notify("WATCHDOG=1")` periodically. Without this integration, the watchdog fires immediately. Libraries like `sd_event_set_watchdog()` in libsystemd or language bindings (e.g., `systemd.daemon.notify` in Python) simplify this.

**Production tuning for HTTP/SSE services:**

```ini
[Service]
Type=notify                  # Required for sd_notify integration
WatchdogSec=30s              # Expect a ping every 30 seconds
WatchdogSignal=SIGABRT       # Default; triggers core dump for diagnosis
Restart=on-failure           # Restarts on watchdog timeout (among other reasons)
```

In the application, ping the watchdog from the same event loop that serves HTTP/SSE:

```python
# Python example
from systemd.daemon import notify
notify(WATCHDOG=1)  # Call every ~15 seconds (WatchdogSec/2)
```

```typescript
// Bun/Node example using sd_notify over socket
const watchdogUsec = parseInt(process.env.WATCHDOG_USEC || "0");
if (watchdogUsec > 0) {
  const interval = Math.floor(watchdogUsec / 2 / 1000); // Half the deadline, in ms
  setInterval(() => sdNotify("WATCHDOG=1"), interval);
}
```

---

## 5. OOMPolicy: stop / continue / kill

Controls how systemd reacts when the kernel OOM killer or systemd-oomd terminates a process in the service's cgroup. Lives in `[Service]`.

| Value | Behavior | Best For |
|---|---|---|
| **`stop`** | Log event + cleanly stop the unit's remaining processes. Unit enters failed/inactive state. | ==Default for most services.== Predictable: the whole service goes down. |
| **`continue`** | Log event + keep running. Only the killed process is affected; the rest of the cgroup continues. | Services that can tolerate partial failure (multi-process workers, container runtimes). Default for `Delegate=yes` units. |
| **`kill`** | Set `memory.oom.group=1` on the cgroup, causing the kernel to kill ==all== remaining processes. Most aggressive. | Services where partial operation is worse than full restart (state-corruption risk). |

### When to Use Each

```ini
# Most HTTP/SSE services: stop is the safe default
OOMPolicy=stop

# Multi-worker services where one worker dying shouldn't kill the rest:
OOMPolicy=continue

# Services where partial state is dangerous (e.g., shared memory with corrupted data):
OOMPolicy=kill
```

### Interaction with Restart Policy

After OOMPolicy takes effect:
- `stop` and `kill` both result in the unit entering a failed state
- If `Restart=on-failure` (or `on-abnormal`) is set, systemd will attempt to restart
- The restart is subject to `StartLimitBurst`, `RestartSec`, backoff, etc.

> [!tip] Pair with OOMScoreAdjust
> `OOMScoreAdjust=-1000` in `[Service]` tells the kernel to never OOM-kill this process (maximum protection). `OOMScoreAdjust=+1000` makes it the first to die. For critical infrastructure services, a negative score is often warranted.

> [!warning] systemd-oomd vs. Kernel OOM
> `OOMPolicy` responds to ==both== the kernel OOM killer (reactive, system out of memory) and systemd-oomd (proactive, PSI-based cgroup killing before full system OOM). Configure `MemoryMax=` and `MemoryHigh=` in `[Service]` to set per-service memory limits that systemd-oomd enforces.

---

## 6. FailureAction / SuccessAction / StartLimitAction

Automated system-level actions triggered by service state transitions. Live in `[Unit]`.

| Directive | Default | Trigger |
|---|---|---|
| `FailureAction` | none | Unit enters **failed** state |
| `SuccessAction` | none | Unit reaches clean **inactive** state after running |
| `StartLimitAction` | none | Start rate limit (`StartLimitBurst`) is hit |

### Available Actions

| Action | What It Does | Risk |
|---|---|---|
| `none` | Do nothing (default) | None -- the unit just sits in its new state |
| `reboot` | Clean system reboot (`systemctl reboot`) | Low -- orderly shutdown of all services |
| `reboot-force` | Reboot, skip normal shutdown of services | Medium -- unflushed disk writes possible |
| `reboot-immediate` | Immediate reboot, no shutdown at all | High -- data loss risk, like pressing reset |
| `poweroff` | Clean power-off | Low -- orderly but the machine is down |
| `poweroff-force` | Power-off, skip normal shutdown | Medium |
| `poweroff-immediate` | Immediate power-off | High |
| `halt` | Halt (stop CPU, stay powered) | Low -- equivalent to `systemctl halt` |
| `kexec` | Fast reboot via kexec (skip BIOS/UEFI) | Medium -- needs pre-loaded kernel |
| `exit` | Exit the systemd manager instance | Low -- mainly for user instances or containers |

### When to Use Each

```ini
# Embedded / kiosk / appliance: reboot on failure to recover automatically
[Unit]
FailureAction=reboot
FailureActionExitStatus=1    # Only trigger on exit code 1 (optional filter)

# Temporary batch job: shut down the machine when done
[Unit]
SuccessAction=poweroff

# Prevent restart storms from escalating: notify instead of reboot
[Unit]
StartLimitAction=none        # Default; let StartLimitBurst do its job
                              # Or: StartLimitAction=reboot for self-healing appliances
```

> [!danger] FailureAction=reboot Is a Blunt Instrument
> On a multi-service production server, rebooting because one service failed can cause cascading disruption. Use `FailureAction=reboot` only on:
> - Single-purpose appliances or embedded devices
> - Kiosk / digital-signage machines
> - Nodes in a cluster where other nodes take over (and the rebooting node auto-recovers)
>
> For general servers, prefer `FailureAction=none` and let alerting + human operators decide.

### StartLimitAction in Practice

When the start rate limit is hit, the service enters `failed` state with result `start-limit-hit`. `StartLimitAction` then fires:

- `none` -- the service stays failed, alerting should notify an operator
- `reboot` -- the entire system reboots, hoping the fresh start clears the failure condition

For HTTP/SSE services behind a load balancer, `StartLimitAction=none` is correct. The load balancer routes to healthy replicas while an operator investigates the failing one.

---

## Production Template

A consolidated service file for a long-running HTTP/SSE service:

```ini
[Unit]
Description=Real-time event bridge
After=network.target
StartLimitIntervalSec=120
StartLimitBurst=5
FailureAction=none
StartLimitAction=none

[Service]
Type=notify
ExecStart=/usr/local/bin/event-bridge
Restart=on-failure
RestartSec=2s
RestartSteps=5
RestartMaxDelaySec=120s

TimeoutStartSec=60s
TimeoutStartFailureMode=terminate
TimeoutStopSec=30s

WatchdogSec=30s
WatchdogSignal=SIGABRT

OOMPolicy=stop
OOMScoreAdjust=-100

KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes

# Resource limits to prevent OOM in the first place
MemoryMax=512M
MemoryHigh=460M

[Install]
WantedBy=multi-user.target
```

> [!note] Key Interactions
> - `Restart=on-failure` + `RestartSteps` + `StartLimitBurst` = quick recovery for transient failures, backoff for persistent ones, hard stop for restart storms
> - `WatchdogSec` + `Type=notify` = runtime hang detection independent of process liveness
> - `OOMPolicy=stop` + `OOMScoreAdjust` + `MemoryMax` = layered memory protection: limit first, OOMScoreAdjust for priority, OOMPolicy for response
> - `TimeoutStopSec` must exceed the application's SIGTERM drain window (see [[readiness-vs-liveness-probes]])

---

## Quick Reference: Signal Sequence on Failure Scenarios

| Failure Scenario | First Signal | Second Signal (if no exit) | Delay Before Second |
|---|---|---|---|
| Start timeout | SIGTERM (`KillSignal`) | SIGKILL (`FinalKillSignal`) | `TimeoutStopSec` |
| Stop timeout | (SIGTERM already sent) | SIGKILL | `TimeoutStopSec` |
| Watchdog timeout | SIGABRT (`WatchdogSignal`) | SIGKILL | `TimeoutAbortSec` |
| OOM kill (stop policy) | SIGTERM | SIGKILL | `TimeoutStopSec` |
| OOM kill (kill policy) | (kernel kills entire cgroup) | -- | immediate |

---

## Version Requirements

| Directive | Minimum systemd | Notes |
|---|---|---|
| `RestartSteps` | 254 | Exponential backoff; 0 = disabled (legacy) |
| `RestartMaxDelaySec` | 254 | Cap on backoff delay |
| `TimeoutStartFailureMode` | 254 | `terminate` / `abort` / `kill` |
| `TimeoutStopFailureMode` | 254 | Same options as above |
| `OOMPolicy` | 243 | `stop` / `continue` / `kill` |
| `FailureAction` | 236 | `none` / `reboot` / `poweroff` / etc. |
| `WatchdogSec` | 214 | Software watchdog with `sd_notify` |
| `StartLimitBurst/Interval` | ~230 | Moved from `[Service]` to `[Unit]` in newer versions |

Check your version: `systemctl --version`
