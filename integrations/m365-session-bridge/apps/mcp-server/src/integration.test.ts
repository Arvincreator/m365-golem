import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "index.js");
const repoRoot = path.resolve(here, "..", "..", "..");

interface JsonRpcResponse {
  id?: number;
  result?: { content?: Array<{ type: string; text: string }> };
}

function startServer(policyOverrides: Record<string, unknown> = {}): {
  child: ChildProcessWithoutNullStreams;
  send: (msg: Record<string, unknown>) => void;
  waitFor: (id: number, timeoutMs?: number) => Promise<JsonRpcResponse>;
  policyPath: string;
  pipeName: string;
} {
  const basePolicy = JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "policy.default.json"), "utf8"));
  // Pin the site/library allowlist explicitly rather than inheriting whatever
  // a developer's local policy happens to contain — otherwise
  // these tests pass or fail depending on the machine they run on.
  const policy = {
    ...basePolicy,
    writeEnabled: true,
    allowedHosts: ["contoso.sharepoint.com"],
    allowedSites: ["/sites/TestSite"],
    allowedLibraries: [],
    allowedLocalPaths: [path.join(os.homedir(), "Documents", "M365-Golem")],
    ...policyOverrides,
  };
  const policyPath = path.join(os.tmpdir(), `m365-bridge-it-policy-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  // A unique pipe name per spawned test server: without this, these tests
  // collide with a real, already-running MCP Server (e.g. one M365 Golem
  // spawned) that already owns the default pipe name, causing this test
  // server's listen() to fail and every request to time out.
  const pipeName = `\\\\.\\pipe\\m365-bridge-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const child = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      M365_BRIDGE_POLICY_PATH: policyPath,
      M365_BRIDGE_PIPE_NAME: pipeName,
      M365_BRIDGE_CONTROL_PANEL: "0",
    },
  });

  const waiters = new Map<number, (r: JsonRpcResponse) => void>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (typeof msg.id === "number") {
        const w = waiters.get(msg.id);
        if (w) {
          waiters.delete(msg.id);
          w(msg);
        }
      }
    }
  });

  function send(msg: Record<string, unknown>) {
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  function waitFor(id: number, timeoutMs = 5000): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for response id=${id}`));
      }, timeoutMs);
      waiters.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  return { child, send, waitFor, policyPath, pipeName };
}

/**
 * A minimal stand-in for the Edge native host, connected over the same named
 * pipe the real native host would use. It answers `requestApproval` with a
 * configurable decision and records every approval request it receives (so a
 * test can assert exactly which/how many targets triggered the dialog), and
 * answers every other op with a small, valid-shaped success result so the
 * MCP server's tool handler completes without needing the real Edge
 * extension. This lets integration tests exercise the full read-tool ->
 * shared authorizer -> approval-transport path end to end, not just the
 * `EDGE_EXTENSION_OFFLINE` short-circuit that fires when no native host is
 * connected at all.
 */
function connectFakeNativeHost(
  pipeName: string,
  approvalDecision: "allow-once" | "allow-always" | "deny" = "deny"
): {
  approvalRequests: Array<{ hostname: string; url: string; action: string; detail?: string }>;
  ready: Promise<void>;
  close: () => void;
} {
  const approvalRequests: Array<{ hostname: string; url: string; action: string; detail?: string }> = [];
  let activeSocket: net.Socket | null = null;
  let closed = false;

  function resultFor(op: string, payload: Record<string, unknown>): Record<string, unknown> {
    switch (op) {
      case "status":
        return { extensionOnline: true, reachable: true };
      case "download":
        return { localPath: payload.destinationPath, fileName: "fake.txt", size: 3, sha256: "deadbeef" };
      case "getUrl":
        return { url: "https://contoso.sharepoint.com/sites/TestSite/Shared%20Documents/report.docx" };
      case "listFolder":
        return { items: [], folders: [], truncated: false };
      case "listFileVersions":
        return { versions: [] };
      default:
        return {};
    }
  }

  function wireSocket(socket: net.Socket): void {
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { kind?: string; id?: string; op?: string; payload?: Record<string, unknown> };
        if (message.kind !== "request" || !message.id) continue;
        if (message.op === "requestApproval") {
          const payload = (message.payload ?? {}) as { hostname: string; url: string; action: string; detail?: string };
          approvalRequests.push(payload);
          socket.write(JSON.stringify({ kind: "response", id: message.id, ok: true, result: { decision: approvalDecision } }) + "\n");
          continue;
        }
        socket.write(
          JSON.stringify({ kind: "response", id: message.id, ok: true, result: resultFor(message.op ?? "", message.payload ?? {}) }) + "\n"
        );
      }
    });
  }

  // The child MCP server process needs a moment after spawn() before it has
  // even loaded its module graph and reached `nativeHost.listen()`, so the
  // named pipe often does not exist yet on the first connection attempt
  // (Windows surfaces this as ENOENT). Retry with a short backoff instead of
  // requiring the caller to guess a fixed startup delay.
  const ready = new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const attempt = () => {
      if (closed) return;
      const socket = net.createConnection(pipeName);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        activeSocket = socket;
        wireSocket(socket);
        socket.write(JSON.stringify({ kind: "hello", role: "native-host" }) + "\n");
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out connecting the fake native host to ${pipeName}`));
          return;
        }
        setTimeout(attempt, 50);
      });
    };
    attempt();
  });

  return {
    approvalRequests,
    ready,
    close: () => {
      closed = true;
      activeSocket?.destroy();
    },
  };
}

