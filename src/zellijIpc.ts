/**
 * Zellij IPC Client — direct Unix domain socket communication
 *
 * Bypasses `zellij action` CLI invocations by talking directly to the
 * zellij session server over its UDS socket. Uses protobuf wire format:
 *   4-byte LE length prefix + serialized ClientToServerMsg
 *
 * Protocol source: zellij-utils-0.44.1/src/client_server_contract/
 * Socket path: $XDG_RUNTIME_DIR/zellij/contract_version_1/<session-name>
 */

import { join } from "node:path";
import { connect } from "node:net";
import protobuf from "protobufjs";

const PROTO_ROOT = join(import.meta.dir, "zellij_ipc.json");

let root: protobuf.Root | null = null;
let ClientToServerMsg: protobuf.Type | null = null;
let ServerToClientMsg: protobuf.Type | null = null;
let ActionType: protobuf.Type | null = null;

async function loadProto() {
  if (ClientToServerMsg) return;
  root = await protobuf.load(PROTO_ROOT);
  const ns = root!.lookup("client_server_contract") as protobuf.Namespace;
  ClientToServerMsg = ns.lookupType("ClientToServerMsg");
  ServerToClientMsg = ns.lookupType("ServerToClientMsg");
  ActionType = ns.lookupType("Action");
}

/**
 * Discover the UDS socket path for a zellij session.
 * Pattern: $XDG_RUNTIME_DIR/zellij/contract_version_1/<session-name>
 */
function sessionSocketPath(sessionName: string): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
  return join(runtimeDir, "zellij", "contract_version_1", sessionName);
}

/**
 * Send a protobuf message over UDS with 4-byte LE length-prefix framing.
 * Reads multiple response messages until UnblockInputThread or Exit is received.
 * Returns all collected ServerToClientMsg objects.
 * Uses a short 500ms idle timeout after receiving the first message to avoid
 * the 5s wait caused by the server keeping the connection open for render updates.
 */
async function sendAndReceive(socketPath: string, msg: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  await loadProto();

  const payload = ClientToServerMsg!.create(msg);
  const errMsg = ClientToServerMsg!.verify(payload);
  if (errMsg) throw new Error(`proto verify failed: ${errMsg}`);

  const encoded = ClientToServerMsg!.encode(payload).finish();
  const frame = Buffer.allocUnsafe(4 + encoded.length);
  frame.writeUInt32LE(encoded.length, 0);
  Buffer.from(encoded).copy(frame, 4);

  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const responses: Record<string, unknown>[] = [];
    let recvBuf = Buffer.alloc(0);
    let done = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    function finish() {
      if (done) return;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      sock.destroy();
      resolve(responses);
    }

    sock.on("error", reject);
    sock.on("connect", () => {
      sock.write(frame);
      // Global timeout — 2s max
      setTimeout(() => finish(), 2000);
    });

    function tryParseMessages() {
      while (!done && recvBuf.length >= 4) {
        const msgLen = recvBuf.readUInt32LE(0);
        if (recvBuf.length < 4 + msgLen) break;

        const msgBytes = recvBuf.subarray(4, 4 + msgLen);
        recvBuf = Buffer.from(recvBuf.subarray(4 + msgLen));

        try {
          const decoded = ServerToClientMsg!.decode(msgBytes);
          const obj = ServerToClientMsg!.toObject(decoded, { defaults: true }) as Record<string, unknown>;
          responses.push(obj);

          // Terminal messages — stop immediately
          if ("unblock_input_thread" in obj || "exit" in obj) {
            finish();
            return;
          }
        } catch {
          // Skip malformed messages
        }
      }

      // Start idle timer: if no more data in 100ms after first response, finish
      if (responses.length > 0 && !idleTimer) {
        idleTimer = setTimeout(() => finish(), 100);
      }
    }

    sock.on("data", (chunk: Buffer) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      tryParseMessages();
    });

    sock.on("close", () => finish());
  });
}

/**
 * Build an ActionMsg for a zellij action.
 * Proto JSON uses keepCase=true (snake_case): list_tabs, not listTabs.
 * Maps CLI action names to protobuf snake_case field names.
 */
