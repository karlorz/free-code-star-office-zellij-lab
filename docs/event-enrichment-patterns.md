---
title: Event Enrichment Patterns
date: 2026-04-27
tags: [event-driven, middleware, observability, architecture, research]
---

# Event Enrichment Patterns

How systems enrich events with infrastructure and middleware context -- envelope formats, broker-side metadata, operational context injection, and namespace conventions. Relevant to the star-office bridge (`_bridge` field in `SignalContext`).

---

## 1. Event Envelope Patterns

### CloudEvents (CNCF Standard)

CloudEvents provides the canonical **envelope** pattern: a wrapper that separates **context attributes** (routing/processing metadata) from **business data** (the `data` payload).

**Structure:**
```
CloudEvent {
  specversion, id, source, type    // required context attributes
  time, subject, datacontenttype   // optional context attributes
  data                             // business payload only
}
```

**Key principle:** Context attributes are *minimal and serializable independently* of the payload. Middleware (routers, filters, tracers) inspects context attributes **without deserializing** business data. The `data` field is opaque to the envelope.

**Binary vs. Structured mode:**
- **Binary mode** -- context attributes map to transport headers (HTTP headers, Kafka record headers); `data` sits alone in the body. Maximizes separation: middleware reads attributes without touching payload.
- **Structured mode** -- the entire envelope (attributes + data) serializes into one JSON body. Separation is logical, not physical.

**When to add extension attributes:** Only for cross-cutting concerns useful to middleware (e.g., `correlationid`, `traceparent`). Domain-specific fields that don't serve routing belong in `data`.

### Kafka Connect SMTs (Single Message Transforms)

SMTs are **stateless per-record transformations** that enrich messages at the connector level. They access `ConnectRecord` metadata (topic, partition, offset, timestamp) but cannot do external lookups.

**Enrichment pattern via `InsertField` SMT:**
```properties
transforms=addContext
transforms.addContext.type=org.apache.kafka.connect.transforms.InsertField$Value
transforms.addContext.topic.field=source_topic
transforms.addContext.partition.field=source_partition
transforms.addContext.timestamp.field=processing_timestamp
transforms.addContext.static.field=environment
transforms.addContext.static.value=production
```

**Alternative:** `InsertHeader` / `HeaderFrom` places metadata into Kafka record headers, keeping it physically separate from the value payload -- the same binary-mode principle as CloudEvents.

**Limitation:** SMTs are single-record, no joins. For heavier enrichment (DB lookups, cross-record joins), use Kafka Streams or ksqlDB downstream.

### AWS EventBridge

EventBridge provides a **fixed top-level envelope** (`version`, `id`, `detail-type`, `source`, `account`, `time`, `region`, `resources`) with a `detail` field for the payload.

**Best practice -- inner envelope within `detail`:**
```json
{
  "detail-type": "OrderPlaced",
  "source": "com.mycompany.orderservice",
  "time": "2026-04-27T06:00:00Z",
  "detail": {
    "metadata": {
      "eventId": "01HXHM...",
      "correlationId": "trace-uuid",
      "version": "1.2",
      "environment": "production"
    },
    "data": {
      "orderId": "ORD-123",
      "total": 42.42
    }
  }
}
```

This gives **three layers of separation**: EventBridge's top-level envelope (routing), `detail.metadata` (cross-cutting context), and `detail.data` (pure business payload).

**Enrichment via Pipes:** EventBridge Pipes can enrich events with Lambda, Step Functions, or API calls at the pipe stage -- keeping the bus lightweight while adding context point-to-point.

---

## 2. Bridge/Broker Enrichment

### RabbitMQ

RabbitMQ has the **strongest broker-side enrichment** via **message interceptors** (`rabbit_msg_interceptor` behaviour). Custom Erlang modules intercept messages and stamp headers **before routing**, transparently to publishers.

**Capabilities:**
- Auto-stamp `x-opt-rabbitmq-received-time` (timestamp)
- Stamp `x-routed-by` with the handling node name
- Arbitrary enrichment: custom headers for health, load, correlation IDs
- Route on enriched headers via headers exchanges (`x-match: all | any`)

### NATS

NATS core messages are subject + payload + optional headers. Broker-side stamping is **limited and context-specific**:
- JetStream: auto headers for dedup (`Nats-Msg-Id`), tracing (`Nats-Trace-Dest`), republishing
- NATS 2.11+: server injects trace headers for debugging
- Custom enrichment typically requires a **middleware proxy or sidecar** that republishes with added headers

### Redis Pub/Sub

**No native headers or broker-side enrichment.** Messages are channel + payload only. Any metadata must be embedded in the serialized payload (e.g., JSON with a `metadata` wrapper). Redis Streams add field structures but still lack automatic broker-side injection.

### Is Per-Event Health/Status Stamping Standard?

**No -- it is an anti-pattern.** Stamping broker health (CPU, load, healthy/unhealthy) on every event:

| Problem | Why |
|---------|-----|
| Redundant overhead | Millions of events x extra bytes = significant CPU/bandwidth/storage cost |
| Stale data | Broker health at publish time is outdated by consumption time |
| Pollutes business events | Couples domain events to transient infrastructure state |
| Schema complexity | Health fields complicate schema evolution and replay |

**Instead, use** dedicated broker-level metrics (Prometheus), distributed tracing (correlation IDs in headers), and separate health endpoints. Correlate events with infrastructure health via trace context at query time, not at publish time.

---

## 3. Operational Context in Signals

### Kubernetes Downward API

Injects pod metadata into containers **at startup** without calling the API server:
```yaml
env:
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: POD_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
```
Also via `downwardAPI` volume (files with labels, annotations, resource limits). Apps read `$POD_NAME` or `/etc/podinfo/labels` and include this context in events, traces, and gRPC metadata.

