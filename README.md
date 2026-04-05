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

5. Attach a Zellij session rooted in the local `free-code` workspace:

```bash
./scripts/launch-zellij-lab.sh
```

6. Wire the draft plugin into a local Claude plugin install and point it at the bridge:
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
- A manual event endpoint for testing without a running Claude session.
- A Zellij helper that uses the locally installed CLI and optionally starts the web server.

What still needs a live validation pass:

- Exact hook payload shapes from the target `free-code` runtime.
- The final plugin installation path and plugin enablement workflow on the local machine.
- Whether subagent event names and payloads match official Claude Code closely enough to reuse the same mapper unchanged.

## Fast-Track Outcomes

- **Best case**: the draft plugin works against `free-code` with only configuration changes, and the bridge can drive Star Office UI immediately.
- **Likely case**: the main-agent path works immediately, but subagent or approval events need a thin compatibility shim after observing real payloads.
- **Worst case**: `free-code` diverges materially from official Claude hooks, and the bridge has to ingest a custom local event stream instead.

## Docs

- [Architecture](./docs/architecture.md)
- [Fast-Track Plan](./docs/fast-track-plan.md)
- [Draft Claude Plugin](./plugins/claude-star-office-bridge/README.md)
