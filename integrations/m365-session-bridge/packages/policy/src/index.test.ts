import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { BridgeError, ErrorCode, type Policy } from "@m365-bridge/protocol";
import {
  loadPolicy,
  resolveAllowedLocalPath,
  validateReadableHostAndSite,
  validateHostAndSite,
  computeApprovedTarget,
  isTargetDenied,
  checkWriteEnabled,
  checkOverwrite,
  checkRecycleAllowed,
  checkConfirmationToken,
} from "./index.js";

function basePolicy(overrides: Partial<Policy> = {}): Policy {
  const { deniedHosts, deniedSites, ...rest } = overrides;
  return {
    writeEnabled: true,
    readHostPatterns: ["*.sharepoint.com", "*.sharepoint.us", "*.sharepoint-mil.us", "*.sharepoint.de", "*.sharepoint.cn"],
    allowedHosts: ["tenant.sharepoint.com"],
    allowedSites: ["/sites/TestSite"],
    allowedLibraries: [],
    allowedLocalPaths: [path.join(os.tmpdir(), "m365-bridge-test-root")],
    allowOverwrite: false,
    allowRecycle: true,
    allowPermanentDelete: false,
    allowExternalSharing: false,
    allowPermissionChange: false,
    allowBulkDelete: false,
    allowArbitraryHttp: false,
    denylistExtensions: [".exe"],
    ...rest,
    deniedHosts: deniedHosts ?? [],
    deniedSites: deniedSites ?? [],
  };
}

test("validateHostAndSite: allows a host+site in the allowlist", () => {
  const policy = basePolicy();
  const result = validateHostAndSite("https://tenant.sharepoint.com/sites/TestSite/Shared Documents/a.txt", policy);
  assert.equal(result.siteUrl, "https://tenant.sharepoint.com/sites/TestSite");
});

test("validateReadableHostAndSite: allows another SharePoint tenant without a write site allowlist", () => {
  const policy = basePolicy({ allowedSites: [] });
  const result = validateReadableHostAndSite(
    "https://other.sharepoint.com/sites/Ops/Shared%20Documents/report.xlsx",
    policy
  );
  assert.equal(result.siteUrl, "https://other.sharepoint.com/sites/Ops");
  assert.equal(result.serverRelativeUrl, "/sites/Ops/Shared Documents/report.xlsx");
});

test("validateReadableHostAndSite: derives a OneDrive personal site root", () => {
  const policy = basePolicy({ allowedSites: [] });
  const result = validateReadableHostAndSite(
    "https://other-my.sharepoint.com/personal/user_example_com/Documents/report.docx",
    policy
  );
  assert.equal(result.siteUrl, "https://other-my.sharepoint.com/personal/user_example_com");
  assert.equal(result.serverRelativeUrl, "/personal/user_example_com/Documents/report.docx");
});

test("validateReadableHostAndSite: normalizes common SharePoint sharing routes", () => {
  const policy = basePolicy({ allowedSites: [] });
  const result = validateReadableHostAndSite(
    "https://other.sharepoint.com/:x:/r/sites/Ops/Shared%20Documents/report.xlsx?d=abc",
    policy
  );
  assert.equal(result.siteUrl, "https://other.sharepoint.com/sites/Ops");
  assert.equal(result.serverRelativeUrl, "/sites/Ops/Shared Documents/report.xlsx");
});