async function initialize(send: (m: Record<string, unknown>) => void, waitFor: (id: number) => Promise<JsonRpcResponse>) {
  send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "it", version: "0" } } });
  await waitFor(0);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

function textOf(resp: JsonRpcResponse): Record<string, unknown> {
  const text = resp.result?.content?.[0]?.text;
  assert.ok(text, "expected a text content item in the tool result");
  return JSON.parse(text!);
}

test("m365_download_file returns EDGE_EXTENSION_OFFLINE when no native host is connected", async () => {
  const { child, send, waitFor, policyPath } = startServer();
  try {
    await initialize(send, waitFor);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "m365_download_file",
        arguments: {
          fileUrl: "https://contoso.sharepoint.com/sites/TestSite/a.txt",
          destinationPath: path.join(os.homedir(), "Documents", "M365-Golem", "a.txt"),
        },
      },
    });
    const resp = await waitFor(1);
    const body = textOf(resp);
    assert.equal(body.status, "error");
    assert.equal(body.code, "EDGE_EXTENSION_OFFLINE");
  } finally {
    child.kill();
    fs.unlinkSync(policyPath);
  }
});

test("m365_create_folder rejects a crafted folderName that would escape the authorized site", async () => {
  const { child, send, waitFor, policyPath } = startServer();
  try {
    await initialize(send, waitFor);
    // Each of these tries a different way to break out of /sites/TestSite via
    // the folderName argument, which is concatenated onto the validated
    // parent path. None may be accepted, and none may reach the extension.
    const attempts = [
      "../../EscapedSite/Evil",
      "..",
      "sub/../../../Evil",
      "a/b/../../../../Evil",
      "bad|name",
      "",
    ];
    for (const [i, folderName] of attempts.entries()) {
      send({
        jsonrpc: "2.0",
        id: 100 + i,
        method: "tools/call",
        params: {
          name: "m365_create_folder",
          arguments: {
            parentFolderUrl: "https://contoso.sharepoint.com/sites/TestSite/Shared Documents",
            folderName,
          },
        },
      });
      const body = textOf(await waitFor(100 + i));
      assert.equal(body.status, "error", `folderName ${JSON.stringify(folderName)} should have been rejected`);
      // It must fail on validation, never by reaching the (absent) extension.
      assert.notEqual(
        body.code,
        "EDGE_EXTENSION_OFFLINE",
        `folderName ${JSON.stringify(folderName)} reached the extension instead of being rejected`
      );
    }
  } finally {
    child.kill();
    fs.unlinkSync(policyPath);
  }
});

