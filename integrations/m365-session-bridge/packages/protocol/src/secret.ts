import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * Shared by the MCP Server (writer) and Native Host (reader): a fresh random
 * secret written on every MCP Server startup. Every PipeRequest must carry a
 * matching secret or the native host rejects it — this is the local IPC
 * channel's only authentication, so both sides must agree on this exact path.
 *
 * IMPORTANT: this deliberately does NOT resolve a path itself (e.g. via
 * %LOCALAPPDATA%) — the caller must pass an explicit absolute path. This was
 * a real bug: when the MCP Server runs as a child of a packaged (MSIX) app
 * like a sandboxed desktop MCP host, Windows may virtualize that process's view of
 * %LOCALAPPDATA% to a package-specific folder
 * (...\AppData\Local\Packages\<PackageFamilyName>\LocalCache\Local\...),
 * while the Native Host (spawned separately, unpackaged, by Edge) sees the
 * real path — so the two processes' "same" LOCALAPPDATA-based path silently
 * pointed at two different files on disk, and the native host could never
 * read a secret the MCP Server had genuinely written. Both callers now
 * compute a path relative to the repo root instead (see each app's own path
 * helper), which isn't subject to per-package folder virtualization.
 */
export function readSecret(filePath: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { secret?: string };
    return typeof raw.secret === "string" ? raw.secret : null;
  } catch {
    return null;
  }
}

export function writeFreshSecret(filePath: string): string {
  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ secret }), { mode: 0o600 });
  return secret;
}