test("validateReadableHostAndSite: rejects a non-SharePoint host and a hostname-confusion suffix", () => {
  const policy = basePolicy({ allowedSites: [] });
  assert.throws(
    () => validateReadableHostAndSite("https://example.com/sites/Ops/report.xlsx", policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.HOST_NOT_ALLOWED
  );
  assert.throws(
    () => validateReadableHostAndSite("https://other.sharepoint.com.evil.com/sites/Ops/report.xlsx", policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.HOST_NOT_ALLOWED
  );
});

test("validateHostAndSite: rejects a host not in the allowlist", () => {
  const policy = basePolicy();
  assert.throws(
    () => validateHostAndSite("https://other.sharepoint.com/sites/TestSite/a.txt", policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.HOST_NOT_ALLOWED
  );
});

test("validateHostAndSite: rejects a subdomain-confusion attack hostname", () => {
  const policy = basePolicy();
  assert.throws(
    () => validateHostAndSite("https://tenant.sharepoint.com.evil.com/sites/TestSite/a.txt", policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.HOST_NOT_ALLOWED
  );
  assert.throws(
    () => validateHostAndSite("https://evil.com/tenant.sharepoint.com/a.txt", policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.HOST_NOT_ALLOWED
  );
});

test("validateHostAndSite: rejects a site path not in allowedSites", () => {
  const policy = basePolicy();
  assert.throws(
    () => validateHostAndSite("https://tenant.sharepoint.com/sites/OtherSite/a.txt", policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.SITE_NOT_ALLOWED
  );
});

test("deny lists win over an otherwise valid allowlist entry", () => {
  const policy = basePolicy({ deniedHosts: ["tenant.sharepoint.com"] });
  assert.throws(
    () => validateHostAndSite("https://tenant.sharepoint.com/sites/TestSite/a.txt", policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.FORBIDDEN_BY_POLICY
  );

  const siteDenied = basePolicy({ deniedSites: ["/sites/TestSite"] });
  assert.throws(
    () => validateReadableHostAndSite("https://tenant.sharepoint.com/sites/TestSite/a.txt", siteDenied),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.FORBIDDEN_BY_POLICY
  );
});

test("computeApprovedTarget derives a safe target for an unlisted supported host", () => {
  const result = computeApprovedTarget("https://other.sharepoint.com/sites/Ops/Shared%20Documents/report.xlsx");
  assert.equal(result.siteUrl, "https://other.sharepoint.com/sites/Ops");
  assert.equal(result.serverRelativeUrl, "/sites/Ops/Shared Documents/report.xlsx");
  assert.equal(isTargetDenied("other.sharepoint.com", result.serverRelativeUrl, basePolicy()), false);
});

test("validateHostAndSite: empty allowedSites always rejects", () => {
  const policy = basePolicy({ allowedSites: [] });
  assert.throws(
    () => validateHostAndSite("https://tenant.sharepoint.com/sites/TestSite/a.txt", policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.SITE_NOT_ALLOWED
  );
});

test("validateHostAndSite: rejects non-https", () => {
  const policy = basePolicy();
  assert.throws(
    () => validateHostAndSite("http://tenant.sharepoint.com/sites/TestSite/a.txt", policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.INVALID_INPUT
  );
});

test("resolveAllowedLocalPath: allows a path inside allowedLocalPaths", () => {
  const policy = basePolicy();
  const root = path.join(os.tmpdir(), "m365-bridge-test-root");
  const p = resolveAllowedLocalPath(path.join(root, "sub", "file.txt"), policy);
  assert.ok(p.toLowerCase().startsWith(root.toLowerCase()));
});

test("resolveAllowedLocalPath: rejects a path outside allowedLocalPaths", () => {
  const policy = basePolicy();
  assert.throws(
    () => resolveAllowedLocalPath(path.join(os.tmpdir(), "some-other-dir", "file.txt"), policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.LOCAL_PATH_NOT_ALLOWED
  );
});

test("resolveAllowedLocalPath: rejects traversal that would escape the root", () => {
  const policy = basePolicy();
  const root = path.join(os.tmpdir(), "m365-bridge-test-root");
  const traversal = path.join(root, "..", "escaped.txt");
  assert.throws(
    () => resolveAllowedLocalPath(traversal, policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.LOCAL_PATH_NOT_ALLOWED
  );
});

test("resolveAllowedLocalPath: rejects a denylisted extension even inside an allowed root", () => {
  const policy = basePolicy();
  const root = path.join(os.tmpdir(), "m365-bridge-test-root");
  assert.throws(
    () => resolveAllowedLocalPath(path.join(root, "malware.exe"), policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.FORBIDDEN_BY_POLICY
  );
});

test("checkWriteEnabled: throws FORBIDDEN_BY_POLICY when writeEnabled is false", () => {
  const policy = basePolicy({ writeEnabled: false });
  assert.throws(
    () => checkWriteEnabled(policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.FORBIDDEN_BY_POLICY
  );
});

test("checkOverwrite: default (not requested) is a no-op", () => {
  const policy = basePolicy();
  assert.doesNotThrow(() => checkOverwrite(false, policy));
});

test("checkOverwrite: requested but policy disallows -> FORBIDDEN_BY_POLICY", () => {
  const policy = basePolicy({ allowOverwrite: false });
  assert.throws(
    () => checkOverwrite(true, policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.FORBIDDEN_BY_POLICY
  );
});

test("checkOverwrite: requested and policy allows -> ok", () => {
  const policy = basePolicy({ allowOverwrite: true });
  assert.doesNotThrow(() => checkOverwrite(true, policy));
});

test("checkRecycleAllowed: throws when allowRecycle is false", () => {
  const policy = basePolicy({ allowRecycle: false });
  assert.throws(
    () => checkRecycleAllowed(policy),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.FORBIDDEN_BY_POLICY
  );
});

test("checkConfirmationToken: mismatched or missing token -> NEEDS_USER_CONFIRMATION", () => {
  assert.throws(
    () => checkConfirmationToken(undefined, "CONFIRM_RECYCLE"),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.NEEDS_USER_CONFIRMATION
  );
  assert.throws(
    () => checkConfirmationToken("WRONG", "CONFIRM_RECYCLE"),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.NEEDS_USER_CONFIRMATION
  );
  assert.doesNotThrow(() => checkConfirmationToken("CONFIRM_RECYCLE", "CONFIRM_RECYCLE"));
});

test("loadPolicy: rejects a policy.json that tries to enable a locked-false field", () => {
  const tmpFile = path.join(os.tmpdir(), `m365-bridge-bad-policy-${Date.now()}.json`);
  const bad = { ...basePolicy(), allowPermanentDelete: true };
  fs.writeFileSync(tmpFile, JSON.stringify(bad));
  try {
    assert.throws(() => loadPolicy(tmpFile), (err: unknown) => err instanceof BridgeError);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test("loadPolicy: loads a valid policy.json", () => {
  const tmpFile = path.join(os.tmpdir(), `m365-bridge-good-policy-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(basePolicy()));
  try {
    const loaded = loadPolicy(tmpFile);
    assert.equal(loaded.allowedHosts[0], "tenant.sharepoint.com");
  } finally {
    fs.unlinkSync(tmpFile);
  }
});
