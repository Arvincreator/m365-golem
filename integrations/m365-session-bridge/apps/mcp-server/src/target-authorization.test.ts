import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeError, ErrorCode, type Policy, type PipeRequest, type PipeResponse } from "@m365-bridge/protocol";
import {
  authorizeSharePointTarget,
  createAuthorizationSession,
  type ApprovalTransport,
} from "./target-authorization.js";

function policy(overrides: Partial<Policy> = {}): Policy {
  const { deniedHosts, deniedSites, ...rest } = overrides;
  return {
    writeEnabled: true,
    readHostPatterns: ["*.sharepoint.com", "*.sharepoint.us", "*.sharepoint-mil.us", "*.sharepoint.de", "*.sharepoint.cn"],
    allowedHosts: ["tenant.sharepoint.com"],
    allowedSites: ["/sites/TestSite"],
    allowedLibraries: [],
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

test("allowlisted target is a fast path and never opens the approval transport", async () => {
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

test("allow-once approves an unlisted supported target without persisting it", async () => {
  const transport = new MockTransport(approvalResponse("allow-once"));
  let persisted = 0;
  const result = await authorizeSharePointTarget(
    "https://other.sharepoint.com/sites/Ops/Shared%20Documents/a.txt",
    policy(),
    transport,
    "Download file",
    "test",
    { persist: () => { persisted += 1; return policy(); } }
  );
  assert.equal(result.siteUrl, "https://other.sharepoint.com/sites/Ops");
  assert.equal(persisted, 0);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].op, "requestApproval");
  assert.equal(transport.calls[0].timeoutMs, 95_000);
});

test("allow-always persists the approved host and site", async () => {
  const transport = new MockTransport(approvalResponse("allow-always"));
  let persisted: [string, string] | null = null;
  await authorizeSharePointTarget(
    "https://other.sharepoint.com/sites/Ops/Shared%20Documents/a.txt",
    policy(),
    transport,
    "Upload file",
    undefined,
    {
      persist: (hostname, sitePath) => {
        persisted = [hostname, sitePath];
        return policy();
      },
    }
  );
  assert.deepEqual(persisted, ["other.sharepoint.com", "/sites/Ops"]);
});

test("allow-always fails open for the already-approved current operation when persistence fails, but does not silently become a durable allow", async () => {
  const transport = new MockTransport(approvalResponse("allow-always"));
  const session = createAuthorizationSession();
  let persistAttempts = 0;
  const originalConsoleError = console.error;
  const loggedLoudly: string[] = [];
  console.error = (...args: unknown[]) => { loggedLoudly.push(args.map(String).join(" ")); };
  try {
    const result = await authorizeSharePointTarget(
      "https://other.sharepoint.com/sites/Ops/Shared%20Documents/a.txt",
      policy(),
      transport,
      "Upload file",
      undefined,
      {
        session,
        persist: () => {
          persistAttempts += 1;
          throw new Error("read-only policy");
        },
      }
    );
    // The human already approved this exact target through the dialog: the
    // current operation must be allowed to proceed even though the
    // allow-always decision could not be written to policy.json.
    assert.equal(result.siteUrl, "https://other.sharepoint.com/sites/Ops");
    assert.equal(persistAttempts, 1);
    // The failure must be logged loudly, not swallowed silently.
    assert.ok(loggedLoudly.some((line) => line.includes("PERSIST FAILED")));
  } finally {
    console.error = originalConsoleError;
  }
  // The same target is held for the remainder of *this* tool-call session
  // (consistent with allow-once semantics), but was never durably persisted,
  // so a brand-new authorization session for a later tool call prompts again.
  assert.equal(session.size, 1);
  const freshSession = createAuthorizationSession();
  const secondAttempt = new MockTransport(approvalResponse("deny"));
  await assert.rejects(
    authorizeSharePointTarget(
      "https://other.sharepoint.com/sites/Ops/Shared%20Documents/a.txt",
      policy(),
      secondAttempt,
      "Upload file",
      undefined,
      { session: freshSession, persist: () => { throw new Error("still read-only"); } }
    ),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.FORBIDDEN_BY_POLICY
  );
  assert.equal(secondAttempt.calls.length, 1, "a fresh tool-call session must prompt again since nothing was persisted");
});

test("deny and timeout are both fail-closed", async () => {
  const denied = new MockTransport(approvalResponse("deny"));
  await assert.rejects(
    authorizeSharePointTarget("https://other.sharepoint.com/sites/Ops/a.txt", policy(), denied, "Move file"),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.FORBIDDEN_BY_POLICY
  );

  const timedOut = new MockTransport(new Error("timed out"));
  await assert.rejects(
    authorizeSharePointTarget("https://other.sharepoint.com/sites/Ops/a.txt", policy(), timedOut, "Move file"),
    (err: unknown) => err instanceof BridgeError && err.code === ErrorCode.FORBIDDEN_BY_POLICY
  );
});

test("allow-once is reused only inside the current authorization session", async () => {
  const transport = new MockTransport(approvalResponse("allow-once"));
  const session = createAuthorizationSession();
  const firstUrl = "https://other.sharepoint.com/sites/Ops/Shared%20Documents/a.txt";
  const secondUrl = "https://other.sharepoint.com/sites/Ops/Shared%20Documents/b.txt";
  await authorizeSharePointTarget(firstUrl, policy(), transport, "Copy file", undefined, { session });
  await authorizeSharePointTarget(secondUrl, policy(), transport, "Copy file", undefined, { session });
  assert.equal(transport.calls.length, 1);
});