test("m365_create_folder accepts a legitimate nested path (reaching the offline extension proves it passed policy)", async () => {
  const { child, send, waitFor, policyPath } = startServer();
  try {
    await initialize(send, waitFor);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "m365_create_folder",
        arguments: {
          parentFolderUrl: "https://contoso.sharepoint.com/sites/TestSite/Shared Documents",
          folderName: "2026/Q1",
        },
      },
    });
    const body = textOf(await waitFor(1));
    assert.equal(body.status, "error");
    // Passing every policy check and failing only because no extension is
    // connected is exactly the expected outcome in this harness.
    assert.equal(body.code, "EDGE_EXTENSION_OFFLINE");
  } finally {
    child.kill();
    fs.unlinkSync(policyPath);
  }
});

test("m365_upload_file with writeEnabled=false returns FORBIDDEN_BY_POLICY before touching the extension", async () => {
  const { child, send, waitFor, policyPath } = startServer({ writeEnabled: false });
  try {
    await initialize(send, waitFor);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "m365_upload_file",
        arguments: {
          localPath: path.join(os.homedir(), "Documents", "M365-Golem", "does-not-need-to-exist.txt"),
          destinationFolderUrl: "https://contoso.sharepoint.com/sites/TestSite/Shared Documents",
          fileName: "x.txt",
          overwrite: false,
        },
      },
    });
    const resp = await waitFor(1);
    const body = textOf(resp);
    assert.equal(body.status, "error");
    assert.equal(body.code, "FORBIDDEN_BY_POLICY");
  } finally {
    child.kill();
    fs.unlinkSync(policyPath);
  }
});

// ===========================================================================
// v0.2 capabilities
// ===========================================================================

const SITE_FILE = "https://contoso.sharepoint.com/sites/TestSite/Shared Documents/report.docx";
const SITE_FOLDER = "https://contoso.sharepoint.com/sites/TestSite/Shared Documents/2026";

/** Runs a batch of tool calls against one server instance and returns each parsed result. */
async function callTools(
  policyOverrides: Record<string, unknown>,
  calls: Array<{ name: string; arguments: Record<string, unknown> }>
): Promise<Record<string, unknown>[]> {
  const { child, send, waitFor, policyPath } = startServer(policyOverrides);
  try {
    await initialize(send, waitFor);
    const bodies: Record<string, unknown>[] = [];
    for (const [i, call] of calls.entries()) {
      send({ jsonrpc: "2.0", id: 200 + i, method: "tools/call", params: { name: call.name, arguments: call.arguments } });
      bodies.push(textOf(await waitFor(200 + i)));
    }
    return bodies;
  } finally {
    child.kill();
    fs.unlinkSync(policyPath);
  }
}

// Every v0.2 write tool, with arguments that are otherwise completely valid so
// the ONLY reason each can fail is the policy guard under test.
const V02_WRITE_CALLS: Array<{ name: string; arguments: Record<string, unknown> }> = [
  { name: "m365_rename_folder", arguments: { folderUrl: SITE_FOLDER, newName: "2027" } },
  { name: "m365_recycle_folder", arguments: { folderUrl: SITE_FOLDER, confirmation: "CONFIRM_RECYCLE_FOLDER" } },
  { name: "m365_restore_file_version", arguments: { fileUrl: SITE_FILE, versionLabel: "1.0", confirmation: "CONFIRM_RESTORE_VERSION" } },
  { name: "m365_checkout_file", arguments: { fileUrl: SITE_FILE } },
  { name: "m365_checkin_file", arguments: { fileUrl: SITE_FILE, comment: "done", checkInType: "major" } },
  { name: "m365_discard_checkout", arguments: { fileUrl: SITE_FILE, confirmation: "CONFIRM_DISCARD_CHECKOUT" } },
  { name: "m365_update_file_metadata", arguments: { fileUrl: SITE_FILE, fields: { Title: "New title" } } },
];

