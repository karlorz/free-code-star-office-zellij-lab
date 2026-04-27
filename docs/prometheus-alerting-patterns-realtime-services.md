---
title: Prometheus Alerting Patterns for Real-Time Services
date: 2026-04-27
tags:
  - prometheus
  - alerting
  - sre
  - alertmanager
  - slo
  - sse
  - websocket
  - real-time
aliases:
  - prometheus-alerting-patterns
  - alert-best-practices
  - burn-rate-alerting
---

# Prometheus Alerting Patterns for Real-Time Services

Best practices for Prometheus alerting on HTTP/SSE/WebSocket backends. Covers severity taxonomy, grouping, recording rules, `for` duration tuning, SLO-based burn-rate alerting, and Alertmanager timing. Informed by the star-office-bridge alert rules (`deploy/prometheus/star-office-bridge-alerts.yml`) and Alertmanager config (`deploy/alertmanager/alertmanager.yml`).

> [!tip] Guiding Principle
> ==Alert on symptoms, not causes.== A user sees latency or errors, not CPU percentage. Every alert that fires must be **actionable** — if nobody knows what to do when it fires, it is noise.

---

## 1. Severity Conventions: Critical / Warning / Info

Prometheus has no built-in severity; the `severity` label is a user-defined string used by Alertmanager for routing. Community convention has converged on three levels:

| Severity | Meaning | Action | Routing | Examples |
|----------|---------|--------|---------|---------|
| **critical** | Immediate action required; outage or severe degradation | Page on-call | PagerDuty / Opsgenie | Instance down, upstream unhealthy, OOM imminent |
| **warning** | Degraded performance; investigate soon | Notify asynchronously | Slack / email | High latency, elevated error rate, memory trending up |
| **info** | Awareness only; no human action needed | Log / dashboard | None (or low-priority channel) | Process restarted, client count high, deployment note |

> [!warning] Avoid a fourth "error" level
> Three levels suffice for most teams. Adding intermediate levels creates ambiguity about response expectations and increases routing complexity.

### Rules of Thumb

- **Critical alerts should be rare** — aim for <5 per incident. If critical fires more than a few times per week outside real incidents, either the threshold is wrong or it should be a warning.
- **Warning alerts should be reviewable** — they inform without demanding immediate action. Slack or email queues are appropriate.
- **Info alerts should never wake anyone** — they exist for dashboards, post-hoc analysis, and audit trails. `severity: info` on `BridgeProcessRestarted` is a good example from the current rules.
- Always include `summary` (short) and `description` (detailed with `$value` and `$labels`) annotations.

---

## 2. Alert Grouping and Routing: Avoiding Alert Fatigue

A single root cause (e.g., upstream down) can cascade into dozens of related alerts. Without grouping, one incident floods every channel.

### group_by Strategy

Group alerts by **operational boundaries** that match how teams investigate:

```yaml
group_by: ['alertname', 'service', 'severity', 'env']
```

- Too broad (`group_by: ['alertname']` only) merges unrelated alerts.
- Too narrow (no `group_by`) sends one notification per alert — instant fatigue during outages.
- Include `severity` in `group_by` to keep critical and warning notifications separate.

### Inhibition Rules

Suppress downstream symptoms when a root-cause alert is already firing:

```yaml
inhibit_rules:
  - source_matchers:
      - 'severity="critical"'
    target_matchers:
      - 'severity="warning"'
    equal: ['alertname', 'service']  # only inhibit same service/alert
```

This mutes `BridgeHighMemory` (warning) when `BridgeCriticalMemory` (critical) fires for the same instance.

### Routing Tree

Structure routes around team ownership and severity:

```yaml
route:
  receiver: default
  group_by: ['alertname', 'service', 'severity']
  routes:
    - matchers: ['severity="critical"']
      receiver: pagerduty
    - matchers: ['severity="warning"']
      receiver: slack
    - matchers: ['severity="info"']
      receiver: logging  # or no receiver at all
```

> [!note] For the star-office-bridge
> The current `alertmanager.yml` is mostly empty. A recommended starting config is provided in section 6 below.

---

## 3. Recording Rules vs On-the-Fly PromQL

Recording rules precompute a PromQL expression at a fixed interval and store the result as a new time series. They trade storage/memory for query-time speed.

### When Recording Rules Are Worth It

| Condition | Why it matters |
|-----------|---------------|
| Expression used in **multiple alerts or dashboards** | Compute once, consume many times |
| **Multi-level aggregation** (e.g., `sum(rate(...)) by (job)` over thousands of series) | 10-100x faster at query time |
| **histogram_quantile()** over high-cardinality buckets | `rate()` + `sum by(le)` is expensive; pre-recording avoids recomputation |
| **Ratio expressions** (numerator/denominator) | Division is sensitive to evaluation timing; recording ensures consistency |

