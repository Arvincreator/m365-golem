import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { NativeHostServer } from "./pipe-server.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for bridge IPC state");
    await wait(25);
  }
}

test("a second MCP server proxies requests through the pipe owner", async () => {
  const pipeName = `\\\\.\\pipe\\m365-bridge-multi-${process.pid}-${Date.now()}`;
  const secretPath = path.join(os.tmpdir(), `m365-bridge-multi-secret-${process.pid}-${Date.now()}.json`);
  const previousPipe = process.env.M365_BRIDGE_PIPE_NAME;
  const previousSecret = process.env.M365_BRIDGE_SECRET_PATH;
  process.env.M365_BRIDGE_PIPE_NAME = pipeName;
  process.env.M365_BRIDGE_SECRET_PATH = secretPath;

  const first = new NativeHostServer();
  const second = new NativeHostServer();
  let host: net.Socket | undefined;
  let hostBuffer = "";

  try {
    first.listen();
    second.listen();

    host = net.createConnection(pipeName);
    host.setEncoding("utf8");
    host.on("data", (chunk: string) => {
      hostBuffer += chunk;
      let idx: number;
      while ((idx = hostBuffer.indexOf("\n")) >= 0) {
        const line = hostBuffer.slice(0, idx);
        hostBuffer = hostBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { kind?: string; id?: string };
        if (message.kind === "request" && message.id) {
          host?.write(JSON.stringify({ kind: "response", id: message.id, ok: true, result: { reachable: true } }) + "\n");
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      host?.once("connect", () => resolve());
      host?.once("error", reject);
    });
    host.write(JSON.stringify({ kind: "hello", role: "native-host" }) + "\n");

    await waitUntil(() => first.isNativeHostConnected() && second.isNativeHostConnected());
    const [firstReply, secondReply] = await Promise.all([
      first.sendRequest("status", {}),
      second.sendRequest("status", {}),
    ]);
    assert.equal(firstReply.ok, true);
    assert.equal(secondReply.ok, true);
    assert.equal((firstReply.result as { reachable?: boolean }).reachable, true);
    assert.equal((secondReply.result as { reachable?: boolean }).reachable, true);
  } finally {
    host?.destroy();
    first.close();
    second.close();
    if (previousPipe === undefined) delete process.env.M365_BRIDGE_PIPE_NAME;
    else process.env.M365_BRIDGE_PIPE_NAME = previousPipe;
    if (previousSecret === undefined) delete process.env.M365_BRIDGE_SECRET_PATH;
    else process.env.M365_BRIDGE_SECRET_PATH = previousSecret;
    try {
      fs.rmSync(secretPath, { force: true });
    } catch {
      // Best-effort cleanup of the test-only secret.
    }
  }
});

test("multiple Edge native hosts coexist and the newest connection is preferred", async () => {
  const pipeName = `\\\\.\\pipe\\m365-bridge-hosts-${process.pid}-${Date.now()}`;
  const secretPath = path.join(os.tmpdir(), `m365-bridge-hosts-secret-${process.pid}-${Date.now()}.json`);
  const previousPipe = process.env.M365_BRIDGE_PIPE_NAME;
  const previousSecret = process.env.M365_BRIDGE_SECRET_PATH;
  process.env.M365_BRIDGE_PIPE_NAME = pipeName;
  process.env.M365_BRIDGE_SECRET_PATH = secretPath;

  const server = new NativeHostServer();
  let firstHost: net.Socket | undefined;
  let secondHost: net.Socket | undefined;
  let firstRequests = 0;
  let secondRequests = 0;

  const respond = (host: net.Socket, makeReply: (id: string) => Record<string, unknown>) => {
    host.setEncoding("utf8");
    let buffer = "";
    host.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { kind?: string; id?: string };
        if (message.kind === "request" && message.id) {
          host.write(JSON.stringify(makeReply(message.id)) + "\n");
        }
      }
    });
  };

  try {
    server.listen();
    await waitUntil(() => fs.existsSync(secretPath));
    const firstConnection = net.createConnection(pipeName);
    firstHost = firstConnection;
    await new Promise<void>((resolve, reject) => {
      firstConnection.once("connect", resolve);
      firstConnection.once("error", reject);
    });
    respond(firstConnection, (id) => {
      firstRequests++;
      return { kind: "response", id, ok: true, result: {} };
    });
    firstConnection.write(JSON.stringify({ kind: "hello", role: "native-host" }) + "\n");
    await wait(25);

    const secondConnection = net.createConnection(pipeName);
    secondHost = secondConnection;
    await new Promise<void>((resolve, reject) => {
      secondConnection.once("connect", resolve);
      secondConnection.once("error", reject);
    });
    respond(secondConnection, (id) => {
      secondRequests++;
      if (secondRequests === 2) {
        return {
          kind: "response",
          id,
          ok: false,
          errorCode: "INTERNAL_ERROR",
          errorMessage: "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
        };
      }
      return { kind: "response", id, ok: true, result: {} };
    });
    secondConnection.write(JSON.stringify({ kind: "hello", role: "native-host" }) + "\n");
    await wait(25);
    await waitUntil(() => server.isNativeHostConnected());

    const newestReply = await server.sendRequest("status", {});
    assert.equal(newestReply.ok, true);
    assert.equal(firstConnection.destroyed, false);
    assert.equal(firstRequests, 0);
    assert.equal(secondRequests, 1);

    const permissionFallbackReply = await server.sendRequest("status", {});
    assert.equal(permissionFallbackReply.ok, true);
    assert.equal(firstRequests, 1);
    assert.equal(secondRequests, 2);

    secondConnection.destroy();
    await wait(25);
    const fallbackReply = await server.sendRequest("status", {});
    assert.equal(fallbackReply.ok, true);
    assert.equal(firstRequests, 2);
  } finally {
    firstHost?.destroy();
    secondHost?.destroy();
    server.close();
    if (previousPipe === undefined) delete process.env.M365_BRIDGE_PIPE_NAME;
    else process.env.M365_BRIDGE_PIPE_NAME = previousPipe;
    if (previousSecret === undefined) delete process.env.M365_BRIDGE_SECRET_PATH;
    else process.env.M365_BRIDGE_SECRET_PATH = previousSecret;
    try {
      fs.rmSync(secretPath, { force: true });
    } catch {
      // Best-effort cleanup of the test-only secret.
    }
  }
});
