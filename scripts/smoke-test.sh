#!/usr/bin/env bash
set -euo pipefail

BRIDGE_URL="${CLAUDE_STAR_BRIDGE_URL:-http://127.0.0.1:4317}"
SECRET="${CLAUDE_STAR_BRIDGE_SECRET:-${BRIDGE_SECRET:-}}"

auth_args=()
if [[ -n "${SECRET}" ]]; then
  auth_args=(-H "x-bridge-secret: ${SECRET}")
fi

echo "[1/3] bridge health"
curl -fsS "${BRIDGE_URL}/health" "${auth_args[@]}" >/dev/null

echo "[2/3] main agent state"
curl -fsS -X POST "${BRIDGE_URL}/event/manual" \
  -H "content-type: application/json" \
  "${auth_args[@]}" \
  -d '{"sessionId":"smoke-main","scope":"main","state":"writing","detail":"smoke test main"}' >/dev/null

echo "[3/3] subagent state"
curl -fsS -X POST "${BRIDGE_URL}/event/manual" \
  -H "content-type: application/json" \
  "${auth_args[@]}" \
  -d '{"sessionId":"smoke-main","scope":"subagent","agentName":"worker-1","state":"researching","detail":"smoke test subagent"}' >/dev/null

echo "smoke test passed"
