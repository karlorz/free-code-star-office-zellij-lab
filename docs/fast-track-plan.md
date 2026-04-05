# Fast-Track Plan

## TL;DR

- Validate the main-agent path first.
- Keep subagent support behind one clean interface.
- Treat Zellij web as the remote terminal, not as the dashboard.
- Measure success by a working loop, not by feature count.

## Phase 1

Goal: prove the bridge can update the main Star Office state.

Deliverables:

- bridge running locally
- `/health` and `/event/manual` working
- `POST /set_state` integration working against a local Star Office UI

Success condition:

- a manual event updates the Star Office main character state correctly

## Phase 2

Goal: prove hook forwarding from a Claude-compatible runtime.

Deliverables:

- local plugin draft
- hook handler forwarding raw payloads into the bridge
- event log showing actual payload shapes

Success condition:

- `PreToolUse` and `Stop` events move the office state without manual curl calls

## Phase 3

Goal: prove session hosting in Zellij.

Deliverables:

- named Zellij session rooted in `/Users/karlchow/Desktop/code/free-code`
- web server running locally
- operator can attach from a second terminal or browser

Success condition:

- the same work session is visible in Star Office UI and controllable in Zellij

## Phase 4

Goal: prove multi-agent or subagent presence.

Deliverables:

- stable join and push flow for subagents
- agent ID cache inside the bridge
- correct leave behavior on `SubagentStop`

Success condition:

- a second visible worker appears and disappears cleanly in Star Office UI

## Possible Outcomes

### Outcome A

The hook shapes are close enough to official Claude Code that this lab only needs configuration and polish.

### Outcome B

The runtime is mostly compatible, but one or two event names or fields drift. A thin adapter inside `src/stateMapper.ts` is enough.

### Outcome C

The runtime does not expose the needed hooks. In that case this repo still remains useful as the target architecture, but the intake path moves from hook forwarding to a custom session event tap.

## Immediate Next Steps

1. Run the bridge in dry-run mode.
2. Observe real hook payloads from the target runtime.
3. Turn off dry-run for a local Star Office UI instance.
4. Validate the Zellij flow with a named session and local web server.
