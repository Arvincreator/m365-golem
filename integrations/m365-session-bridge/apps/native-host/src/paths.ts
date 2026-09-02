import * as path from "node:path";

// apps/native-host/dist/paths.js -> repo root is three levels up.
const repoRoot = path.resolve(__dirname, "..", "..", "..");

/**
 * Must resolve to the EXACT same absolute path as apps/mcp-server's
 * defaultSecretPath() — see packages/protocol/src/secret.ts for why this is
 * repo-relative rather than %LOCALAPPDATA%-based (packaged-app folder
 * virtualization silently broke that).
 */
export function defaultSecretPath(): string {
  return process.env.M365_BRIDGE_SECRET_PATH ?? path.join(repoRoot, "runtime", "ipc-secret.json");
}
