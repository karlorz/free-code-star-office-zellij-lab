#!/usr/bin/env bash
# bridge-watchdog.sh — systemd watchdog wrapper for Star Office Bridge
#
# Bun cannot natively call sd_notify(). This wrapper:
# 1. Sends --ready after the bridge process starts
# 2. Loops checking /healthz and sending WATCHDOG=1 every 10s
# 3. If /healthz fails, stops sending — systemd restarts after WatchdogSec
#
# Usage in star-office-bridge.service:
#   Type=notify
#   ExecStart=/opt/bridge-watchdog.sh /root/.bun/bin/bun run src/index.ts
#   WatchdogSec=30
#   NotifyAccess=main

set -euo pipefail

BRIDGE_URL="${BRIDGE_WATCHDOG_URL:-http://127.0.0.1:4317/healthz}"
CHECK_INTERVAL=10

# Signal readiness once process is launched
systemd-notify --ready

# Background: start the bridge process
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
