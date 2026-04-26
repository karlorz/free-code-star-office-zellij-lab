#!/usr/bin/env bash
# bridge-watchdog.sh — systemd watchdog wrapper for Star Office Bridge
#
# The bridge process itself sends READY=1 via systemd-notify after Bun.serve()
# starts listening. This wrapper only handles the WATCHDOG=1 heartbeat loop.
#
# DO NOT send --ready from this wrapper — it would race ahead of the bridge
# and report readiness before the HTTP server is actually accepting connections.
#
# Usage in star-office-bridge.service:
#   Type=notify
#   ExecStart=/opt/bridge-watchdog.sh /root/.bun/bin/bun run src/index.ts
#   WatchdogSec=30
#   NotifyAccess=main

set -euo pipefail

BRIDGE_URL="${BRIDGE_WATCHDOG_URL:-http://127.0.0.1:4317/healthz}"
CHECK_INTERVAL=10

# Background: start the bridge process
# (bridge sends READY=1 itself after Bun.serve() is listening)
"$@" &
BRIDGE_PID=$!

# Watchdog loop
while kill -0 "$BRIDGE_PID" 2>/dev/null; do
  if curl -sf --max-time 3 "$BRIDGE_URL" >/dev/null 2>&1; then
    systemd-notify WATCHDOG=1
  fi
  sleep "$CHECK_INTERVAL"
done

# Bridge exited — forward its exit code
wait "$BRIDGE_PID" 2>/dev/null
exit $?
