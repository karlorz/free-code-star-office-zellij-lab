import type { NormalizedSignal } from "./types";

export function zellijEnv(session?: string, config?: { zellijSessionName?: string }): Record<string, string | undefined> {
  return {
    ...process.env,
    ZELLIJ_SESSION_NAME: session || config?.zellijSessionName || "",
    HOME: process.env.HOME || "/root",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/0",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  };
}

export function mapZellijEvent(body: Record<string, unknown>): NormalizedSignal {
  const zellijEvent = typeof body.zellij_event === "string" ? body.zellij_event : "unknown";
  const sessionId = typeof body.session_id === "string" ? body.session_id : "zellij-monitor";
  const cwd = typeof body.cwd === "string" ? body.cwd : "/";

  let state: NormalizedSignal["state"];
  let detail: string;
  let shouldLeave = false;
  switch (zellijEvent) {
    case "pane_update":
      state = "syncing";
      detail = `pane_update: ${body.total_panes ?? "?"} panes`;
      break;
    case "tab_update":
      state = "syncing";
      detail = `tab_update: ${body.tab_count ?? "?"} tabs, active=${typeof body.active_tab === "string" ? body.active_tab : "?"}`;
      break;
    case "cwd_change":
      state = "executing";
      detail = `cwd_change: ${cwd}`;
      break;
    case "command_change":
      state = "executing";
      detail = `command_change: ${typeof body.terminal_command === "string" ? body.terminal_command : "?"}`;
      break;
    case "pane_content":
      state = "executing";
      detail = `pane_content: pane=${body.pane_id ?? "?"} lines=${body.viewport_lines ?? "?"}`;
      break;
    case "pane_exit":
      state = "idle";
      detail = `pane_exit: exit=${body.exit_status ?? "?"} held=${body.is_held ?? "?"}`;
      shouldLeave = true;
      break;
    case "client_update":
      state = "syncing";
      detail = `client_update: ${body.client_count ?? "?"} clients`;
      break;
    case "web_status":
      state = "syncing";
      detail = `web_status: ${typeof body.web_status === "string" ? body.web_status : "?"}`;
      break;
    default:
      state = "syncing";
      detail = zellijEvent;
  }

  return {
    sessionId,
    agentName: "Zellij",
    scope: "subagent",
    state,
    detail,
    eventName: typeof body.hook_event_name === "string" ? body.hook_event_name : "ZellijEvent",
    shouldLeave,
    context: {
      cwd,
      zellijEvent,
      zellijPaneCount: body.total_panes != null ? Number(body.total_panes) : undefined,
      zellijTabCount: body.tab_count != null ? Number(body.tab_count) : undefined,
      zellijFocusedTitles: Array.isArray(body.focused_titles) ? body.focused_titles.map(String) : undefined,
      zellijActiveTab: typeof body.active_tab === "string" ? body.active_tab : undefined,
      zellijTerminalCommand: typeof body.terminal_command === "string" ? body.terminal_command : undefined,
      zellijExitStatus: body.exit_status != null ? Number(body.exit_status) : (body.exit_status === null ? null : undefined),
      zellijIsHeld: typeof body.is_held === "boolean" ? body.is_held : undefined,
      zellijIsFloating: typeof body.is_floating === "boolean" ? body.is_floating : undefined,
      zellijClientCount: body.client_count != null ? Number(body.client_count) : undefined,
      zellijTabNames: Array.isArray(body.tabs) ? body.tabs.map(String) : undefined,
      zellijPaneId: typeof body.pane_id === "string" ? body.pane_id : undefined,
      zellijViewportLines: body.viewport_lines != null ? Number(body.viewport_lines) : undefined,
      zellijViewportHash: typeof body.viewport_hash === "string" ? body.viewport_hash : undefined,
      zellijLastLine: typeof body.last_line === "string" ? body.last_line : undefined,
      zellijWebStatus: typeof body.web_status === "string" ? body.web_status : undefined,
    },
  };
}
