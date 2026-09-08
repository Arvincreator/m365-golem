import { type PipeRequest, type PipeResponse, type Policy } from "@m365-bridge/protocol";
import { type ValidatedSharePointUrl, validateHostAndSite } from "@m365-bridge/policy";
import { type AuditLogger } from "@m365-bridge/audit";

export interface ApprovalTransport {
  sendRequest(op: PipeRequest["op"], payload: Record<string, unknown>, timeoutMs?: number): Promise<PipeResponse>;
}

export interface TargetAuthorizationOptions {
  session?: Set<string>;
  audit?: AuditLogger;
  approvalTimeoutMs?: number;
}

/**
 * Authorizes a SharePoint/OneDrive target for either a read or a write tool.
 * Supported Microsoft SharePoint Online targets are accepted by default;
 * explicit host/site deny entries always win. Microsoft 365 still decides
 * whether the signed-in user can access the target. Write/destructive gates
 * are enforced separately by each tool.
 */
export async function authorizeSharePointTarget(
  urlStr: string,
  policy: Policy,
  _nativeHost: ApprovalTransport,
  _action: string,
  _detail?: string,
  _options: TargetAuthorizationOptions = {}
): Promise<ValidatedSharePointUrl> {
  return validateHostAndSite(urlStr, policy);
}

/** Backward-compatible name for call sites that only perform writes. */
export const authorizeWriteTarget = authorizeSharePointTarget;

export function createAuthorizationSession(): Set<string> {
  return new Set<string>();
}
