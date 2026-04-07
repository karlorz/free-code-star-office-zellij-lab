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
  - `PreCompact`
  - `PostCompact`

- `hooks-handlers/send-hook.sh`
  Reads hook payload JSON from stdin and posts it to the local bridge.

## Environment

- `CLAUDE_STAR_BRIDGE_URL`
  Bridge base URL. Default: `http://127.0.0.1:4317`

- `CLAUDE_STAR_BRIDGE_SECRET`
  Optional shared secret, sent as `x-bridge-secret`.

## Notes

- This plugin is a lab draft, not a marketplace-ready package.
- The bridge is the compatibility layer. If `free-code` emits slightly different hook payloads than official Claude Code, fix the mapper in `src/stateMapper.ts` rather than making the shell handler more complex.