test("every v0.2 write tool returns FORBIDDEN_BY_POLICY when writeEnabled:false, before touching the extension", async () => {
  const bodies = await callTools({ writeEnabled: false }, V02_WRITE_CALLS);
  for (const [i, body] of bodies.entries()) {
    const toolName = V02_WRITE_CALLS[i].name;
    assert.equal(body.status, "error", `${toolName} should have been rejected`);
    assert.equal(body.code, "FORBIDDEN_BY_POLICY", `${toolName} returned ${String(body.code)} instead of FORBIDDEN_BY_POLICY`);
  }
});

test("every v0.2 write tool passes policy and reaches the (absent) extension when fully authorized", async () => {
  const bodies = await callTools({}, V02_WRITE_CALLS);
  for (const [i, body] of bodies.entries()) {
    const toolName = V02_WRITE_CALLS[i].name;
    // Failing only because no extension is connected proves every guard
    // upstream of the network call accepted the request.
    assert.equal(body.code, "EDGE_EXTENSION_OFFLINE", `${toolName} returned ${String(body.code)}: ${String(body.message)}`);
  }
});

test("v0.2 read tools require the Edge extension to be connected, same as write tools", async () => {
  // No native host is connected in this harness, so requireExtensionOnline()
  // must reject every read tool before it even reaches the target
  // authorizer, exactly like the write tools above. This intentionally does
  // NOT prove anything about allowedSites/deniedSites behavior for reads —
  // since the unified target authorizer, an unlisted-but-supported host on a
  // read is no longer a free pass (see the dedicated
  // "read tools route through the same target authorizer as write tools"
  // tests below, which connect a fake native host to actually exercise that
  // path instead of short-circuiting on EDGE_EXTENSION_OFFLINE).
  const bodies = await callTools({ allowedSites: ["/sites/SomewhereElse"], writeEnabled: false }, [
    { name: "m365_list_folder", arguments: { folderUrl: SITE_FOLDER } },
    { name: "m365_list_file_versions", arguments: { fileUrl: SITE_FILE } },
  ]);
  for (const body of bodies) {
    assert.equal(body.code, "EDGE_EXTENSION_OFFLINE", `read tool returned ${String(body.code)}: ${String(body.message)}`);
  }
});

test("confirmation tokens do not cross-validate between destructive v0.2 tools", async () => {
  // Each row: the tool, and a token that must NOT authorize it. Includes the
  // file-recycle token (CONFIRM_RECYCLE) being replayed at the far more
  // destructive folder recycle, and each v0.2 token aimed at the wrong tool.
  const attempts: Array<{ name: string; arguments: Record<string, unknown>; why: string }> = [
    { name: "m365_recycle_folder", arguments: { folderUrl: SITE_FOLDER, confirmation: "CONFIRM_RECYCLE" }, why: "file-recycle token replayed at folder recycle" },
    { name: "m365_recycle_folder", arguments: { folderUrl: SITE_FOLDER, confirmation: "CONFIRM_DISCARD_CHECKOUT" }, why: "wrong v0.2 token" },
    { name: "m365_recycle_folder", arguments: { folderUrl: SITE_FOLDER, confirmation: "" }, why: "missing token" },
    { name: "m365_recycle_folder", arguments: { folderUrl: SITE_FOLDER, confirmation: "confirm_recycle_folder" }, why: "wrong case" },
    { name: "m365_restore_file_version", arguments: { fileUrl: SITE_FILE, versionLabel: "1.0", confirmation: "CONFIRM_RECYCLE_FOLDER" }, why: "wrong v0.2 token" },
    { name: "m365_restore_file_version", arguments: { fileUrl: SITE_FILE, versionLabel: "1.0", confirmation: "" }, why: "missing token" },
    { name: "m365_discard_checkout", arguments: { fileUrl: SITE_FILE, confirmation: "CONFIRM_RESTORE_VERSION" }, why: "wrong v0.2 token" },
    { name: "m365_discard_checkout", arguments: { fileUrl: SITE_FILE, confirmation: "" }, why: "missing token" },
    { name: "m365_recycle_file", arguments: { fileUrl: SITE_FILE, confirmation: "CONFIRM_RECYCLE_FOLDER" }, why: "folder token replayed at file recycle" },
  ];
  const bodies = await callTools({}, attempts);
  for (const [i, body] of bodies.entries()) {
    const { name, why } = attempts[i];
    assert.equal(body.status, "error", `${name} (${why}) should have been rejected`);
    assert.equal(body.code, "NEEDS_USER_CONFIRMATION", `${name} (${why}) returned ${String(body.code)}`);
  }
});

