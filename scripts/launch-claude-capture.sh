#!/usr/bin/env bash
set -euo pipefail

# Launch Claude Code inside tmux with the Star Office Bridge plugin.
# Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set in env.
# Designed to run on sg01 inside a Zellij web terminal.
#
# Modes:
#   interactive (default)  — full TUI inside tmux, hooks fire on all events
#   -p / --print "prompt"  — non-interactive, single prompt, hooks still fire
#
# Do NOT use --bare: it disables plugins and hooks.

SESSION_NAME="${1:-claude-team}"
LAB_ROOT="${LAB_ROOT:-/root/free-code-star-office-zellij-lab}"
PLUGIN_DIR="${LAB_ROOT}/plugins/claude-star-office-bridge"
BRIDGE_URL="${CLAUDE_STAR_BRIDGE_URL:-http://127.0.0.1:4317}"
CAPTURE_PROMPT="${CAPTURE_PROMPT:-}"
EXTRA_ARGS=()

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--print)
      shift
      CAPTURE_PROMPT="${1:-}"
      shift
      ;;
    -o|--output-format)
      EXTRA_ARGS+=("--output-format" "$2")
      shift 2
      ;;
    --max-turns)
      EXTRA_ARGS+=("--max-turns" "$2")
      shift 2
      ;;
    --max-budget)
      EXTRA_ARGS+=("--max-budget-usd" "$2")
      shift 2
      ;;
    --allowed-tools)
      EXTRA_ARGS+=("--allowedTools" "$2")
      shift 2
      ;;
    *)
      SESSION_NAME="$1"
      shift
      ;;
  esac
done

if [[ -z "${ANTHROPIC_API_KEY:-}" ]] && [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "[launch] ERROR: Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN before running."
  echo "[launch] Example: ANTHROPIC_API_KEY=sk-... bash scripts/launch-claude-capture.sh"
  exit 1
fi

# Skip onboarding if not yet done
if [[ ! -f ~/.claude.json ]]; then
  echo '{"hasCompletedOnboarding": true}' > ~/.claude.json
  echo "[launch] Skipped onboarding via ~/.claude.json"
fi

# Kill existing session
tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true

# Create tmux session inside Zellij
tmux new-session -d -s "${SESSION_NAME}" -c "${LAB_ROOT}"

# Build command
CMD="CLAUDE_STAR_BRIDGE_URL=${BRIDGE_URL} claude --plugin-dir ${PLUGIN_DIR}"

if [[ -n "${CAPTURE_PROMPT}" ]]; then
  CMD="${CMD} -p ${CAPTURE_PROMPT@Q}"
fi

for arg in "${EXTRA_ARGS[@]:-}"; do
  CMD="${CMD} ${arg@Q}"
done

# Launch
tmux send-keys -t "${SESSION_NAME}" "${CMD}" Enter

echo "[launch] Claude Code starting in tmux session '${SESSION_NAME}'"
echo "[launch] Attach: tmux attach -t ${SESSION_NAME}"
echo "[launch] Check bridge events: curl -s ${BRIDGE_URL}/events/recent"
echo "[launch] Stop: tmux kill-session -t ${SESSION_NAME}"
