# Free Code, Star Office UI, and Zellij Lab

## TL;DR

- This repo is a fast-track lab for the integration plan researched on `2026-04-06`.
- It does not modify `/Users/karlchow/Desktop/code/free-code`; it prototypes next to it.
- The current MVP is a local bridge service plus a draft Claude plugin and Zellij helper scripts.
- The bridge is designed around official Claude hook patterns, Star Office UI's current HTTP API, and the locally installed `zellij 0.44.0`.

## Purpose

This workspace exists to answer one practical question quickly:

Can a Claude Code compatible runtime emit enough structured events to drive Star Office UI honestly, while Zellij remains the real terminal and remote web client?

The repo is intentionally narrow:

- `src/` contains the bridge server.
- `plugins/claude-star-office-bridge/` contains a draft plugin that forwards hook payloads into the bridge.
- `scripts/` contains Zellij and smoke-test helpers.
- `docs/` contains the implementation detail, architecture, and expected outcomes.

## Local Context

- Target runtime workspace: `/Users/karlchow/Desktop/code/free-code`
- Reference plugin examples: `/Users/karlchow/Desktop/code/claude-code/plugins`
- Research note: `/Users/karlchow/Documents/obsidian_vault/5️⃣-Projects/Research/claude-code-star-office-ui-zellij-plan-deep-research.md`

## Quick Start

1. Copy `.env.example` to `.env` and adjust values.
2. Install dev dependencies:

```bash
bun install
```

3. Start the bridge:

```bash
bun run dev
```

4. In another shell, verify the bridge and manual state flow:

```bash
./scripts/smoke-test.sh
```

5. Capture real hook payloads from the local `free-code` runtime:

### Baseline lifecycle capture

```bash
bash ./scripts/run-live-capture.sh
```

This starts the lab bridge in dry-run mode, wires the draft plugin into the local runtime, and writes captured raw events to `tmp/events.ndjson`.
If no extra args are passed, it defaults to a short `-p` run with `--permission-mode bypassPermissions` so the runtime is more likely to emit `SessionStart`, `PreToolUse`, and `Stop` without blocking.
The helper now also auto-picks the first free bridge port starting at `4317`, which avoids the recent local port-collision failures.

For a repeatable **baseline team lifecycle capture**, use the built-in team profile:

```bash
LIVE_CAPTURE_PROFILE=team-notification bash ./scripts/run-live-capture.sh
```

That profile now enables swarm opt-in through `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and uses an explicit team/worker prompt aimed at surfacing leader-side worker permission notifications in the external `free-code` build.
In practice, this profile is now validated as a **non-interactive lifecycle capture path**: it can prove team creation, worker spawn, worker stop, and cleanup, but it still runs through `-p` and therefore does not yet validate the interactive pane-backed notification path.

For explicit control, pass args through to `free-code`, for example:

```bash
bash ./scripts/run-live-capture.sh -p "Inspect the current directory and read package.json" --permission-mode bypassPermissions
```

### Interactive notification capture

For the actual worker approval / leader notification target, use the separate interactive helper:

```bash
bash ./scripts/run-interactive-notification-capture.sh
```

This helper starts the same bridge and plugin wiring, but launches an interactive leader session instead of a `-p` print-mode run.
Use it from a pane-capable interactive terminal, create a team from the leader session, spawn a worker, and then have the worker attempt the first concrete permission probe `touch worker-permission-probe.txt` so the leader-side `Notification` hook can surface.
The helper now also prints a recommended leader prompt before launching the runtime, and you can override that text with `LEADER_PROMPT=...` when you want to try a narrower or more forceful approval-triggering worker action.

6. Attach a Zellij session rooted in the local `free-code` workspace:

```bash
./scripts/launch-zellij-lab.sh
```

7. Wire the draft plugin into a local Claude plugin install and point it at the bridge:
   The draft plugin lives in [`plugins/claude-star-office-bridge`](./plugins/claude-star-office-bridge).

## Current State

What works in this repo right now:

- A Bun HTTP bridge that accepts Claude-style hook envelopes.
- A state mapper from hook events to Star Office UI states.
- A Star Office UI client that uses real upstream endpoint names:
  - `/set_state`
  - `/join-agent`
  - `/agent-push`
  - `/leave-agent`
- A smoke test that boots an isolated temporary bridge and validates subagent cleanup paths (`SubagentStop` and task-owner-correlated `TaskCompleted`).
- A Zellij helper that uses the locally installed CLI and optionally starts the web server.

What still needs a live validation pass:

- Exact hook payload shapes from the target `free-code` runtime.
- The final plugin installation path and plugin enablement workflow on the local machine.
- Whether subagent event names and payloads match official Claude Code closely enough to reuse the same mapper unchanged.

How to capture payload drift quickly:

1. Start bridge in dry-run mode: `bun run dev`
2. Install/enable the draft plugin in your local Claude-compatible runtime.
3. Run one short coding interaction that triggers `SessionStart`, `PreToolUse`, and `Stop`.
4. Inspect raw captured hooks in `tmp/events.ndjson` (each claude-hook signal now includes `rawEvent`).
   Every line now uses one stable artifact shape for both mapped and ignored intake:
   - `source`
   - `receivedAt`
   - `rawEvent`
   - `signal`
   - `originalSignal`
   - `starOfficeResult`
   - `starOfficeError`
   - `ignored`
   - `ignoreReason`
   - `rawBody` (ignored invalid-json cases only)
   For a one-command live capture path against the local runtime, use `bash ./scripts/run-live-capture.sh`.
   The helper defaults to a noninteractive `-p` run with `--permission-mode bypassPermissions`, but you can pass a different prompt or flags through when you need a specific path.
5. If fields differ from expected names, update only `src/stateMapper.ts`.

## Fast-Track Outcomes

- **Best case**: the draft plugin works against `free-code` with only configuration changes, and the bridge can drive Star Office UI immediately.
- **Likely case**: the main-agent path works immediately, but subagent or approval events need a thin compatibility shim after observing real payloads.
- **Worst case**: `free-code` diverges materially from official Claude hooks, and the bridge has to ingest a custom local event stream instead.

## Docs

- [Architecture](./docs/architecture.md)
- [Fast-Track Plan](./docs/fast-track-plan.md)
- [Draft Claude Plugin](./plugins/claude-star-office-bridge/README.md)
