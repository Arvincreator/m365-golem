import { test } from "node:test";
import assert from "node:assert/strict";
import { IPC_PIPE_NAME, resolveIpcPipeName } from "./ipc.js";

test("installed bridge state gets a deterministic isolated pipe", () => {
  const previousPipe = process.env.M365_BRIDGE_PIPE_NAME;
  const previousSecret = process.env.M365_BRIDGE_SECRET_PATH;
  try {
    delete process.env.M365_BRIDGE_PIPE_NAME;
    process.env.M365_BRIDGE_SECRET_PATH = "C:\\Users\\Example\\AppData\\Local\\M365-Golem\\m365-session-bridge\\runtime\\ipc-secret.json";
    const first = resolveIpcPipeName();

    process.env.M365_BRIDGE_SECRET_PATH = "c:/users/example/appdata/local/m365-golem/m365-session-bridge/runtime/ipc-secret.json";
    assert.equal(resolveIpcPipeName(), first);
    assert.match(first, /^\\\\\.\\pipe\\m365-session-bridge-[0-9a-f]{8}$/);

    process.env.M365_BRIDGE_SECRET_PATH = "C:\\other-install\\runtime\\ipc-secret.json";
    assert.notEqual(resolveIpcPipeName(), first);
  } finally {
    if (previousPipe === undefined) delete process.env.M365_BRIDGE_PIPE_NAME;
    else process.env.M365_BRIDGE_PIPE_NAME = previousPipe;
    if (previousSecret === undefined) delete process.env.M365_BRIDGE_SECRET_PATH;
    else process.env.M365_BRIDGE_SECRET_PATH = previousSecret;
  }
});

test("explicit pipe override and legacy fallback remain available", () => {
  const previousPipe = process.env.M365_BRIDGE_PIPE_NAME;
  const previousSecret = process.env.M365_BRIDGE_SECRET_PATH;
  try {
    process.env.M365_BRIDGE_PIPE_NAME = "\\\\.\\pipe\\m365-bridge-test-explicit";
    process.env.M365_BRIDGE_SECRET_PATH = "C:\\ignored\\secret.json";
    assert.equal(resolveIpcPipeName(), "\\\\.\\pipe\\m365-bridge-test-explicit");

    delete process.env.M365_BRIDGE_PIPE_NAME;
    delete process.env.M365_BRIDGE_SECRET_PATH;
    assert.equal(resolveIpcPipeName(), IPC_PIPE_NAME);
  } finally {
    if (previousPipe === undefined) delete process.env.M365_BRIDGE_PIPE_NAME;
    else process.env.M365_BRIDGE_PIPE_NAME = previousPipe;
    if (previousSecret === undefined) delete process.env.M365_BRIDGE_SECRET_PATH;
    else process.env.M365_BRIDGE_SECRET_PATH = previousSecret;
  }
});
