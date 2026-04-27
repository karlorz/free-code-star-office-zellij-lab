import { CORS_HEADERS } from "./auth";
import type { BridgeConfig } from "./types";

export function renderDashboard(config: BridgeConfig): Response {
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
  return new Response(`<!DOCTYPE html>
<html><head><title>Star Office Bridge — Dashboard</title>
<style>
body{font-family:monospace;margin:0;background:#1a1a2e;color:#e0e0e0;display:flex;flex-direction:column;height:100vh}
.header{padding:0.5rem 1rem;background:#0f3460;display:flex;justify-content:space-between;align-items:center}
.header h2{margin:0;font-size:1rem}
#status{color:#0f0;font-size:0.85rem}
.toolbar{display:flex;gap:0.5rem;padding:0.5rem 1rem;background:#16213e;align-items:center;flex-wrap:wrap}
.toolbar a,.toolbar button{color:#e0e0e0;background:#1a1a2e;border:1px solid #333;padding:2px 8px;font-size:0.8rem;text-decoration:none;border-radius:3px;cursor:pointer;font-family:monospace}
.toolbar a:hover,.toolbar button:hover{background:#0f3460}
#events{flex:1;white-space:pre-wrap;font-size:0.8rem;overflow-y:auto;padding:0 1rem}
.evt{padding:2px 0;border-bottom:1px solid #222}
.evt-signal{color:#7ec8e3}.evt-snapshot{color:#f0c040}.evt-gap{color:#ff6b6b}
.evt-client{color:#a0a0a0}.evt-backpressure{color:#ff4444}.evt-action{color:#9cf}.evt-alert{color:#ff8c00;font-weight:bold}.evt-other{color:#c0c0c0}
.ts{color:#555;margin-right:0.5rem}
.ws-indicator{font-size:0.75rem;padding:1px 6px;border-radius:2px}
.ws-on{background:#0a0;color:#000}.ws-off{background:#a00;color:#fff}
</style></head><body>
<div class="header"><h2>Star Office Bridge</h2><span id="status">Connecting...</span><span id="caddyHealth" style="font-size:0.75rem;color:#aaa;margin-left:1rem"></span></div>
<div class="toolbar">
<a href="/health">health</a>
<a href="/snapshot">snapshot</a>
<a href="/stats">stats</a>
<a href="/metrics/combined" target="_blank">metrics</a>
<a href="/help">help</a>
<a href="/web/tokens">tokens</a>
<a href="/diagnostics">diagnostics</a>
${attachUrl ? `<a href="${attachUrl}" target="_blank">zellij web</a>` : ""}
<span class="ws-indicator ws-off" id="wsBadge">WS</span>
<button onclick="wsToggle()">${secret ? "WS connect" : "WS connect (no auth)"}</button>
<button onclick="sendAction('list-tabs','--json')">list-tabs</button>
<button onclick="sendAction('list-panes')">list-panes</button>
<button onclick="debugGC()">gc</button>
<button onclick="debugHeap()">heap</button>
<button onclick="tokenRefresh()" style="margin-left:auto">refresh token</button>
<span id="tokenStatus" style="font-size:0.75rem;color:#aaa">token: ${config.zellijWebToken ? "set" : "none"}</span>
</div>
<div id="events"></div>
<script>
const el=document.getElementById("events");
const st=document.getElementById("status");
const caddyEl=document.getElementById("caddyHealth");
const wsBadge=document.getElementById("wsBadge");
const tokenStatus=document.getElementById("tokenStatus");
const secret="${secret}";
let count=0,ws=null;
const es=new EventSource("/events");
function add(cls,text){
  const d=document.createElement("div");
  d.className="evt evt-"+cls;
  d.innerHTML='<span class="ts">'+new Date().toLocaleTimeString()+'</span>'+text;
  el.prepend(d);
  if(++count>300){const last=el.lastChild;if(last)el.removeChild(last)}
}
es.onopen=()=>{st.textContent="SSE Connected";st.style.color="#0f0"};
es.onerror=()=>{st.textContent="SSE Disconnected";st.style.color="#f00"};
es.addEventListener("snapshot",e=>{add("snapshot","SNAPSHOT "+e.data)});
es.addEventListener("snapshot_sync",e=>{add("snapshot","SYNC "+e.data)});
es.addEventListener("signal",e=>{const d=JSON.parse(e.data);add("signal","["+d.state+"] "+d.detail+" ("+d.eventName+")")});
es.addEventListener("gap",e=>{const d=JSON.parse(e.data);add("gap","GAP "+d.gapSize+" events missed")});
es.addEventListener("client_connected",e=>{const d=JSON.parse(e.data);add("client","CLIENT #"+d.clientId+" connected ("+d.totalClients+" total)")});
es.addEventListener("client_disconnected",e=>{const d=JSON.parse(e.data);add("client","CLIENT #"+d.clientId+" disconnected ("+d.totalClients+" total)")});
es.addEventListener("backpressure",e=>{add("backpressure","BACKPRESSURE "+e.data)});
es.addEventListener("shutdown",e=>{add("other","SHUTDOWN "+e.data)});
es.addEventListener("action_executed",e=>{const d=JSON.parse(e.data);add("action","ACTION "+d.action+" exit="+d.exitCode)});
es.addEventListener("web_token_refreshed",e=>{const d=JSON.parse(e.data);tokenStatus.textContent="token: "+(d.tokenName||"refreshed");add("other","TOKEN REFRESHED "+d.tokenName)});
es.addEventListener("web_token_revoked",e=>{const d=JSON.parse(e.data);tokenStatus.textContent="token: revoked";add("other","TOKEN REVOKED "+(d.name||"all"))});
es.addEventListener("alert",e=>{const d=JSON.parse(e.data);const sev=d.alerts?.[0]?.labels?.severity||"?";const name=d.alerts?.[0]?.labels?.alertname||"?";const summ=d.alerts?.[0]?.annotations?.summary||"";add("alert","["+d.status.toUpperCase()+"] "+sev.toUpperCase()+": "+name+(summ?" — "+summ:"")+" ("+d.alertCount+" alert"+(d.alertCount>1?"s":"")+")")});
es.onmessage=e=>{add("other",e.type+": "+e.data)};
function wsToggle(){
  if(ws){ws.close();ws=null;return}
  const secret="${secret}";
  const wsUrl=new URL((location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+"/ws");
  if(secret)wsUrl.searchParams.set("secret",secret);
  ws=new WebSocket(wsUrl.toString());
  ws.onopen=()=>{wsBadge.className="ws-indicator ws-on";add("other","WS connected")};
  ws.onclose=()=>{wsBadge.className="ws-indicator ws-off";add("other","WS disconnected")};
  ws.onmessage=e=>{
    const d=JSON.parse(e.data);
    if(d.type==="action_result"){
      const r=typeof d.result==="string"?d.result.slice(0,300):JSON.stringify(d.result)?.slice(0,300);
      add("action","WS "+d.action+" ok="+d.ok+" "+r);
    } else if(d.type==="snapshot"){add("snapshot","WS SNAPSHOT "+JSON.stringify(d.data)?.slice(0,200))}
    else if(d.type==="pong"){add("other","WS pong")}
    else{add("other","WS "+d.type+" "+JSON.stringify(d)?.slice(0,200))}
  };
  ws.onerror=()=>{add("other","WS error")};
}
function sendAction(action,...args){
  if(!ws||ws.readyState!==1){add("other","WS not connected");return}
  ws.send(JSON.stringify({type:"action",action,args}));
}
async function debugGC(){
  if(!secret){add("other","no auth secret configured");return}
  try{
    const r=await fetch("/debug/gc?force=true",{method:"POST",headers:{"x-bridge-secret":secret}});
    const d=await r.json();
    add("other","GC force="+d.force+" freedRss="+((d.freedRss||0)/1024/1024).toFixed(1)+"MB freedHeap="+((d.freedHeap||0)/1024/1024).toFixed(2)+"MB");
  }catch(e){add("other","GC error: "+e)}
}
async function debugHeap(){
  if(!secret){add("other","no auth secret configured");return}
  try{
    const r=await fetch("/debug/heap-snapshot",{headers:{"x-bridge-secret":secret}});
    if(!r.ok){add("other","HEAP error "+r.status);return}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download="bridge-heap.heapsnapshot";a.click();
    URL.revokeObjectURL(url);
    add("other","HEAP snapshot downloaded ("+((blob.size)/1024/1024).toFixed(1)+"MB)");
  }catch(e){add("other","HEAP error: "+e)}
}
async function tokenRefresh(){
  if(!secret){add("other","no auth secret configured");return}
  try{
    const r=await fetch("/web/token/refresh",{method:"POST",headers:{"x-bridge-secret":secret}});
    const d=await r.json();
    if(d.ok){
      tokenStatus.textContent="token: "+(d.tokenName||d.webToken?.slice(0,8)+"...");
      add("other","TOKEN REFRESH ok name="+d.tokenName);
      if(d.attachUrl){
        const link=document.querySelector('a[href*="token="]');
        if(link)link.href=d.attachUrl;
      }
    } else {add("other","TOKEN REFRESH failed: "+d.error)}
  }catch(e){add("other","TOKEN REFRESH error: "+e)}
}
setInterval(()=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:"ping"}))},30000);
// Fetch and display Caddy upstream health
fetch("/status").then(r=>r.json()).then(d=>{
  if(d.caddy){caddyEl.textContent="caddy: "+d.caddy.upstreamsHealthy+"/"+d.caddy.upstreamsTotal+" upstreams healthy";caddyEl.style.color=d.caddy.healthy?"#0f0":"#f00";}
}).catch(()=>{caddyEl.textContent="caddy: unreachable";caddyEl.style.color="#f00";});
setInterval(()=>{fetch("/status").then(r=>r.json()).then(d=>{
  if(d.caddy){caddyEl.textContent="caddy: "+d.caddy.upstreamsHealthy+"/"+d.caddy.upstreamsTotal+" healthy";caddyEl.style.color=d.caddy.healthy?"#0f0":"#f00";}
}).catch(()=>{})},30000);
</script></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS },
  });
}
