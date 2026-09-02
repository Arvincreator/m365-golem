import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addPolicyEntry, persistApprovedTarget, removePolicyEntry } from "./policy-writer.js";

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

test("persistApprovedTarget appends host/site, makes a backup, and deduplicates covered sites", () => {
  const policyPath = path.join(os.tmpdir(), `m365-bridge-writer-${process.pid}-${Date.now()}.json`);
  const previous = process.env.M365_BRIDGE_POLICY_PATH;
  fs.writeFileSync(policyPath, `${JSON.stringify(validPolicy(), null, 2)}\n`, "utf8");
  process.env.M365_BRIDGE_POLICY_PATH = policyPath;
  try {
    persistApprovedTarget("Other.SharePoint.com", "/sites/Ops");
    const first = JSON.parse(fs.readFileSync(policyPath, "utf8")) as ReturnType<typeof validPolicy>;
    assert.deepEqual(first.allowedHosts, ["tenant.sharepoint.com", "other.sharepoint.com"]);
    assert.deepEqual(first.allowedSites, ["/sites/TestSite", "/sites/Ops"]);
    assert.ok(fs.existsSync(`${policyPath}.bak`));

    persistApprovedTarget("other.sharepoint.com", "/sites/Ops/Shared Documents");
    const second = JSON.parse(fs.readFileSync(policyPath, "utf8")) as ReturnType<typeof validPolicy>;
    assert.deepEqual(second.allowedHosts, ["tenant.sharepoint.com", "other.sharepoint.com"]);
    assert.deepEqual(second.allowedSites, ["/sites/TestSite", "/sites/Ops"]);

    addPolicyEntry("deniedHosts", "blocked.sharepoint.com");
    removePolicyEntry("deniedHosts", "blocked.sharepoint.com");
    const third = JSON.parse(fs.readFileSync(policyPath, "utf8")) as ReturnType<typeof validPolicy>;
    assert.deepEqual(third.deniedHosts, []);
  } finally {
    if (previous === undefined) delete process.env.M365_BRIDGE_POLICY_PATH;
    else process.env.M365_BRIDGE_POLICY_PATH = previous;
    for (const file of [policyPath, `${policyPath}.bak`]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});
