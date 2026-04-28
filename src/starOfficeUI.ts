import { CORS_HEADERS } from "./auth";
import type { BridgeConfig } from "./types";

export function renderStarOffice(config: BridgeConfig): Response {
  const secret = config.secret || "";
  const webUrl = config.zellijWebUrl || "";
  const webToken = config.zellijWebToken || "";
  const sessionName = config.zellijSessionName || "";
  let attachUrl = "";
  if (webUrl && webToken) {
    try {
      const base = webUrl.replace(/\/$/, "");
      attachUrl = sessionName
        ? `${base.replace(/\/[^/]*$/, "")}/${sessionName}?token=${encodeURIComponent(webToken)}`
        : `${base}?token=${encodeURIComponent(webToken)}`;
    } catch {}
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Star Office</title>
<style>
:root {
  --bg: #0a0e17;
  --surface: #111827;
  --surface2: #1a2235;
  --surface3: #1e293b;
  --border: #1e293b;
  --border2: #334155;
  --text: #f1f5f9;
  --text2: #cbd5e1;
  --text3: #94a3b8;
  --text4: #64748b;
  --accent: #3b82f6;
  --accent2: #2563eb;
  --green: #10b981;
  --green2: #064e3b;
  --yellow: #f59e0b;
  --yellow2: #451a03;
  --orange: #f97316;
  --red: #ef4444;
  --red2: #7f1d1d;
  --purple: #8b5cf6;
  --purple2: #2e1065;
  --cyan: #06b6d4;
  --cyan2: #083344;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden}
::selection{background:var(--accent);color:#fff}

/* Top bar */
.topbar{height:48px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 20px;gap:16px;flex-shrink:0}
.topbar-logo{font-size:15px;font-weight:700;letter-spacing:-0.5px;display:flex;align-items:center;gap:8px}
.topbar-logo .star{color:var(--yellow);font-size:20px}
.topbar-logo .name{color:var(--text)}
.topbar-sep{width:1px;height:24px;background:var(--border2)}
.topbar-status{font-size:12px;display:flex;align-items:center;gap:6px}
.topbar-status .dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:pulse 2s infinite}
.topbar-status.offline .dot{background:var(--red);box-shadow:0 0 6px var(--red);animation:none}
.topbar-status .label{color:var(--green);font-weight:500}
.topbar-status.offline .label{color:var(--red)}
.topbar-right{margin-left:auto;display:flex;align-items:center;gap:12px}
.topbar-badge{font-size:10px;font-weight:600;padding:3px 8px;border-radius:4px;letter-spacing:.3px}
.topbar-badge.ws-on{background:var(--green2);color:#6ee7b7;border:1px solid #065f46}
.topbar-badge.ws-off{background:var(--surface2);color:var(--text4);border:1px solid var(--border)}
.topbar-badge.ver{background:var(--surface2);color:var(--text3);border:1px solid var(--border)}
.topbar-time{font-size:11px;color:var(--text4);font-variant-numeric:tabular-nums}

@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

/* Main layout */
.main{flex:1;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr auto;gap:0;overflow:hidden}
@media(max-width:900px){.main{grid-template-columns:1fr;grid-template-rows:1fr 1fr auto}}

/* Panels */
.panel{display:flex;flex-direction:column;overflow:hidden}
.panel-left{border-right:1px solid var(--border)}
.panel-header{height:40px;background:var(--surface2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 16px;flex-shrink:0;gap:8px}
.panel-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)}
.panel-count{font-size:10px;font-weight:700;color:var(--accent);background:rgba(59,130,246,.15);padding:2px 7px;border-radius:8px}
.panel-body{flex:1;overflow-y:auto;padding:10px}
.panel-body::-webkit-scrollbar{width:5px}
.panel-body::-webkit-scrollbar-track{background:transparent}
.panel-body::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}

/* Session cards */
.session-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;transition:all .2s}
.session-card:hover{border-color:var(--border2);background:var(--surface2)}
.session-card.active-executing{border-color:var(--yellow);box-shadow:0 0 12px rgba(245,158,11,.12)}
.session-card.active-writing{border-color:var(--cyan);box-shadow:0 0 12px rgba(6,182,212,.12)}
.session-card.active-researching{border-color:var(--purple);box-shadow:0 0 12px rgba(139,92,246,.12)}
.session-card.active-syncing{border-color:var(--accent);box-shadow:0 0 12px rgba(59,130,246,.12)}
.session-card.active-error{border-color:var(--red);box-shadow:0 0 12px rgba(239,68,68,.12)}
.session-top{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.session-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;flex-shrink:0;letter-spacing:-.5px}
.session-icon.main{background:var(--accent);color:#fff}
.session-icon.sub{background:var(--purple);color:#fff}
.session-icon.zellij{background:var(--green);color:#fff}
.session-icon.manual{background:var(--surface3);color:var(--text3)}
.session-info{flex:1;min-width:0}
.session-name{font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.session-updated{font-size:10px;color:var(--text4);margin-top:1px}

/* State indicator */
.state-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.state-badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:3px 9px;border-radius:5px;display:inline-flex;align-items:center;gap:5px}
.state-badge::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.state-badge.idle{background:var(--surface3);color:var(--text4)}
.state-badge.writing{background:var(--cyan2);color:#22d3ee}
.state-badge.researching{background:var(--purple2);color:#a78bfa}
.state-badge.executing{background:var(--yellow2);color:#fbbf24}
.state-badge.syncing{background:#1e3a5f;color:#60a5fa}
.state-badge.error{background:var(--red2);color:#fca5a5}
.state-badge.executing::before,.state-badge.writing::before,.state-badge.researching::before,.state-badge.syncing::before{animation:pulse 1.5s infinite}
.state-detail{font-size:12px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.state-event{font-size:10px;color:var(--text4);font-family:'JetBrains Mono','Fira Code',monospace;margin-top:2px}

/* Agents sub-grid */
.agents-grid{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}
.agent-pill{font-size:10px;font-weight:500;padding:2px 8px;border-radius:4px;background:var(--surface3);color:var(--text3);border:1px solid var(--border)}
.agent-pill.active{border-color:var(--cyan);color:var(--cyan);background:var(--cyan2)}

/* Activity feed */
.feed-list{flex:1;overflow-y:auto;padding:4px 0}
.feed-list::-webkit-scrollbar{width:5px}
.feed-list::-webkit-scrollbar-track{background:transparent}
.feed-list::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}

.feed-item{padding:8px 14px;border-bottom:1px solid var(--border);font-size:12px;display:flex;align-items:baseline;gap:10px;animation:fadeIn .25s;position:relative}
.feed-item:hover{background:rgba(59,130,246,.06)}
.feed-item::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--border);border-radius:1px}
.feed-item:first-child::before{background:var(--accent)}
@keyframes fadeIn{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}

.feed-time{font-size:10px;color:var(--text3);font-variant-numeric:tabular-nums;flex-shrink:0;width:58px;font-family:'JetBrains Mono','Fira Code',monospace}
.feed-type{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:2px 6px;border-radius:3px;flex-shrink:0;min-width:56px;text-align:center}
.feed-type.signal{background:#1e3a5f;color:#93c5fd}
.feed-type.snapshot{background:var(--yellow2);color:#fcd34d}
.feed-type.client{background:rgba(100,116,139,.2);color:#cbd5e1}
.feed-type.action{background:var(--cyan2);color:#22d3ee}
.feed-type.alert{background:var(--red2);color:#fca5a5}
.feed-type.gap{background:var(--red2);color:#fca5a5}
.feed-type.other{background:rgba(100,116,139,.15);color:#94a3b8}
.feed-text{color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.4}
.feed-text .state-tag{font-weight:700}

/* Empty state */
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text4);gap:8px;padding:40px}
.empty-state .icon{font-size:32px;opacity:.4}
.empty-state .msg{font-size:13px;font-weight:500}
.empty-state .sub{font-size:11px;color:var(--text4);opacity:.6}

/* Bottom: Toolbar */
.toolbar{height:44px;background:var(--surface);border-top:1px solid var(--border);display:flex;align-items:center;padding:0 16px;gap:6px;flex-shrink:0}
.toolbar-btn{font-size:11px;font-weight:500;padding:5px 12px;border-radius:6px;background:var(--surface2);color:var(--text3);border:1px solid var(--border);cursor:pointer;font-family:inherit;transition:all .15s}
.toolbar-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
.toolbar-btn.active{background:var(--accent);color:#fff;border-color:var(--accent2)}
.toolbar-sep{width:1px;height:20px;background:var(--border)}
.toolbar-link{font-size:11px;color:var(--text4);text-decoration:none;padding:5px 8px;border-radius:6px;transition:all .15s}
.toolbar-link:hover{color:var(--text2);background:var(--surface2)}
.toolbar-spacer{flex:1}
.toolbar-info{font-size:10px;color:var(--text4);font-variant-numeric:tabular-nums}
</style>
</head>
<body>

<!-- Top bar -->
<div class="topbar">
  <div class="topbar-logo"><span class="star">\u2726</span><span class="name">Star Office</span></div>
  <div class="topbar-sep"></div>
  <div class="topbar-status" id="sseStatus"><span class="dot"></span><span class="label" id="sseLabel">Connecting</span></div>
  <div class="topbar-right">
    <span class="topbar-badge ws-off" id="wsBadge">WS OFF</span>
    <span class="topbar-badge ver" id="bridgeVer">v0.66.0</span>
    <span class="topbar-time" id="clock"></span>
  </div>
</div>

<!-- Main content -->
<div class="main">
  <!-- Left: Sessions -->
  <div class="panel panel-left">
    <div class="panel-header">
      <span class="panel-title">Sessions</span>
      <span class="panel-count" id="sessionCount">0</span>
    </div>
    <div class="panel-body" id="sessionsList">
      <div class="empty-state" id="sessionsEmpty">
        <div class="icon">\u25b8</div>
        <div class="msg">No active sessions</div>
        <div class="sub">Events will appear here when sessions connect</div>
      </div>
    </div>
  </div>

  <!-- Right: Activity Feed -->
  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Activity</span>
      <span class="panel-count" id="feedCount">0</span>
    </div>
    <div class="feed-list" id="feedList"></div>
  </div>
</div>

<!-- Toolbar -->
<div class="toolbar">
  <button class="toolbar-btn" id="wsBtn" onclick="wsToggle()">Connect WS</button>
  <div class="toolbar-sep"></div>
  <button class="toolbar-btn" onclick="sendAction('list-tabs','--json')">Tabs</button>
  <button class="toolbar-btn" onclick="sendAction('list-panes')">Panes</button>
  <div class="toolbar-sep"></div>
  <button class="toolbar-btn" onclick="debugGC()">GC</button>
  <button class="toolbar-btn" onclick="injectEvent()">Inject</button>
  <div class="toolbar-spacer"></div>
  <a class="toolbar-link" href="/health" target="_blank">Health</a>
  <a class="toolbar-link" href="/snapshot" target="_blank">Snapshot</a>
  <a class="toolbar-link" href="/metrics" target="_blank">Metrics</a>
  <a class="toolbar-link" href="/help" target="_blank">API</a>
  ${attachUrl ? `<a class="toolbar-link" href="${attachUrl}" target="_blank">Terminal</a>` : ''}
  <div class="toolbar-sep"></div>
  <span class="toolbar-info" id="uptimeInfo"></span>
</div>

<script>
const SECRET = ${secret ? `"${secret}"` : "null"};
let ws = null;
let feedCount = 0;
const sessions = new Map();
const MAX_FEED = 300;
let sessionsRendered = false;

// --- SSE ---
const es = new EventSource("/events");
es.onopen = () => {
  document.getElementById("sseStatus").className = "topbar-status";
  document.getElementById("sseLabel").textContent = "Live";
};
es.onerror = () => {
  document.getElementById("sseStatus").className = "topbar-status offline";
  document.getElementById("sseLabel").textContent = "Offline";
};

es.addEventListener("snapshot", e => {
  try {
    const d = JSON.parse(e.data);
    Object.values(d).forEach(s => {
      if (s && s.sessionId && s.sessionId !== "_clientId") sessions.set(s.sessionId, s);
    });
    renderSessions();
  } catch {}
});

es.addEventListener("signal", e => {
  try {
    const d = JSON.parse(e.data);
    if (d.sessionId) sessions.set(d.sessionId, d);
    renderSessions();
    addFeed("signal", formatSignal(d), d.state);
  } catch {}
});

es.addEventListener("snapshot_sync", e => {
  addFeed("snapshot", "State synced", null);
});

es.addEventListener("client_connected", e => {
  try { const d = JSON.parse(e.data); addFeed("client", "Client #" + d.clientId + " connected (" + d.totalClients + " total)", null); } catch {}
});

es.addEventListener("client_disconnected", e => {
  try { const d = JSON.parse(e.data); addFeed("client", "Client #" + d.clientId + " disconnected (" + d.totalClients + " total)", null); } catch {}
});

es.addEventListener("gap", e => {
  try { const d = JSON.parse(e.data); addFeed("gap", d.gapSize + " events missed", null); } catch {}
});

es.addEventListener("action_executed", e => {
  try { const d = JSON.parse(e.data); addFeed("action", d.action + " (exit=" + d.exitCode + ")", null); } catch {}
});

es.addEventListener("alert", e => {
  try {
    const d = JSON.parse(e.data);
    const a = d.alerts?.[0];
    const sev = a?.labels?.severity || "?";
    const name = a?.labels?.alertname || "?";
    const summ = a?.annotations?.summary || "";
    addFeed("alert", "[" + d.status.toUpperCase() + "] " + sev.toUpperCase() + ": " + name + (summ ? " \u2014 " + summ : ""), null);
  } catch {}
});

es.addEventListener("web_token_refreshed", e => {
  try { const d = JSON.parse(e.data); addFeed("other", "Token refreshed: " + (d.tokenName || "?"), null); } catch {}
});

es.addEventListener("web_token_revoked", e => {
  try { const d = JSON.parse(e.data); addFeed("other", "Token revoked: " + (d.name || "all"), null); } catch {}
});

es.addEventListener("backpressure", e => {
  addFeed("alert", "SSE backpressure: " + e.data, null);
});

es.addEventListener("shutdown", e => {
  addFeed("other", "Bridge shutting down", null);
});

es.onmessage = e => {
  if (e.type && e.type !== "message") addFeed("other", e.type, null);
};

// --- WebSocket ---
function wsToggle() {
  if (ws) { ws.close(); ws = null; return; }
  const wsUrl = new URL((location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws");
  if (SECRET) wsUrl.searchParams.set("secret", SECRET);
  ws = new WebSocket(wsUrl.toString());
  ws.onopen = () => {
    document.getElementById("wsBadge").className = "topbar-badge ws-on";
    document.getElementById("wsBadge").textContent = "WS ON";
    document.getElementById("wsBtn").textContent = "Disconnect WS";
    document.getElementById("wsBtn").classList.add("active");
    addFeed("other", "WebSocket connected", null);
  };
  ws.onclose = () => {
    document.getElementById("wsBadge").className = "topbar-badge ws-off";
    document.getElementById("wsBadge").textContent = "WS OFF";
    document.getElementById("wsBtn").textContent = "Connect WS";
    document.getElementById("wsBtn").classList.remove("active");
    addFeed("other", "WebSocket disconnected", null);
  };
  ws.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === "action_result") addFeed("action", "WS " + d.action + " " + (d.ok ? "\u2713" : "\u2717"), null);
      else if (d.type === "snapshot") addFeed("snapshot", "WS snapshot", null);
      else if (d.type === "pong") { /* skip */ }
      else addFeed("other", "WS " + d.type, null);
    } catch {}
  };
  ws.onerror = () => addFeed("other", "WebSocket error", null);
}

function sendAction(action, ...args) {
  if (!ws || ws.readyState !== 1) { addFeed("other", "Connect WS first", null); return; }
  ws.send(JSON.stringify({ type: "action", action, args }));
}

async function debugGC() {
  if (!SECRET) return;
  try {
    const r = await fetch("/debug/gc?force=true", { method: "POST", headers: { "x-bridge-secret": SECRET } });
    const d = await r.json();
    addFeed("other", "GC freed " + ((d.freedRss || 0) / 1048576).toFixed(1) + "MB RSS, " + ((d.freedHeap || 0) / 1048576).toFixed(1) + "MB heap", null);
  } catch (e) { addFeed("other", "GC error", null); }
}

async function injectEvent() {
  if (!SECRET) return;
  try {
    const states = ["idle", "writing", "researching", "executing", "syncing"];
    const details = [
      "Editing src/index.ts",
      "Searching documentation",
      "Running bun test",
      "Pushing to origin",
      "Idle \u2014 awaiting input",
    ];
    const idx = Math.floor(Math.random() * states.length);
    const r = await fetch("/event/manual", {
      method: "POST",
      headers: { "x-bridge-secret": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "star-office", event: "Inject", state: states[idx], detail: details[idx] })
    });
    const d = await r.json();
    addFeed("other", "Injected [" + states[idx] + "] event", states[idx]);
  } catch (e) { addFeed("other", "Inject error", null); }
}

// --- Rendering ---
function formatSignal(d) {
  const s = d.state || "?";
  const detail = d.detail || "";
  const ev = d.eventName || "";
  return '<span class="state-tag" style="color:var(--' + s + ')">[' + s + ']</span> ' + escapeHtml(detail) + (ev ? ' <span style="color:var(--text4)">(' + escapeHtml(ev) + ')</span>' : '');
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function addFeed(type, text, state) {
  feedCount++;
  const list = document.getElementById("feedList");
  const item = document.createElement("div");
  item.className = "feed-item";
  const now = new Date();
  const ts = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.innerHTML = '<span class="feed-time">' + ts + '</span>' +
    '<span class="feed-type ' + type + '">' + type + '</span>' +
    '<span class="feed-text">' + text + '</span>';
  list.prepend(item);
  while (list.children.length > MAX_FEED) list.removeChild(list.lastChild);
  document.getElementById("feedCount").textContent = feedCount;
}

function renderSessions() {
  const container = document.getElementById("sessionsList");
  const emptyEl = document.getElementById("sessionsEmpty");
  const sorted = [...sessions.values()].sort((a, b) => {
    const order = { executing: 0, writing: 1, researching: 2, syncing: 3, error: 4, idle: 5 };
    const oa = order[a.main?.state] ?? 6;
    const ob = order[b.main?.state] ?? 6;
    if (oa !== ob) return oa - ob;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
  document.getElementById("sessionCount").textContent = sorted.length;

  if (sorted.length === 0) {
    if (emptyEl) emptyEl.style.display = "";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  // Only rebuild DOM if session list changed
  container.innerHTML = '<div class="empty-state" id="sessionsEmpty" style="display:none"><div class="icon">\u25b8</div><div class="msg">No active sessions</div><div class="sub">Events will appear here when sessions connect</div></div>';

  sorted.forEach(s => {
    const card = document.createElement("div");
    const state = s.main?.state || "idle";
    const isActive = state !== "idle";
    card.className = "session-card" + (isActive ? " active-" + state : "");

    let iconClass = "manual";
    let iconChar = "?";
    if (s.sessionId?.startsWith("zellij-")) { iconClass = "zellij"; iconChar = "Z"; }
    else if (s.main?.scope === "subagent") { iconClass = "sub"; iconChar = "S"; }
    else { iconClass = "main"; iconChar = "M"; }

    const detail = s.main?.detail || "";
    const eventName = s.main?.eventName || "";
    const agents = s.agents || {};
    const agentKeys = Object.keys(agents);
    const updatedAt = s.updatedAt ? timeAgo(s.updatedAt) : "";

    card.innerHTML =
      '<div class="session-top">' +
        '<div class="session-icon ' + iconClass + '">' + iconChar + '</div>' +
        '<div class="session-info">' +
          '<div class="session-name">' + escapeHtml(s.sessionId || "?") + '</div>' +
          '<div class="session-updated">' + updatedAt + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="state-row">' +
        '<span class="state-badge ' + state + '">' + state + '</span>' +
        '<span class="state-detail">' + escapeHtml(detail) + '</span>' +
      '</div>' +
      (eventName ? '<div class="state-event">' + escapeHtml(eventName) + '</div>' : '') +
      (agentKeys.length > 0 ?
        '<div class="agents-grid">' + agentKeys.map(k => {
          const a = agents[k];
          const isActive = a.state && a.state !== "idle";
          return '<span class="agent-pill' + (isActive ? ' active' : '') + '">' + escapeHtml(a.agentName || k) + ' ' + (a.state || "?") + '</span>';
        }).join('') + '</div>' : '');

    container.appendChild(card);
  });
  sessionsRendered = true;
}

function timeAgo(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// --- Periodic updates ---
function updateClock() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function updateHealth() {
  try {
    const r = await fetch("/health");
    const d = await r.json();
    document.getElementById("bridgeVer").textContent = "v" + (d.version || "?");
    const upSec = Math.floor(d.uptime || 0);
    const h = Math.floor(upSec / 3600);
    const m = Math.floor((upSec % 3600) / 60);
    const s = upSec % 60;
    document.getElementById("uptimeInfo").textContent = "up " + h + "h" + m + "m" + s + "s \u2502 " + (d.sseClients || 0) + " SSE \u2502 " + (d.sessions || 0) + " sess";
  } catch {}
}

// Initial data load
fetch("/snapshot").then(r => r.json()).then(d => {
  if (d.sessions) d.sessions.forEach(s => { if (s.sessionId) sessions.set(s.sessionId, s); });
  renderSessions();
}).catch(() => {});

setInterval(updateClock, 1000);
setInterval(updateHealth, 15000);
setInterval(() => { if (sessionsRendered) renderSessions(); }, 5000); // refresh time-ago
updateClock();
updateHealth();

// WS keepalive
setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" })); }, 30000);
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
  });
}