test("m365_update_file_metadata rejects every forbidden identity/permission/path field", async () => {
  const forbidden = [
    "FileLeafRef",
    "FileRef",
    "FileDirRef",
    "ContentTypeId",
    "Author",
    "Editor",
    "ID",
    "GUID",
    "PermMask",
    "owshiddenversion",
    "_ModerationStatus",
  ];
  const calls = [
    // One call per forbidden field on its own...
    ...forbidden.map((field) => ({
      name: "m365_update_file_metadata",
      arguments: { fileUrl: SITE_FILE, fields: { [field]: "x" } },
    })),
    // ...and each one smuggled in alongside a legitimate field, so a guard
    // that only inspected the first key would be caught.
    ...forbidden.map((field) => ({
      name: "m365_update_file_metadata",
      arguments: { fileUrl: SITE_FILE, fields: { Title: "legit", [field]: "x" } },
    })),
    // Case variations must not slip past the allowlist either.
    { name: "m365_update_file_metadata", arguments: { fileUrl: SITE_FILE, fields: { fileref: "/somewhere/else" } } },
    { name: "m365_update_file_metadata", arguments: { fileUrl: SITE_FILE, fields: { FILELEAFREF: "renamed.docx" } } },
  ];
  const bodies = await callTools({}, calls);
  for (const [i, body] of bodies.entries()) {
    const field = Object.keys(calls[i].arguments.fields as Record<string, unknown>).join("+");
    assert.equal(body.status, "error", `fields {${field}} should have been rejected`);
    assert.equal(body.code, "FORBIDDEN_BY_POLICY", `fields {${field}} returned ${String(body.code)}`);
    assert.notEqual(body.code, "EDGE_EXTENSION_OFFLINE", `fields {${field}} reached the extension instead of being rejected`);
  }
});

test("m365_update_file_metadata rejects non-scalar field values with INVALID_INPUT", async () => {
  const calls = [
    { name: "m365_update_file_metadata", arguments: { fileUrl: SITE_FILE, fields: { Reviewer: { Id: 7 } } } },
    { name: "m365_update_file_metadata", arguments: { fileUrl: SITE_FILE, fields: { Tags: ["a", "b"] } } },
    { name: "m365_update_file_metadata", arguments: { fileUrl: SITE_FILE, fields: { Approved: true } } },
    { name: "m365_update_file_metadata", arguments: { fileUrl: SITE_FILE, fields: {} } },
  ];
  const bodies = await callTools({}, calls);
  for (const [i, body] of bodies.entries()) {
    assert.equal(body.status, "error", `call ${i} should have been rejected`);
    assert.equal(body.code, "INVALID_INPUT", `call ${i} returned ${String(body.code)}`);
  }
});

test("m365_update_file_metadata accepts string, number and null values", async () => {
  const [body] = await callTools({}, [
    {
      name: "m365_update_file_metadata",
      arguments: { fileUrl: SITE_FILE, fields: { Title: "季報 Q1", Score: 5, Notes: null } },
    },
  ]);
  assert.equal(body.code, "EDGE_EXTENSION_OFFLINE", `expected to pass policy, got ${String(body.code)}: ${String(body.message)}`);
});

