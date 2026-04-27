# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **bridge service** that connects Claude Code (or free-code) runtime hook events to Star Office UI, with Zellij as the terminal multiplexer. The bridge is a Bun HTTP server that normalizes hook events, tracks session/agent state, forwards signals to Star Office UI, and broadcasts via SSE/WebSocket. It also proxies Zellij actions over direct UDS protobuf IPC.

## Commands

```bash
bun run dev              # Start bridge server (src/index.ts)
bun run typecheck        # tsc --noEmit
bun run check:secrets    # Scan for leaked secrets
bun run check:hooks      # Validate hook coverage across free-code, plugin, and mapper
bun run check            # Full validation: typecheck + hooks + secrets
bash scripts/smoke-test.sh   # 32-step integration test (starts isolated bridge on random port)
```

No formal test framework; smoke-test.sh uses curl assertions against a live bridge.

## Architecture

```
Claude Runtime --(hook POST)--> Bridge HTTP Server --(normalized signals)--> Star Office UI
                                  |-> SessionRegistry (in-memory state)
                                  |-> SSE broadcast + WebSocket publish
                                  |-> Zellij UDS IPC (protobuf)
                                  |-> NDJSON event log (rotated, zstd-compressed)
```

### Source files (src/)

- **index.ts** (2900+ lines) — Bun.serve() entry point, all route handlers, SSE/WebSocket lifecycle, Prometheus metrics, Zellij action proxy, token management, NDJSON log rotation. This is the monolith; most changes land here.
- **stateMapper.ts** — Maps 27+ Claude hook events to 6 OfficeState values (idle/writing/researching/executing/syncing/error). Parses control-plane messages from UserPromptSubmit and Notification events.
- **sessionRegistry.ts** — In-memory Map tracking sessionId→SessionSnapshot, agentId→agentName resolution, taskId→agentName ownership for subagent lifecycle.
- **starOfficeClient.ts** — HTTP client to Star Office UI with retry (3x, exp-backoff+jitter). Routes: main→/set_state, subagent→/join-agent|/agent-push|/leave-agent.
- **zellijIpc.ts** — Direct Unix domain socket IPC to Zellij using protobuf wire format (4-byte LE length-prefix). Bypasses `zellij action` CLI for lower latency.
- **config.ts** — Env/systemd-credential config loading, timing-safe secret comparison.
- **types.ts** — Core interfaces: OfficeState, ClaudeBridgeEvent, NormalizedSignal, SessionSnapshot, BridgeConfig.

### Key HTTP endpoints

- `POST /hook/claude` — Claude hook events (legacy envelope + native HTTP format)
- `POST /hook/zellij` — Zellij session events
- `GET /events` — SSE stream with Last-Event-ID replay (64-event ring buffer)
- `GET /ws` — WebSocket bidirectional channel
- `POST /action` — Zellij action proxy (UDS IPC → CLI fallback)
- `GET /health` / `/healthz` / `/readyz` — Liveness/readiness probes
- `GET /metrics` / `/metrics/combined` — Prometheus metrics (bridge + Caddy)
- `POST /alerts/webhook` — Alertmanager receiver

### Plugins

- **plugins/claude-star-office-bridge/** — Draft Claude plugin with 27 HTTP hook subscriptions. `hooks/hooks.json` defines the event→bridge mapping.
- **plugins/zellij-session-bridge/** — Rust WASM headless plugin (zellij-tile 0.44.1) that POSTs pane/tab updates to `/hook/zellij`. Prebuilt `.wasm` included.

### Deployment (deploy/)

Systemd service with security hardening (memory limits, cgroup protection, watchdog). Caddy reverse proxy with SSE-aware flush. Prometheus + Grafana + Alertmanager configs for observability. Zellij proto files for IPC wire format.

## Configuration

Env vars (or systemd credentials): `BRIDGE_PORT` (4317), `BRIDGE_HOST` (127.0.0.1), `BRIDGE_SECRET`, `STAR_OFFICE_URL`, `STAR_OFFICE_JOIN_KEY`, `DRY_RUN`, `ZELLIJ_SESSION_NAME`, `ZELLIJ_ENABLE_WEB`. See `.env.example`.

## Conventions

- Runtime: Bun 1.3.11+ with TypeScript (ES2022, strict, Bundler resolution)
- Zellij IPC proto descriptor: `src/zellij_ipc.json` (~34K tokens, do not read unless needed)
- Event dedup uses 30-min TTL; SSE ring buffer holds 64 events; NDJSON rotates at 10MB
- Hook events handle both snake_case and camelCase field naming from different Claude versions
- Authorization uses timing-safe comparison on all hook/event endpoints
- Zellij IPC action names map to protobuf snake_case fields (e.g., `focusTabLeft` → `focus_tab_left`)