### When On-the-Fly PromQL Is Fine

- Ad-hoc exploration in Grafana or Prometheus UI
- Low-cardinality single-instance counters (e.g., `rate(bridge_uptime_seconds[5m])`)
- Expressions evaluated infrequently
- When you need maximum freshness (recording rules have up to evaluation-interval staleness)

### Naming Convention

Follow `level:metric:operations` — e.g., `caddy:error_5xx_ratio:rate5m`, `bridge:http_request_duration:p95`. The current recording rules already follow this convention well.

### Overhead Warning

Each recording rule creates a new time series (~4 KiB per series). For single-instance services like star-office-bridge, this overhead is negligible. It becomes a concern only at high cardinality (thousands of label combinations).

> [!tip] Practical rule
> If a PromQL expression takes >1s to evaluate or appears in 3+ places, make it a recording rule. Otherwise, leave it on-the-fly.

---

## 4. `for` Duration and Range Vector Tradeoffs

The `for:` clause keeps an alert in **pending** state until the condition holds true continuously for the specified duration. This is the primary anti-flapping mechanism.

### How `for` Affects Sensitivity vs Noise

| `for` value | Sensitivity | Noise | Best for |
|-------------|------------|-------|----------|
| `0m` (none) | Maximum | High | Process restarts, state changes that are inherently instantaneous |
| `1-2m` | High | Moderate | Instance down, upstream unhealthy (things that are genuinely binary) |
| `5-10m` | Moderate | Low | Rate-based alerts (error rate, latency), where transient spikes are common |
| `15m+` | Low | Minimal | Noisy gauges, trending conditions where you want sustained evidence |

### Range Vector Window (`[5m]` vs `[30m]`)

The range vector window in `rate(metric[5m])` controls smoothing independently from `for:`:

- **Short window** (`[1-5m]`): responsive, but noisy on spiky metrics like request rates.
- **Long window** (`[15-30m]`): smooth, but lags behind sudden changes. Useful for slow-burn detection.
- **Combine**: Use `rate(...[5m])` with `for: 5-10m` for most real-time service alerts. The range window smooths per-evaluation jitter; `for:` adds sustained-condition certainty.

### Current Rule Assessment (star-office-bridge)

| Alert | `for:` | Assessment |
|-------|--------|------------|
| `BridgeCriticalMemory` | 2m | Good — OOM is urgent |
| `CaddyUpstreamDown` | 1m | Good — binary state, short `for:` avoids paging on single scrape miss |
| `BridgeHighMemory` | 5m | Good — warning level, needs sustained evidence |
| `BridgeSSEClientsDropped` | 2m | Reasonable — but `deriv()` over `[5m]` is already noisy; consider 5m |
| `BridgeHighSignalDedup` | 10m | Good — ratio alerts are prone to flapping |
| `BridgeSSEClientCountHigh` | 15m | Good — info-level, no urgency |
| `BridgeProcessRestarted` | 0m | Correct — restart is an event, not a sustained condition |

### Advanced: `keep_firing_for`

Prometheus 2.55+ supports `keep_firing_for` to prevent an alert from resolving during brief recoveries. Useful for flappy metrics where a 30-second recovery should not clear the alert:

```yaml
- alert: BridgeHighMemory
  expr: ...
  for: 5m
  keep_firing_for: 5m  # stays firing even if condition dips briefly
```

---

## 5. SLO-Based Alerting: Burn Rate vs Threshold

### The Problem with Static Thresholds

Alerting on `error_rate > 0.5%` for 5 minutes causes:
- **Alert fatigue**: Brief spikes that consume negligible error budget fire alerts.
- **Missed slow burns**: A 0.4% error rate sustained for days exhausts the budget without ever firing.

### Burn Rate Concept

**Burn rate** = how fast the error budget is being consumed relative to the SLO period.

```
burn_rate = observed_error_rate / (1 - SLO_target)
```

- Burn rate = 1: on track to exactly use the full budget by end of SLO window.
- Burn rate = 14.4: will exhaust the monthly budget in ~2 days (for a 30-day window).

### Multi-Window, Multi-Burn-Rate Alerting

The Google SRE workbook recommends combining **short + long observation windows** with different burn-rate thresholds:

| Policy | Short Window | Long Window | Burn Rate | Severity | Action |
|--------|-------------|-------------|-----------|----------|--------|
| Fast burn | 5m | 1h | >14.4 | critical | Page immediately |
| Slow burn | 30m | 6h | >6 | warning | Create ticket / Slack |

Both windows must exceed the threshold — this prevents short spikes from triggering slow-burn alerts and ensures sustained conditions before paging.

### Implementation Pattern