test("m365_checkin_file rejects a comment longer than 1023 characters locally", async () => {
  const bodies = await callTools({}, [
    { name: "m365_checkin_file", arguments: { fileUrl: SITE_FILE, comment: "x".repeat(1024) } },
    { name: "m365_checkin_file", arguments: { fileUrl: SITE_FILE, comment: "x".repeat(1023) } },
  ]);
  assert.equal(bodies[0].status, "error");
  assert.equal(bodies[0].code, "INVALID_INPUT");
  // The boundary value is valid and must reach the (absent) extension.
  assert.equal(bodies[1].code, "EDGE_EXTENSION_OFFLINE");
});

test("m365_rename_folder rejects names that would turn a rename into a move", async () => {
  const calls = ["../Evil", "sub/child", "..", "bad|name", "", "a\\b"].map((newName) => ({
    name: "m365_rename_folder",
    arguments: { folderUrl: SITE_FOLDER, newName },
  }));
  const bodies = await callTools({}, calls);
  for (const [i, body] of bodies.entries()) {
    const newName = (calls[i].arguments as { newName: string }).newName;
    assert.equal(body.status, "error", `newName ${JSON.stringify(newName)} should have been rejected`);
    assert.equal(body.code, "INVALID_INPUT", `newName ${JSON.stringify(newName)} returned ${String(body.code)}`);
  }
});

test("m365_list_folder caps maxItems at 1000 and rejects out-of-range values", async () => {
  const { child, send, waitFor, policyPath } = startServer();
  try {
    await initialize(send, waitFor);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "m365_list_folder", arguments: { folderUrl: SITE_FOLDER, maxItems: 5000 } },
    });
    const resp = await waitFor(1);
    // Rejected by the zod schema (max 1000) before the handler ever runs, so
    // this surfaces as a tool error rather than a bridge error body.
    const text = JSON.stringify(resp);
    assert.ok(!text.includes("EDGE_EXTENSION_OFFLINE"), "maxItems:5000 must not reach the extension");
  } finally {
    child.kill();
    fs.unlinkSync(policyPath);
  }
});

test("m365_bridge_status reports extensionOnline:false and the configured tenant host when idle", async () => {
  const { child, send, waitFor, policyPath } = startServer();
  try {
    await initialize(send, waitFor);
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "m365_bridge_status", arguments: {} } });
    const resp = await waitFor(1);
    const body = textOf(resp);
    assert.equal(body.status, "success");
    assert.equal(body.extensionOnline, false);
    assert.equal(body.m365SessionAvailable, false);
    assert.equal(body.tenantHost, "contoso.sharepoint.com");
  } finally {
    child.kill();
    fs.unlinkSync(policyPath);
  }
});

// ===========================================================================
// Unified target authorizer: read tools vs. write tools (APPROVAL_FLOW_SPEC
// addendum, confirmed 2026-08-10). A connected fake native host is required
// to actually exercise the approval-dialog branch instead of short-circuiting
// on EDGE_EXTENSION_OFFLINE, which is what every read-tool test above does.
// ===========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls m365_bridge_status (no target authorization involved) until the fake native host's handshake has been processed server-side. */
async function waitForExtensionOnline(
  send: (msg: Record<string, unknown>) => void,
  waitFor: (id: number, timeoutMs?: number) => Promise<JsonRpcResponse>,
  probeId: number
): Promise<void> {
  const deadline = Date.now() + 5000;
  for (let attempt = 0; ; attempt += 1) {
    send({ jsonrpc: "2.0", id: probeId + attempt, method: "tools/call", params: { name: "m365_bridge_status", arguments: {} } });
    const body = textOf(await waitFor(probeId + attempt));
    if (body.extensionOnline === true) return;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the fake native host to be recognized as connected");
    await sleep(50);
  }
}

const UNLISTED_HOST_FILE = "https://other.sharepoint.com/sites/Ops/Shared Documents/report.docx";
const UNLISTED_HOST_FOLDER = "https://other.sharepoint.com/sites/Ops/Shared Documents";

