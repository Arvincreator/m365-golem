import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addPolicyEntry, removePolicyEntry } from "./policy-writer.js";

function validPolicy() {
  return {
    writeEnabled: true,
    readHostPatterns: ["*.sharepoint.com"],
    deniedHosts: [],
    deniedSites: [],
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

test("policy writer manages deny entries and local upload roots", () => {
  const policyPath = path.join(os.tmpdir(), `m365-bridge-writer-${process.pid}-${Date.now()}.json`);
  const previous = process.env.M365_BRIDGE_POLICY_PATH;
  fs.writeFileSync(policyPath, `${JSON.stringify(validPolicy(), null, 2)}\n`, "utf8");
  process.env.M365_BRIDGE_POLICY_PATH = policyPath;
  try {
    addPolicyEntry("deniedHosts", "blocked.sharepoint.com");
    removePolicyEntry("deniedHosts", "blocked.sharepoint.com");
    const localProject = path.join(os.tmpdir(), "m365-golem-project");
    addPolicyEntry("allowedLocalPaths", localProject);
    removePolicyEntry("allowedLocalPaths", localProject);
    const third = JSON.parse(fs.readFileSync(policyPath, "utf8")) as ReturnType<typeof validPolicy>;
    assert.deepEqual(third.deniedHosts, []);
    assert.deepEqual(third.allowedLocalPaths, ["%TEMP%\\m365"]);
    assert.ok(fs.existsSync(`${policyPath}.bak`));
  } finally {
    if (previous === undefined) delete process.env.M365_BRIDGE_POLICY_PATH;
    else process.env.M365_BRIDGE_POLICY_PATH = previous;
    for (const file of [policyPath, `${policyPath}.bak`]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});
