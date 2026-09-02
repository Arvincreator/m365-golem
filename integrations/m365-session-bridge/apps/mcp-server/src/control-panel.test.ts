import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startControlPanel } from "./control-panel.js";

function validPolicy() {
  return {
    writeEnabled: true,
    readHostPatterns: ["*.sharepoint.com"],
    allowedHosts: ["tenant.sharepoint.com"],
    allowedSites: ["/sites/TestSite"],
    deniedHosts: [],
    deniedSites: [],
    allowedLibraries: [],
    allowedLocalPaths: ["%TEMP%\\m365"],
    allowOverwrite: false,
    allowRecycle: true,
    allowPermanentDelete: false,
    allowExternalSharing: false,
    allowPermissionChange: false,
    allowBulkDelete: false,
    allowArbitraryHttp: false,
    denylistExtensions: [],
  };
}

test("control panel is loopback-only and edits policy lists through validated endpoints", async () => {
  const policyPath = path.join(os.tmpdir(), `m365-bridge-panel-${process.pid}-${Date.now()}.json`);
  const port = 43_500 + (process.pid % 500);
  const previousPolicy = process.env.M365_BRIDGE_POLICY_PATH;
  const previousPort = process.env.M365_BRIDGE_CONTROL_PORT;
  const previousEnabled = process.env.M365_BRIDGE_CONTROL_PANEL;
  fs.writeFileSync(policyPath, `${JSON.stringify(validPolicy(), null, 2)}\n`, "utf8");
  process.env.M365_BRIDGE_POLICY_PATH = policyPath;
  process.env.M365_BRIDGE_CONTROL_PORT = String(port);
  delete process.env.M365_BRIDGE_CONTROL_PANEL;
  const server = startControlPanel();
  if (!server) throw new Error("control panel unexpectedly disabled");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /M365 Session Bridge/);
    assert.match(html, /白名單網域/);
    assert.match(html, /黑名單網域/);
    assert.match(html, /永遠允許/);

    const initial = await fetch(`http://127.0.0.1:${port}/api/policy`);
    assert.equal(initial.status, 200);
    assert.deepEqual((await initial.json() as { deniedHosts: string[] }).deniedHosts, []);

    const added = await fetch(`http://127.0.0.1:${port}/api/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ list: "deniedHosts", value: "blocked.sharepoint.com" }),
    });
    assert.equal(added.status, 200);
    assert.deepEqual((await added.json() as { deniedHosts: string[] }).deniedHosts, ["blocked.sharepoint.com"]);

    const rejectedOrigin = await fetch(`http://127.0.0.1:${port}/api/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ list: "deniedHosts", value: "evil.sharepoint.com" }),
    });
    assert.equal(rejectedOrigin.status, 403);

    // A missing Origin header must never be treated as implicitly
    // same-origin — this is the actual CSRF defense for an unauthenticated
    // loopback server, and it must fail closed, not open.
    const missingOrigin = await fetch(`http://127.0.0.1:${port}/api/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ list: "deniedHosts", value: "no-origin.sharepoint.com" }),
    });
    assert.equal(missingOrigin.status, 403);

    // The `localhost` alias must not be accepted either — only the literal
    // http://127.0.0.1:<port> origin, matching the literal 127.0.0.1 bind.
    const localhostOrigin = await fetch(`http://127.0.0.1:${port}/api/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://localhost:${port}` },
      body: JSON.stringify({ list: "deniedHosts", value: "localhost-origin.sharepoint.com" }),
    });
    assert.equal(localhostOrigin.status, 403);

    // A mutating settings request without a matching Origin must also be
    // rejected — the CSRF check is not limited to the /api/entries route.
    const rejectedSettings = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ writeEnabled: false }),
    });
    assert.equal(rejectedSettings.status, 403);

    const confirmUnchanged = await fetch(`http://127.0.0.1:${port}/api/policy`);
    const confirmedPolicy = (await confirmUnchanged.json()) as { deniedHosts: string[]; writeEnabled: boolean };
    assert.deepEqual(confirmedPolicy.deniedHosts, ["blocked.sharepoint.com"]);
    assert.equal(confirmedPolicy.writeEnabled, true);

    // Non-SharePoint hostnames must be rejected when adding to any host list.
    const rejectedHost = await fetch(`http://127.0.0.1:${port}/api/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ list: "allowedHosts", value: "evil.com" }),
    });
    assert.equal(rejectedHost.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousPolicy === undefined) delete process.env.M365_BRIDGE_POLICY_PATH;
    else process.env.M365_BRIDGE_POLICY_PATH = previousPolicy;
    if (previousPort === undefined) delete process.env.M365_BRIDGE_CONTROL_PORT;
    else process.env.M365_BRIDGE_CONTROL_PORT = previousPort;
    if (previousEnabled === undefined) delete process.env.M365_BRIDGE_CONTROL_PANEL;
    else process.env.M365_BRIDGE_CONTROL_PANEL = previousEnabled;
    if (fs.existsSync(policyPath)) fs.unlinkSync(policyPath);
    if (fs.existsSync(`${policyPath}.bak`)) fs.unlinkSync(`${policyPath}.bak`);
  }
});
