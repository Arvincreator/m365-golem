import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "@m365-bridge/policy";
import type { Policy } from "@m365-bridge/protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/mcp-server/dist/policy-store.js -> repo root is three levels up.
const repoRoot = path.resolve(here, "..", "..", "..");

export function defaultPolicyPath(): string {
  return process.env.M365_BRIDGE_POLICY_PATH ?? path.join(repoRoot, "config", "policy.json");
}

export function defaultLogPath(): string {
  return process.env.M365_BRIDGE_LOG_PATH ?? path.join(repoRoot, "logs", "actions.jsonl");
}

/**
 * Repo-relative, NOT %LOCALAPPDATA%-based — see the comment in
 * packages/protocol/src/secret.ts for why: a packaged (MSIX) parent app like
 * Some sandboxed desktop hosts virtualize child processes' view of LOCALAPPDATA to a
 * package-private folder, which silently broke this exact file when it lived
 * there. apps/native-host's equivalent path helper must compute the same
 * absolute path independently (both resolve repo root the same way).
 */
export function defaultSecretPath(): string {
  return process.env.M365_BRIDGE_SECRET_PATH ?? path.join(repoRoot, "runtime", "ipc-secret.json");
}

/** Reloaded on every call (cheap — small JSON file) so a policy.json edit takes effect without restarting the server. */
export function getPolicy(): Policy {
  return loadPolicy(defaultPolicyPath());
}
