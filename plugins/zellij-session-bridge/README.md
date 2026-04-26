# Zellij Session Bridge Plugin

A headless Zellij WASM plugin that monitors session state (pane/tab changes)
and posts observed events to the Star Office Bridge.

## How It Works

- Subscribes to `PaneUpdate` and `TabUpdate` events
- On each change, POSTs a native HTTP hook payload to `http://127.0.0.1:4317/hook/claude`
- Uses `FileChanged` and `CwdChanged` hook event names as transport (bridge normalizes them)
- Supports manual state push via `zellij pipe --name push_state`

## Build

```bash
rustup target add wasm32-wasip1
cargo build --target wasm32-wasip1 --release
```

Output: `target/wasm32-wasip1/release/zellij_session_bridge.wasm`

## Load

```bash
# As a floating headless pane
zellij plugin -f -- file:target/wasm32-wasip1/release/zellij_session_bridge.wasm

# As an in-place hidden pane
zellij plugin -i -- file:target/wasm32-wasip1/release/zellij_session_bridge.wasm

# Auto-launch via pipe (plugin loads on first message)
zellij pipe --plugin file:/path/to/zellij_session_bridge.wasm --name push_state -- "init"

# Manual state push after loaded
zellij pipe --name push_state -- "manual"
```

## Permissions

- `ReadApplicationState` — required for PaneUpdate/TabUpdate events
- `WebAccess` — required for outbound HTTP to the bridge

User is prompted once per plugin URL; grant is cached.

## Bridge Integration

The plugin posts events in the bridge's native HTTP hook format:

```json
{
  "hook_event_name": "FileChanged",
  "session_id": "zellij-bridge",
  "cwd": "/",
  "zellij_event": "pane_update",
  "total_panes": 3,
  "focused_titles": ["bash"]
}
```

The bridge normalizes `hook_event_name` into `event_name` + `payload` envelope automatically.
