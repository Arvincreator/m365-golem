import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Diagnostic-only file logger. Edge spawns this process with no visible
 * console, so this is the only way to see what's actually happening during
 * connection attempts. Logs operation names, error codes, and byte counts
 * only — never cookies, tokens, digests, or the IPC secret itself (see
 * spec section 23).
 */
const LOG_PATH = process.env.M365_BRIDGE_NATIVE_LOG_PATH
  ?? path.join(process.env.LOCALAPPDATA ?? "", "M365-Golem", "m365-session-bridge", "logs", "native-host.log");

let ready = false;
function ensureReady(): void {
  if (ready) return;
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  ready = true;
}

export function log(message: string): void {
  try {
    ensureReady();
    const line = `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`;
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // Diagnostic logging must never crash the process it's diagnosing.
  }
}
