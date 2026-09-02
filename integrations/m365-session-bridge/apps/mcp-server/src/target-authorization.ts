import {
  BridgeError,
  ErrorCode,
  type PipeRequest,
  type PipeResponse,
  type Policy,
} from "@m365-bridge/protocol";
import {
  assertAllowedLibrary,
  computeApprovedTarget,
  inferSiteCollectionPath,
  isSharePointOnlineHost,
  isTargetDenied,
  parseHttpsUrl,
  type ValidatedSharePointUrl,
  validateHostAndSite,
} from "@m365-bridge/policy";
import { newRequestId, type AuditEvent, type AuditLogger } from "@m365-bridge/audit";
import { persistApprovedTarget } from "./policy-writer.js";

export interface ApprovalTransport {
  sendRequest(op: PipeRequest["op"], payload: Record<string, unknown>, timeoutMs?: number): Promise<PipeResponse>;
}

export interface TargetAuthorizationOptions {
  session?: Set<string>;
  audit?: AuditLogger;
  persist?: typeof persistApprovedTarget;
  approvalTimeoutMs?: number;
}

function targetKey(hostname: string, sitePath: string): string {
  return `${hostname.toLowerCase().replace(/\.$/, "")}|${sitePath.toLowerCase()}`;
}

async function appendApprovalAudit(
  audit: AuditLogger | undefined,
  urlStr: string,
  decision: "allow-once" | "allow-always" | "deny"
): Promise<void> {
  if (!audit) return;
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    operation: "policy-approval",
    target: urlStr,
    source: null,
    destination: null,
    fileName: null,
    size: null,
    result: decision === "deny" ? "error" : "success",
    duration: 0,
    requestId: newRequestId(),
    errorCode: decision === "deny" ? ErrorCode.FORBIDDEN_BY_POLICY : null,
  };
  try {
    await audit.append(event);
  } catch (err) {
    console.error(`[m365-bridge] failed to append approval audit event: ${String(err)}`);
  }
}

function deny(hostname: string): never {
  throw new BridgeError(ErrorCode.FORBIDDEN_BY_POLICY, `User denied access to ${hostname}`);
}

function isApprovalDecision(value: unknown): value is "allow-once" | "allow-always" | "deny" {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

/**
 * Authorizes a SharePoint/OneDrive target for either a read or a write tool.
 * Exact allowlist matches stay a synchronous fast path. A supported but
 * unlisted target must pass the native human approval dialog; every other
 * domain remains a hard block and never reaches the dialog.
 */
export async function authorizeSharePointTarget(
  urlStr: string,
  policy: Policy,
  nativeHost: ApprovalTransport,
  action: string,
  detail?: string,
  options: TargetAuthorizationOptions = {}
): Promise<ValidatedSharePointUrl> {
  try {
    return validateHostAndSite(urlStr, policy);
  } catch (err) {
    if (!(err instanceof BridgeError)) throw err;
    if (err.code !== ErrorCode.HOST_NOT_ALLOWED && err.code !== ErrorCode.SITE_NOT_ALLOWED) throw err;

    // Keep malformed URLs, explicit deny entries, and non-SharePoint domains
    // on the original fail-closed path. The approval dialog is never a generic
    // URL confirmation bypass.
    const parsed = parseHttpsUrl(urlStr);
    if (!isSharePointOnlineHost(parsed.hostname)) throw err;

    const approvedTarget = computeApprovedTarget(urlStr);
    const sitePath = inferSiteCollectionPath(approvedTarget.serverRelativeUrl);
    if (isTargetDenied(parsed.hostname, approvedTarget.serverRelativeUrl, policy)) {
      throw new BridgeError(ErrorCode.FORBIDDEN_BY_POLICY, `Target is denied by policy: ${parsed.hostname}${approvedTarget.serverRelativeUrl}`);
    }

    // An explicit library restriction is still authoritative. Human approval
    // can authorize an unknown site, but it cannot widen a configured library
    // restriction.
    try {
      assertAllowedLibrary(approvedTarget.serverRelativeUrl, sitePath, policy);
    } catch (libraryErr) {
      if (libraryErr instanceof BridgeError && libraryErr.code === ErrorCode.SITE_NOT_ALLOWED) throw err;
      throw libraryErr;
    }

    const key = targetKey(parsed.hostname, sitePath);
    if (options.session?.has(key)) return approvedTarget;

    let decision: "allow-once" | "allow-always" | "deny" = "deny";
    try {
      const reply = await nativeHost.sendRequest(
        "requestApproval",
        { hostname: parsed.hostname, url: urlStr, action, detail },
        options.approvalTimeoutMs ?? 95_000
      );
      const candidate = reply.ok && reply.result ? reply.result.decision : undefined;
      if (isApprovalDecision(candidate)) decision = candidate;
    } catch {
      decision = "deny";
    }

    await appendApprovalAudit(options.audit, urlStr, decision);
    if (decision === "deny") deny(parsed.hostname);

    if (decision === "allow-always") {
      try {
        (options.persist ?? persistApprovedTarget)(parsed.hostname, sitePath);
      } catch (err) {
        // The human already approved this exact target through the native
        // dialog; a policy.json write failure (disk full, permissions, a
        // concurrent editor, etc.) must not retroactively cancel that
        // already-approved current operation. Per the approval flow spec's
        // dialog contract, a persistence failure is logged loudly instead —
        // and because nothing was written to allowedHosts/allowedSites, the
        // same target is not durably allowed and will prompt again on the
        // next tool call rather than silently behaving as allow-always.
        console.error(
          `[m365-bridge] ALWAYS-ALLOW POLICY PERSIST FAILED for ${parsed.hostname}${sitePath} — the current operation is proceeding on the human's approval, but this host/site was NOT saved to policy.json and will prompt again next time: ${String(err)}`
        );
      }
    }
    options.session?.add(key);
    return approvedTarget;
  }
}

/** Backward-compatible name for call sites that only perform writes. */
export const authorizeWriteTarget = authorizeSharePointTarget;

export function createAuthorizationSession(): Set<string> {
  return new Set<string>();
}