### Envoy + gRPC Metadata

Envoy sidecars propagate context via gRPC metadata (key-value pairs like HTTP headers for RPCs). Downward API values map into gRPC metadata via:
- Application code reading env vars and setting `grpc.metadata`
- Envoy filters (Lua, external auth, header manipulation)
- gRPC credential extensions

This adds "infrastructure context" to every RPC call: pod name, namespace, node, trace context.

### Consul Service Health in DNS

Consul's DNS interface (`service-name.virtual.consul`) returns **only healthy instances** by default. Health status is embedded in the DNS response implicitly (unhealthy nodes are absent from results). Consul syncs Kubernetes liveness/readiness probes into its own health checks. Applications discover only healthy services without explicitly checking health.

### OpenTelemetry Trace Enrichment

OTel enriches signals at multiple levels:

| Layer | What's injected | Scope |
|-------|----------------|-------|
| Resource attributes | `service.name`, `host.name`, `k8s.pod.name`, `deployment.environment` | All signals from a service instance |
| Span attributes | `http.method`, `db.statement`, custom business keys | Single operation |
| Baggage | Arbitrary key-values propagated across service boundaries | Entire request chain |
| Collector processors | `k8sattributes`, `resourcedetection` -- centralized enrichment | At collection pipeline |

**Key distinction:** Resource attributes = static infrastructure metadata (like Downward API). Span attributes = per-operation context. Baggage = request-scoped cross-service propagation.

### Datadog Reference Tables

Datadog's enrichment approach uses **lookup tables** (from S3, Snowflake, etc.) to join external context onto telemetry at ingestion time -- no code changes needed. Host Info panels attach infrastructure metrics to traces. Unified service tagging (`DD_ENV`, `DD_SERVICE`, `DD_VERSION`) ensures consistent metadata across metrics, traces, and logs.

---

## 4. Namespace Conventions

### Preventing Middleware vs. Application Field Collision

| Convention | Example | Used By | Strengths | Weaknesses |
|-----------|---------|---------|-----------|------------|
| **Underscore prefix** | `_bridge.healthFailures` | journald (`_PID`, `_SYSTEMD_UNIT`), Adobe XDM (`_tenant.field`) | Clear "system/internal" marker; consumers know to ignore | Some parsers treat `_` as private; can be stripped during processing |
| **x- prefix** | `x-correlation-id` | HTTP headers, event metadata | Familiar from HTTP convention; signals "non-standard extension" | Ambiguous: "experimental" vs "vendor-specific"; RFC 6648 deprecated `x-` for HTTP headers |
| **Nested namespace object** | `{ "metadata": { ... }, "data": { ... } }` | CloudEvents, EventBridge, EventGrid | Cleanest separation; no flat-key collision risk | Slightly more serialization overhead; requires schema awareness |
| **Reverse-domain prefix** | `com.mycompany.field` | OpenTelemetry semantic conventions, Protobuf packages | Globally unique; scales across organizations | Verbose; awkward in flat key-value stores |
| **Dot-separated hierarchy** | `myapp.customer.tier`, `otel.sdk.name` | OpenTelemetry, DNS | Readable; sortable; works when flattened | Language-dependent (some don't allow dots in identifiers) |

### OpenTelemetry Semantic Conventions (Current Best Practice)

- Standard namespaces: `http.`, `db.`, `messaging.`, `otel.` -- **never extend these**
- Custom attributes: **must** use a unique namespace prefix (reverse domain or app-specific like `myapp.`)
- Format: lowercase, dot-separated, snake_case components
- Example: `acme.payment.transaction_id` (not just `transaction_id`)

### Adobe XDM Convention

- Tenant namespace prefixed with underscore: `_mycompany.contentCategory`
- The `_tenantId` prefix is often stripped during processing
- Prevents collision between standard XDM fields and custom extensions

### For the Bridge (`_bridge` pattern)

The bridge's `_bridge` field in `SignalContext` follows the **underscore prefix + nested namespace** pattern:

```typescript
_bridge?: {
  zellijSessionHealthy: boolean;
  zellijHealthFailures: number;
  zellijRecoveryAttempts: number;
  zellijRecoverySuccesses: number;
};
```

This is consistent with:
- The **underscore prefix** convention (marks system/internal metadata, not business data)
- The **nested namespace object** convention (all bridge-injected fields live under one key, zero collision risk with application fields like `zellijEvent`, `zellijPaneCount`)
- The journald pattern where `_`-prefixed fields are trusted/system and cannot be altered by apps

**Recommendation for extending `_bridge`:** Add new infrastructure context as sub-fields within `_bridge` (e.g., `_bridge.wsConnections`, `_bridge.sseBufferDepth`). Never add `_`-prefixed keys at the top level of `SignalContext` -- reserve that namespace for the bridge system.

---

## Quick Reference: Pattern Selection

| You want to... | Use this pattern |
|----------------|-----------------|
| Separate routing metadata from business data | CloudEvents envelope (context attrs vs `data`) |
| Enrich at the connector/ingestion layer | Kafka Connect SMTs (`InsertField` for value, `InsertHeader` for headers) |
| Add context at the event bus layer | EventBridge inner envelope (`detail.metadata` + `detail.data`) |
| Stamp broker-side metadata transparently | RabbitMQ message interceptors |
| Propagate context across service boundaries | OpenTelemetry baggage + W3C Trace Context |
| Inject pod/infra identity into app events | Kubernetes Downward API -> env vars / gRPC metadata |
| Prevent field name collision | Underscore prefix (`_bridge`) + nested namespace, or reverse-domain prefix |
| Include infrastructure health | Separate metrics pipeline (Prometheus); correlate by trace ID at query time, NOT per-event stamping |
