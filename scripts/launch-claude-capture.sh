#!/usr/bin/env bash
set -euo pipefail

# Launch Claude Code inside tmux with the Star Office Bridge plugin.
# Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set in env.
# Designed to run on sg01 inside a Zellij web terminal.

SESSION_NAME="${1:-claude-team}"
LAB_ROOT="${LAB_ROOT:-/root/free-code-star-office-zellij-lab}"
PLUGIN_DIR="${LAB_ROOT}/plugins/claude-star-office-bridge"
BRIDGE_URL="${CLAUDE_STAR_BRIDGE_URL:-http://127.0.0.1:4317}"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]] && [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "[launch] ERROR: Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN before running."
  echo "[launch] Example: ANTHROPIC_API_KEY=sk-... bash scripts/launch-claude-capture.sh"
  exit 1
fi

# Kill existing session
tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true

# Create tmux session inside Zellij
tmux new-session -d -s "${SESSION_NAME}" -c "${LAB_ROOT}"

# Set env and launch Claude with plugin
tmux send-keys -t "${SESSION_NAME}" \
  "CLAUDE_STAR_BRIDGE_URL=${BRIDGE_URL}" \
  " claude --plugin-dir ${PLUGIN_DIR}" \
  Enter

echo "[launch] Claude Code starting in tmux session '${SESSION_NAME}'"
echo "[launch] Attach: tmux attach -t ${SESSION_NAME}"
echo "[launch] Check bridge events: curl -s ${BRIDGE_URL}/events/recent"
