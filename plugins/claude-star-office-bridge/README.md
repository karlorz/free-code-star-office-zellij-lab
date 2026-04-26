# Claude Star Office Bridge Plugin

## TL;DR

- This is a draft local Claude plugin.
- It forwards hook payloads to the lab bridge service.
- It is intentionally small because the bridge owns normalization.

## What It Contains

- `.claude-plugin/plugin.json`
  Plugin metadata.

- `hooks/hooks.json`
  Hook registration for:
  - `SessionStart`
  - `SessionEnd`
  - `Setup`
  - `Notification`
  - `UserPromptSubmit`
  - `PreToolUse`
  - `PostToolUse`
  - `PostToolUseFailure`
  - `PermissionRequest`
  - `PermissionDenied`
  - `Elicitation`
  - `ElicitationResult`
  - `TaskCreated`
  - `TaskCompleted`
  - `Stop`
  - `StopFailure`
  - `SubagentStart`
  - `SubagentStop`
  - `TeammateIdle`
  - `ConfigChange`
  - `InstructionsLoaded`
  - `CwdChanged`
  - `FileChanged`
  - `WorktreeCreate`
  - `WorktreeRemove`
  - `PreCompact`
  - `PostCompact`

- `hooks-handlers/send-hook.sh`
  Legacy command-hook handler. Kept for fallback but superseded by native HTTP hooks.

## Hook Transport

All 27 events use `type: "http"` hooks that POST directly to the bridge URL. Claude Code sends the event JSON as the request body with `Content-Type: application/json`. The bridge normalizes the native format (`hook_event_name` at top level) into its existing `event_name` + `payload` envelope.

The `send-hook.sh` command-hook handler remains in the repo as a fallback for runtimes that do not support native HTTP hooks.

## Environment

- `CLAUDE_STAR_BRIDGE_URL`
  Bridge base URL. Default: `http://127.0.0.1:4317`

- `CLAUDE_STAR_BRIDGE_SECRET`
  Optional shared secret, sent as `X-Bridge-Secret`.

## Notes

- This plugin is a lab draft, not a marketplace-ready package.
- The bridge is the compatibility layer. If `free-code` emits slightly different hook payloads than official Claude Code, fix the mapper in `src/stateMapper.ts` rather than making the handler more complex.