test("read tools route through the same target authorizer as write tools: unlisted supported host triggers approval on both", async () => {
  const { child, send, waitFor, policyPath, pipeName } = startServer({ writeEnabled: true });
  const fakeHost = connectFakeNativeHost(pipeName, "deny");
  try {
    await fakeHost.ready;
    await initialize(send, waitFor);
    await waitForExtensionOnline(send, waitFor, 900);

    const readCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: "m365_download_file", arguments: { fileUrl: UNLISTED_HOST_FILE, destinationPath: path.join(os.homedir(), "Documents", "M365-Golem", "unlisted.txt") } },
      { name: "m365_get_file_url", arguments: { fileUrl: UNLISTED_HOST_FILE } },
      { name: "m365_list_folder", arguments: { folderUrl: UNLISTED_HOST_FOLDER } },
      { name: "m365_list_file_versions", arguments: { fileUrl: UNLISTED_HOST_FILE } },
    ];
    for (const [i, call] of readCalls.entries()) {
      send({ jsonrpc: "2.0", id: 1000 + i, method: "tools/call", params: { name: call.name, arguments: call.arguments } });
      const body = textOf(await waitFor(1000 + i));
      assert.equal(body.status, "error", `${call.name} against an unlisted host should have been denied`);
      assert.equal(body.code, "FORBIDDEN_BY_POLICY", `${call.name} returned ${String(body.code)} instead of FORBIDDEN_BY_POLICY`);
    }
    assert.equal(fakeHost.approvalRequests.length, 4, "each of the 4 read tools must independently trigger one requestApproval call");
    for (const req of fakeHost.approvalRequests) {
      assert.equal(req.hostname, "other.sharepoint.com");
    }

    // A write tool against the same unlisted host must hit the identical
    // approval path — same call count growth, same hostname, same denial.
    send({
      jsonrpc: "2.0",
      id: 2000,
      method: "tools/call",
      params: { name: "m365_rename_file", arguments: { fileUrl: UNLISTED_HOST_FILE, newName: "renamed.docx" } },
    });
    const writeBody = textOf(await waitFor(2000));
    assert.equal(writeBody.code, "FORBIDDEN_BY_POLICY");
    assert.equal(fakeHost.approvalRequests.length, 5, "the write tool must reach the same approval transport as the read tools");
  } finally {
    fakeHost.close();
    child.kill();
    fs.unlinkSync(policyPath);
  }
});

test("read tools route through the same target authorizer as write tools: allowlisted host+site reads silently with zero approval calls", async () => {
  const { child, send, waitFor, policyPath, pipeName } = startServer({ writeEnabled: true });
  // Decision is irrelevant here — the assertion is that it is never asked.
  const fakeHost = connectFakeNativeHost(pipeName, "deny");
  try {
    await fakeHost.ready;
    await initialize(send, waitFor);
    await waitForExtensionOnline(send, waitFor, 900);

    const readCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: "m365_download_file", arguments: { fileUrl: SITE_FILE, destinationPath: path.join(os.homedir(), "Documents", "M365-Golem", "listed.txt") } },
      { name: "m365_get_file_url", arguments: { fileUrl: SITE_FILE } },
      { name: "m365_list_folder", arguments: { folderUrl: SITE_FOLDER } },
      { name: "m365_list_file_versions", arguments: { fileUrl: SITE_FILE } },
    ];
    for (const [i, call] of readCalls.entries()) {
      send({ jsonrpc: "2.0", id: 3000 + i, method: "tools/call", params: { name: call.name, arguments: call.arguments } });
      const body = textOf(await waitFor(3000 + i));
      assert.equal(body.status, "success", `${call.name} against an allowlisted host+site should succeed silently: ${JSON.stringify(body)}`);
    }
    assert.equal(fakeHost.approvalRequests.length, 0, "an allowlisted host+site must never call the approval transport");
  } finally {
    fakeHost.close();
    child.kill();
    fs.unlinkSync(policyPath);
  }
});
