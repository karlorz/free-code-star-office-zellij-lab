# Interactive Hooks Validation via sg01 Zellij Web

## Goal

Validate pane-backed interactive worker permission and notification hooks using the already deployed sg01 Zellij web terminal at `https://term.karldigi.dev/main`.

This pass improves the validation harness only. It does not deploy Zellij, automate SSH, or hardcode access tokens.

## Scope

Update the existing interactive notification capture path so an operator can run one guided validation loop:

1. Start the local bridge and plugin wiring.
2. Open the deployed sg01 Zellij web terminal.
3. Use the expected Zellij session from the browser terminal.
4. Start an interactive leader session.
5. Create a team/worker interaction.
6. Trigger a worker permission probe.
7. Inspect `tmp/events.ndjson` for notification and lifecycle payloads.

## Non-goals

- No automatic SSH control of sg01.
- No browser automation.
- No repository-stored Zellij web token.
- No Star Office live endpoint changes in this pass.
- No bridge-side classifier/report endpoint yet.

## Design

Enhance `scripts/run-interactive-notification-capture.sh` with operator-facing guidance for the deployed Zellij web workflow.

The script will keep its existing behavior: start the bridge, wire the draft plugin, launch the interactive runtime, and capture hook payloads. Before launching the runtime, it will print a concise checklist that includes:

- the Zellij web URL, configurable via an environment variable and defaulting to the deployed sg01 URL;
- the expected Zellij session name, if configured;
- a reminder that any web token must be supplied by the operator and not committed;
- the worker permission probe command/action to trigger;
- the success signals to look for in `tmp/events.ndjson`.

After the interactive runtime exits, the script will print the artifact path and expected event patterns, including `Notification`, permission/control-plane payloads, `TaskCreated`, `TaskCompleted`, and `SubagentStop` where present.

## Configuration

Use environment variables for deployment-specific metadata:

- `ZELLIJ_WEB_URL`: defaults to `https://term.karldigi.dev/main`.
- `ZELLIJ_SESSION_NAME`: optional expected session name.
- `ZELLIJ_WEB_TOKEN`: optional operator-provided token. The script may mention whether it is set, but must not print its value.

## Error Handling

The script should not fail just because sg01 metadata is missing. It should continue to support local interactive validation. If a token is present, the script should only display a redacted/set indicator.

## Testing

- Run `bun run typecheck`.
- Run a non-destructive shell syntax check on the modified script.
- Do not run a full interactive capture automatically unless explicitly requested, because it requires operator interaction.

## Success Criteria

- The helper clearly guides an operator through the sg01 Zellij web validation path.
- No secret token is written to tracked files or printed in full.
- Existing local interactive capture behavior remains intact.
- The expected capture artifacts and success event patterns are documented in the script output.
