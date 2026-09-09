import * as http from "node:http";
import { URL } from "node:url";
import {
  addPolicyEntry,
  readPolicyForControlPanel,
  removePolicyEntry,
  updatePolicySettings,
  type EditablePolicyList,
} from "./policy-writer.js";

// 43240 is used by the standalone Bridge distribution. The Golem-integrated
// control surface uses its own loopback port so the dashboard never edits an
// older installation's policy by accident.
const DEFAULT_CONTROL_PORT = 43_241;
const MAX_BODY_BYTES = 32 * 1024;

type VisiblePolicy = ReturnType<typeof readPolicyForControlPanel>;

function controlPort(): number {
  const raw = Number(process.env.M365_BRIDGE_CONTROL_PORT ?? DEFAULT_CONTROL_PORT);
  return Number.isInteger(raw) && raw >= 1024 && raw <= 65_535 ? raw : DEFAULT_CONTROL_PORT;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function visiblePolicy(policy: VisiblePolicy): Record<string, unknown> {
  return {
    writeEnabled: policy.writeEnabled,
    allowOverwrite: policy.allowOverwrite,
    allowRecycle: policy.allowRecycle,
    readHostPatterns: policy.readHostPatterns,
    deniedHosts: policy.deniedHosts,
    deniedSites: policy.deniedSites,
    allowedLocalPaths: policy.allowedLocalPaths,
  };
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        reject(new Error("request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * CSRF defense for an unauthenticated loopback server: any other page open in
 * the user's browser could otherwise silently POST to this port. A missing
 * `Origin` header is never treated as implicitly same-origin — browsers
 * always send `Origin` on cross-origin fetch/XHR/form submissions, so a
 * same-origin page-script request also carries it; only a same-origin
 * top-level navigation omits it, and mutating requests are never issued that
 * way from this page's own script. The match is against the literal
 * `http://127.0.0.1:<port>` origin only (no `localhost` alias), matching the
 * literal `127.0.0.1` bind below. See docs/LIMITATIONS.md for the trust
 * boundary this does and does not cover.
 */
function isLocalOrigin(req: http.IncomingMessage, port: number): boolean {
  return req.headers.origin === `http://127.0.0.1:${port}`;
}

function isEditableList(value: unknown): value is EditablePolicyList {
  return value === "deniedHosts" || value === "deniedSites" || value === "allowedLocalPaths";
}

function controlPanelHtml(port: number): string {
  return String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>M365 Session Bridge 管理介面</title>
<style>
:root{color-scheme:light dark;font-family:Segoe UI,system-ui,sans-serif;background:#101827;color:#e7edf7}
body{margin:0;background:linear-gradient(135deg,#101827,#17243a);min-height:100vh}
main{max-width:1080px;margin:0 auto;padding:32px 20px 56px}
h1{margin:0 0 8px;font-size:28px}h2{font-size:18px;margin:0 0 14px}p{color:#b7c4d8;line-height:1.5}
.notice{background:#20324d;border:1px solid #39597f;border-radius:12px;padding:14px 16px;margin:18px 0 24px}
.notice strong{color:#fff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.card{background:#172238;border:1px solid #2b3f60;border-radius:14px;padding:18px;box-shadow:0 8px 24px #0002}
.row{display:flex;gap:8px;margin-bottom:12px}.row input{flex:1;min-width:0;background:#0f192a;color:#edf4ff;border:1px solid #496488;border-radius:8px;padding:10px}
button{border:0;border-radius:8px;padding:9px 12px;cursor:pointer;background:#3d82d1;color:#fff;font-weight:600}button:hover{filter:brightness(1.12)}
button.remove{background:#6c3340;padding:5px 9px;font-size:12px}.items{display:flex;flex-direction:column;gap:7px;min-height:28px}
.item{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#0e1828;border-radius:8px;padding:8px 10px;font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-all}
.empty{color:#8294ad;font-size:13px}.settings{display:flex;flex-wrap:wrap;gap:16px}.settings label{display:flex;align-items:center;gap:8px;color:#d3deed}.settings input{width:18px;height:18px}
#message{min-height:24px;margin:16px 0;color:#9fd4a8}#message.error{color:#ffacac}.small{font-size:12px;color:#91a5bf}
@media(max-width:600px){main{padding:22px 12px}.row{flex-direction:column}.row button{width:100%}}
</style>
</head>
<body><main>
<h1>M365 Session Bridge 管理介面</h1>
<p>管理 SharePoint / OneDrive 的黑名單與寫入安全開關。這個頁面只綁定在 <code>127.0.0.1:${port}</code>；實際可存取範圍仍由 Edge 目前登入的帳號與 SharePoint 權限決定。</p>
<div class="notice"><strong>策略順序：</strong>支援的 SharePoint Online 目標預設可嘗試存取 → 黑名單優先拒絕 → Microsoft 365 驗證登入帳號權限。其他網域仍會硬擋。</div>
<div id="message"></div>
<section class="card"><h2>一般設定</h2><div class="settings">
<label><input id="writeEnabled" type="checkbox">允許寫入操作</label>
<label><input id="allowOverwrite" type="checkbox">允許 overwrite（仍需工具明確傳入）</label>
<label><input id="allowRecycle" type="checkbox">允許移到資源回收筒</label>
</div></section>
<div class="grid" style="margin-top:16px">
<section class="card"><h2>黑名單網域</h2><div class="row"><input id="deniedHostsInput" placeholder="不要操作的 SharePoint 網域"><button data-add="deniedHosts">加入</button></div><div id="deniedHosts" class="items"></div></section>
<section class="card"><h2>黑名單站台路徑</h2><div class="row"><input id="deniedSitesInput" placeholder="/sites/Confidential"><button data-add="deniedSites">加入</button></div><div id="deniedSites" class="items"></div></section>
<section class="card"><h2>允許上傳的本機專案資料夾</h2><div class="row"><input id="allowedLocalPathsInput" placeholder="C:\\Users\\you\\Documents\\Project"><button data-add="allowedLocalPaths">加入</button></div><div id="allowedLocalPaths" class="items"></div></section>
</div>
<p class="small">站台路徑黑名單會套用到所有支援的 SharePoint / OneDrive 網域。根目錄可輸入 <code>/</code>，代表該網域下的根站台。本機路徑請只加入實際專案資料夾，不接受磁碟根目錄；這只允許 Bridge 讀取待上傳檔案，不會讓 SharePoint 取得整台電腦內容。</p>
</main>
<script>
const lists=['deniedHosts','deniedSites','allowedLocalPaths'];
const $=id=>document.getElementById(id);
function message(text,error){const el=$('message');el.textContent=text;el.className=error?'error':'';}
function esc(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function render(policy){
  lists.forEach(list=>{const el=$(list);const values=policy[list]||[];el.innerHTML=values.length?values.map(value=>'<div class="item"><span>'+esc(value||'/')+'</span><button class="remove" data-remove="'+list+'" data-value="'+esc(value)+'">移除</button></div>').join(''):'<div class="empty">目前沒有項目</div>';});
  ['writeEnabled','allowOverwrite','allowRecycle'].forEach(key=>$(key).checked=Boolean(policy[key]));
  document.querySelectorAll('[data-remove]').forEach(button=>button.addEventListener('click',()=>changeEntry(button.dataset.remove,button.dataset.value,'remove')));
}
async function load(){try{const response=await fetch('/api/policy',{cache:'no-store'});if(!response.ok)throw new Error(await response.text());render(await response.json());}catch(error){message('讀取策略失敗：'+error.message,true);}}
async function changeEntry(list,value,action){try{const response=await fetch('/api/entries',{method:action==='remove'?'DELETE':'POST',headers:{'content-type':'application/json'},body:JSON.stringify({list,value})});const body=await response.json();if(!response.ok)throw new Error(body.message||'更新失敗');render(body);message(action==='remove'?'已移除':'已加入');}catch(error){message(error.message,true);}}
document.querySelectorAll('[data-add]').forEach(button=>button.addEventListener('click',()=>{const list=button.dataset.add;const input=$(list+'Input');if(input.value.trim())changeEntry(list,input.value.trim(),'add').then(()=>{input.value='';});}));
['writeEnabled','allowOverwrite','allowRecycle'].forEach(key=>$(key).addEventListener('change',async()=>{try{const response=await fetch('/api/settings',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({[key]:$(key).checked})});const body=await response.json();if(!response.ok)throw new Error(body.message||'設定更新失敗');render(body);message('設定已更新');}catch(error){message(error.message,true);load();}}));
load();
</script></body></html>`;
}

export function startControlPanel(): http.Server | null {
  if (process.env.M365_BRIDGE_CONTROL_PANEL === "0") return null;
  const port = controlPort();
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (requestUrl.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(controlPanelHtml(port));
        return;
      }
      if (requestUrl.pathname === "/api/policy" && req.method === "GET") {
        writeJson(res, 200, visiblePolicy(readPolicyForControlPanel()));
        return;
      }
      if (!isLocalOrigin(req, port)) {
        writeJson(res, 403, { message: "Only the local control-panel origin is accepted" });
        return;
      }
      if ((requestUrl.pathname === "/api/entries" && (req.method === "POST" || req.method === "DELETE")) || (requestUrl.pathname === "/api/settings" && req.method === "PATCH")) {
        const body = await readBody(req);
        if (requestUrl.pathname === "/api/entries") {
          if (!isEditableList(body.list) || typeof body.value !== "string" || !body.value.trim()) {
            writeJson(res, 400, { message: "list and value are required" });
            return;
          }
          const policy = req.method === "POST" ? addPolicyEntry(body.list, body.value) : removePolicyEntry(body.list, body.value);
          writeJson(res, 200, visiblePolicy(policy));
          return;
        }
        const allowedKeys = ["writeEnabled", "allowOverwrite", "allowRecycle"] as const;
        const updates: Partial<Record<(typeof allowedKeys)[number], boolean>> = {};
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            if (typeof body[key] !== "boolean") {
              writeJson(res, 400, { message: `${key} must be boolean` });
              return;
            }
            updates[key] = body[key];
          }
        }
        writeJson(res, 200, visiblePolicy(updatePolicySettings(updates)));
        return;
      }
      writeJson(res, 404, { message: "Not found" });
    } catch (err) {
      writeJson(res, 400, { message: err instanceof Error ? err.message : String(err) });
    }
  });
  server.on("error", (err) => {
    process.stderr.write(`[m365-bridge] control panel unavailable on 127.0.0.1:${port}: ${err.message}\n`);
  });
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`[m365-bridge] control panel: http://127.0.0.1:${port}/\n`);
  });
  return server;
}
