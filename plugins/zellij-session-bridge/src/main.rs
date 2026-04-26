use std::collections::BTreeMap;
use zellij_tile::prelude::*;

const HOOK_URL: &str = "http://127.0.0.1:4317/hook/zellij";

/// A Zellij WASM plugin that monitors session state (panes, tabs) and
/// posts observed changes to the Star Office Bridge via native HTTP hooks.
/// Runs headless — render() is empty, update() returns false.
///
/// Requires WebAccess and ReadApplicationState permissions.
/// Pre-grant via ~/.cache/zellij/permissions.kdl for headless operation:
///   "file:///path/to/zellij-session-bridge.wasm" { WebAccess ReadApplicationState }
#[derive(Default)]
struct SessionBridge {
    last_tab_count: usize,
    last_pane_count: usize,
    permissions_granted: bool,
}

register_plugin!(SessionBridge);

impl ZellijPlugin for SessionBridge {
    fn load(&mut self, _configuration: BTreeMap<String, String>) {
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::WebAccess,
        ]);
        subscribe(&[
            EventType::PermissionRequestResult,
            EventType::PaneUpdate,
            EventType::TabUpdate,
            EventType::WebRequestResult,
        ]);
    }

    fn update(&mut self, event: Event) -> bool {
        match &event {
            Event::PermissionRequestResult(PermissionStatus::Granted) => {
                self.permissions_granted = true;
                // Now safe to subscribe to events that require ReadApplicationState
            }
            Event::PermissionRequestResult(PermissionStatus::Denied) => {
                self.permissions_granted = false;
            }
            Event::PaneUpdate(pane_manifest) => {
                if !self.permissions_granted {
                    return false;
                }
                let total_panes: usize = pane_manifest.panes.values().map(|v| v.len()).sum();
                let focused: Vec<String> = pane_manifest
                    .panes
                    .values()
                    .flatten()
                    .filter(|p| p.is_focused)
                    .map(|p| p.title.clone())
                    .collect();
                self.last_pane_count = total_panes;
                self.post_json(&format!(
                    r#"{{"hook_event_name":"FileChanged","session_id":"zellij-bridge","cwd":"/","zellij_event":"pane_update","total_panes":{},"focused_titles":{}}}"#,
                    total_panes,
                    format!("{:?}", focused)
                ));
            }
            Event::TabUpdate(tabs) => {
                if !self.permissions_granted {
                    return false;
                }
                let tab_count = tabs.len();
                let names: Vec<String> = tabs.iter().map(|t| t.name.clone()).collect();
                let active = tabs.iter().find(|t| t.active).map(|t| t.name.clone());
                self.last_tab_count = tab_count;
                self.post_json(&format!(
                    r#"{{"hook_event_name":"CwdChanged","session_id":"zellij-bridge","cwd":"/","zellij_event":"tab_update","tab_count":{},"tabs":{:?},"active_tab":{:?}}}"#,
                    tab_count, names, active
                ));
            }
            Event::WebRequestResult(_status, _headers, _body, _context) => {
                // Fire-and-forget: silently acknowledge
            }
            _ => {}
        }
        false
    }

    fn pipe(&mut self, pipe_message: PipeMessage) -> bool {
        if pipe_message.name == "push_state" {
            self.post_json(&format!(
                r#"{{"hook_event_name":"InstructionsLoaded","session_id":"zellij-bridge","cwd":"/","zellij_event":"pipe","pipe_name":{:?},"total_panes":{},"tab_count":{}}}"#,
                pipe_message.name, self.last_pane_count, self.last_tab_count
            ));
        }
        false
    }

    fn render(&mut self, _rows: usize, _cols: usize) {
        // Headless: intentionally empty
    }
}

impl SessionBridge {
    fn post_json(&self, json_body: &str) {
        let mut headers = BTreeMap::new();
        headers.insert("Content-Type".into(), "application/json".into());

        let mut context = BTreeMap::new();
        context.insert("origin".into(), "zellij-session-bridge".into());

        web_request(
            HOOK_URL,
            HttpVerb::Post,
            headers,
            json_body.as_bytes().to_vec(),
            context,
        );
    }
}