function buildActionMsg(actionName: string, _args?: string[], isCliClient = true): Record<string, unknown> {
  const ACTION_MAP: Record<string, string> = {
    "list-tabs": "list_tabs",
    "list-panes": "list_panes",
    "list-clients": "list_clients",
    "go-to-next-tab": "go_to_next_tab",
    "go-to-previous-tab": "go_to_previous_tab",
    "close-tab": "close_tab",
    "new-tab": "new_tab",
    "rename-tab": "rename_tab",
    "move-focus": "move_focus",
    "move-focus-or-tab": "move_focus_or_tab",
    "toggle-active-sync-tab": "toggle_active_sync_tab",
    "new-pane": "new_pane",
    "new-floating-pane": "new_floating_pane",
    "new-tiled-pane": "new_tiled_pane",
    "close-focus": "close_focus",
    "toggle-fullscreen": "toggle_focus_fullscreen",
    "toggle-pane-frames": "toggle_pane_frames",
    "toggle-floating-panes": "toggle_floating_panes",
    "focus-next-pane": "focus_next_pane",
    "focus-previous-pane": "focus_previous_pane",
    "detach": "detach",
    "quit": "quit",
    "write": "write",
    "write-chars": "write_chars",
    "resize": "resize",
    "move-pane": "move_pane",
    "move-pane-backwards": "move_pane_backwards",
    "clear-screen": "clear_screen",
    "dump-screen": "dump_screen",
    "dump-layout": "dump_layout",
    "edit-scrollback": "edit_scrollback",
    "scroll-up": "scroll_up",
    "scroll-down": "scroll_down",
    "scroll-to-bottom": "scroll_to_bottom",
    "scroll-to-top": "scroll_to_top",
    "page-scroll-up": "page_scroll_up",
    "page-scroll-down": "page_scroll_down",
    "half-page-scroll-up": "half_page_scroll_up",
    "half-page-scroll-down": "half_page_scroll_down",
    "undo-rename-pane": "undo_rename_pane",
    "undo-rename-tab": "undo_rename_tab",
    "no-op": "no_op",
    "toggle-mouse-mode": "toggle_mouse_mode",
    "confirm": "confirm",
    "deny": "deny",
    "skip-confirm": "skip_confirm",
    "search": "search",
    "search-input": "search_input",
    "search-toggle-option": "search_toggle_option",
    "previous-swap-layout": "previous_swap_layout",
    "next-swap-layout": "next_swap_layout",
    "query-tab-names": "query_tab_names",
    "rename-session": "rename_session",
    "switch-session": "switch_session",
    "save-session": "save_session",
    "cli-pipe": "cli_pipe",
    "keybind-pipe": "keybind_pipe",
    "stack-panes": "stack_panes",
    "toggle-pane-in-group": "toggle_pane_in_group",
    "toggle-group-marking": "toggle_group_marking",
    "toggle-pane-pinned": "toggle_pane_pinned",
    "toggle-pane-borderless": "toggle_pane_borderless",
    "set-pane-borderless": "set_pane_borderless",
    "set-pane-color": "set_pane_color",
    "current-tab-info": "current_tab_info",
    "show-floating-panes": "show_floating_panes",
    "hide-floating-panes": "hide_floating_panes",
    "break-pane": "break_pane",
    "break-pane-right": "break_pane_right",
    "break-pane-left": "break_pane_left",
  };

  const fieldName = ACTION_MAP[actionName];
  if (!fieldName) throw new Error(`unknown action: ${actionName}`);

  // Build the Action message with the appropriate oneof field set
  const action: Record<string, unknown> = {};

  // Query actions need output_json=true to get structured results
  const JSON_OUTPUT_ACTIONS = new Set(["list_tabs", "list_panes", "list_clients", "current_tab_info", "query_tab_names"]);
  if (JSON_OUTPUT_ACTIONS.has(fieldName)) {
    action[fieldName] = { output_json: true };
  } else {
    action[fieldName] = {};
  }

  return {
    action,
    is_cli_client: isCliClient,
  };
}

/**
 * Send a zellij action via direct UDS IPC.
 * This is the primary API — replaces Bun.spawn(["zellij", "action", ...]).
 * Returns all server responses (including CliPipeOutput for query results).
 */
export async function sendAction(
  sessionName: string,
  actionName: string,
  args?: string[],
): Promise<Record<string, unknown>[]> {
  const socketPath = sessionSocketPath(sessionName);
  const actionMsg = buildActionMsg(actionName, args);
  const msg = { action: actionMsg };
  return sendAndReceive(socketPath, msg);
}

/**
 * Send a ConnStatus message to check if the session server is alive.
 */
export async function ping(sessionName: string): Promise<Record<string, unknown>[]> {
  const socketPath = sessionSocketPath(sessionName);
  return sendAndReceive(socketPath, { conn_status: {} });
}

/**
 * List available socket paths for all running zellij sessions.
 */
export function listSessionSockets(): string[] {
  const { readdirSync } = require("node:fs");
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
  const contractDir = join(runtimeDir, "zellij", "contract_version_1");
  try {
    return readdirSync(contractDir).filter((name: string) => {
      try {
        const stat = require("node:fs").statSync(join(contractDir, name));
        return stat.isSocket();
      } catch { return false; }
    });
  } catch { return []; }
}

// Direct execution for testing
if (import.meta.main) {
  const session = process.argv[2] || "main";
  const action = process.argv[3] || "list-tabs";
  console.log(`[zellij-ipc] connecting to session: ${session}, action: ${action}`);
  sendAction(session, action)
    .then(results => console.log(JSON.stringify(results, null, 2)))
    .catch(err => console.error(`[zellij-ipc] error:`, err.message));
}