```yaml
# Recording rules for burn rates
- record: job:error_budget:burn_rate:1h
  expr: >
    (1 - sum(rate(http_requests_total{code!~"5.."}[1h]))
          / sum(rate(http_requests_total[1h])))
    / (1 - 0.999)  # 1 - SLO target

- record: job:error_budget:burn_rate:5m
  expr: >
    (1 - sum(rate(http_requests_total{code!~"5.."}[5m]))
          / sum(rate(http_requests_total[5m])))
    / (1 - 0.999)

# Alerting rules
- alert: SLOFastBurn
  expr: >
    job:error_budget:burn_rate:1h > 14.4
    and job:error_budget:burn_rate:5m > 14.4
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Fast error budget burn: ~2% budget consumed in 1h"

- alert: SLOSlowBurn
  expr: >
    job:error_budget:burn_rate:6h > 6
    and job:error_budget:burn_rate:30m > 6
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Slow error budget burn: degraded performance"
```

### When to Use Each Approach

| Approach | Best for | Tradeoff |
|----------|----------|----------|
| **Static threshold** | Simple services, no defined SLO, infrastructure metrics (disk, CPU) | Easy to implement; no SLO context |
| **Burn rate** | User-facing services with defined SLOs (99.9%+) | Requires SLO definition and recording rules; far superior signal-to-noise |

> [!tip] For the star-office-bridge
> The current alerts use static thresholds (e.g., `caddy:error_5xx_ratio:rate5m > 0.05`). This is reasonable for a single-instance service. Consider burn-rate alerting if/when an explicit SLO is defined (e.g., "99.5% of SSE events delivered within 5 seconds over 30 days").

---

## 6. Alertmanager Interval Tuning by Severity

Three timing parameters control notification delivery cadence:

| Parameter | Meaning | Default |
|-----------|---------|---------|
| `group_wait` | Wait before sending the first notification for a new group (batching window) | 30s |
| `group_interval` | Min time between notifications for the same group when new alerts arrive | 5m |
| `repeat_interval` | How often to re-notify about still-firing alerts with no changes | 4h |

### Recommended Values by Severity

| Severity | `group_wait` | `group_interval` | `repeat_interval` | Rationale |
|----------|-------------|-------------------|-------------------|-----------|
| **critical** | 10-15s | 1-2m | 1-4h | Fast initial page; frequent updates during active incidents; re-notify sooner so on-call doesn't forget |
| **warning** | 30s-2m | 5-15m | 4-24h | Allow batching; updates less urgent; re-notify infrequently |
| **info** | 1-15m | 15-30m | 24h+ | Maximize batching; these rarely need human eyes |

### Constraints

- `repeat_interval` should be a **multiple of** `group_interval` to avoid timing edge cases.
- `evaluation_interval` should be **<= `for:` / 2** to ensure consistent pending timing (default 1m is usually fine).
- Include `severity` in `group_by` so different severities for the same alert name produce separate notification groups.

### Recommended Config for star-office-bridge

```yaml
global:
  resolve_timeout: 5m

route:
  receiver: default
  group_by: ['alertname', 'service', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: ['severity="critical"']
      receiver: pagerduty
      group_wait: 15s
      group_interval: 2m
      repeat_interval: 2h
    - matchers: ['severity="warning"']
      receiver: slack
      group_wait: 1m
      group_interval: 10m
      repeat_interval: 12h
    - matchers: ['severity="info"']
      receiver: logging
      group_wait: 5m
      group_interval: 30m
      repeat_interval: 24h

inhibit_rules:
  - source_matchers: ['severity="critical"']
    target_matchers: ['severity="warning"']
    equal: ['alertname', 'service']
```

---

## Quick Reference: Decision Flowchart

```
Is the condition user-facing (errors, latency, availability)?
  YES -> Define an SLO and use burn-rate alerting (section 5)
  NO  -> Use static threshold with appropriate severity (section 1)

Is the PromQL expression slow (>1s) or used in 3+ places?
  YES -> Create a recording rule (section 3)
  NO  -> Keep it on-the-fly

Is the metric spiky (rate, CPU, queue depth)?
  YES -> Use range vector [5m+] AND for: 5-10m (section 4)
  NO  -> Is the condition binary (up/down)?
    YES -> for: 1-2m
    NO  -> for: 5m minimum

Are multiple similar alerts firing together?
  YES -> Tune group_by and add inhibition rules (section 2)
         Adjust intervals by severity (section 6)
```

---

## Further Reading

- [Prometheus Alerting Rules Docs](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)
- [Alertmanager Configuration](https://prometheus.io/docs/alerting/latest/configuration/)
- [Google SRE Workbook: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
- [Prometheus Practices: Alerting](https://prometheus.io/docs/practices/alerting/)
- [Prometheus Practices: Recording Rules](https://prometheus.io/docs/practices/rules/)
