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
