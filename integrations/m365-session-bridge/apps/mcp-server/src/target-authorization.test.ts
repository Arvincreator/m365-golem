import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeError, ErrorCode, type Policy, type PipeRequest, type PipeResponse } from "@m365-bridge/protocol";
import {
  authorizeSharePointTarget,
  type ApprovalTransport,
} from "./target-authorization.js";

function policy(overrides: Partial<Policy> = {}): Policy {
  const { deniedHosts, deniedSites, ...rest } = overrides;
  return {
    writeEnabled: true,
    readHostPatterns: ["*.sharepoint.com", "*.sharepoint.us", "*.sharepoint-mil.us", "*.sharepoint.de", "*.sharepoint.cn"],
    allowedLocalPaths: ["C:\\Temp\\m365"],
    allowOverwrite: false,
    allowRecycle: true,
    allowPermanentDelete: false,
    allowExternalSharing: false,
    allowPermissionChange: false,
    allowBulkDelete: false,
    allowArbitraryHttp: false,
    denylistExtensions: [],
    ...rest,
    deniedHosts: deniedHosts ?? [],
    deniedSites: deniedSites ?? [],
  };
}

class MockTransport implements ApprovalTransport {
  calls: Array<{ op: PipeRequest["op"]; payload: Record<string, unknown>; timeoutMs?: number }> = [];
  constructor(private readonly response: PipeResponse | Error) {}

  async sendRequest(op: PipeRequest["op"], payload: Record<string, unknown>, timeoutMs?: number): Promise<PipeResponse> {
    this.calls.push({ op, payload, timeoutMs });
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

function approvalResponse(decision: "allow-once" | "allow-always" | "deny"): PipeResponse {
  return { kind: "response", id: "approval", ok: true, result: { decision } };
}

test("supported target is allowed by default and never opens the approval transport", async () => {
  const transport = new MockTransport(approvalResponse("deny"));
  const result = await authorizeSharePointTarget(
    "https://tenant.sharepoint.com/sites/TestSite/Shared%20Documents/a.txt",
    policy(),
    transport,
    "Download file"
  );
  assert.equal(result.siteUrl, "https://tenant.sharepoint.com/sites/TestSite");
  assert.equal(transport.calls.length, 0);
});

test("unsupported domain is hard-blocked without opening an approval dialog", async () => {
  const transport = new MockTransport(approvalResponse("allow-always"));
  await assert.rejects(
    authorizeSharePointTarget("https://example.com/sites/Ops/a.txt", policy(), transport, "Download file"),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.HOST_NOT_ALLOWED
  );
  assert.equal(transport.calls.length, 0);
});

test("explicitly denied supported target is blocked without opening an approval dialog", async () => {
  const transport = new MockTransport(approvalResponse("allow-always"));
  await assert.rejects(
    authorizeSharePointTarget(
      "https://tenant.sharepoint.com/sites/TestSite/Shared%20Documents/a.txt",
      policy({ deniedSites: ["/sites/TestSite"] }),
      transport,
      "Download file"
    ),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.FORBIDDEN_BY_POLICY
  );
  assert.equal(transport.calls.length, 0);
});

test("another supported tenant is allowed without approval or persistence", async () => {
  const transport = new MockTransport(approvalResponse("deny"));
  const result = await authorizeSharePointTarget(
    "https://other.sharepoint.com/sites/Ops/Shared%20Documents/a.txt",
    policy(),
    transport,
    "Download file",
    "test"
  );
  assert.equal(result.siteUrl, "https://other.sharepoint.com/sites/Ops");
  assert.equal(transport.calls.length, 0);
});
