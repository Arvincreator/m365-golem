import { z } from "zod";

/**
 * ── Transport map ──────────────────────────────────────────────────────────
 * M365 Golem  <--stdio MCP-->  MCP Server
 * MCP Server      <--Named Pipe--> Native Host      (per-state channel, 127.0.0.1 never used)
 * Native Host     <--stdio Native Messaging-->  Extension service worker
 * Extension service worker <--chrome.tabs.sendMessage--> Content script (on the SharePoint tab)
 *
 * File BYTES only ever cross: local disk <-> Native Host <-> Extension <-> SharePoint.
 * They never traverse the Named Pipe leg, so file content never reaches the MCP
 * Server process or the M365 Golem tool-result channel — only paths/metadata do.
 */

export const IPC_PIPE_NAME = "\\\\.\\pipe\\m365-session-bridge";

function stableChannelSuffix(value: string): string {
  // FNV-1a is used only to create a deterministic, filesystem-safe channel
  // suffix. The IPC secret remains the authentication boundary.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Resolves the actual pipe name to use. Tests may provide an explicit pipe.
 * Installed copies provide an explicit shared secret path; deriving the pipe
 * suffix from that path keeps all processes for one installation together,
 * while preventing an older or standalone Bridge installation with a
 * different state directory from taking over the same channel.
 */
export function resolveIpcPipeName(): string {
  const explicit = process.env.M365_BRIDGE_PIPE_NAME?.trim();
  if (explicit) return explicit;

  const secretPath = process.env.M365_BRIDGE_SECRET_PATH?.trim();
  if (!secretPath) return IPC_PIPE_NAME;

  const normalizedPath = secretPath.replace(/\//g, "\\").toLocaleLowerCase("en-US");
  return `${IPC_PIPE_NAME}-${stableChannelSuffix(normalizedPath)}`;
}
/** Chrome/Edge native-messaging cap on a single host -> extension message. Must chunk above this. */
export const NATIVE_MSG_HOST_TO_EXT_MAX_BYTES = 1024 * 1024 - 4096; // headroom under 1MB for JSON/base64 overhead

// ---------------------------------------------------------------------------
// Named Pipe envelope: MCP Server <-> Native Host
// ---------------------------------------------------------------------------

/**
 * `PipeRequest.payload` shape per `op` (kept as z.record(unknown) above for
 * flexibility — this is the authoritative contract the MCP server producer
 * and the native-host consumer must both match):
 *
 *   status  : { siteUrl?: string }
 *   download: { siteUrl: string; serverRelativeUrl: string; destinationPath: string (pre-validated absolute path) }
 *   upload  : { localPath: string (pre-validated absolute path); siteUrl: string; folderServerRelativeUrl: string; fileName: string; overwrite: boolean }
 *   copy    : { siteUrl: string; sourceServerRelativeUrl: string; destServerRelativeUrl: string; overwrite: boolean }
 *   move    : { siteUrl: string; sourceServerRelativeUrl: string; destServerRelativeUrl: string; overwrite: boolean }
 *   rename  : { siteUrl: string; fileServerRelativeUrl: string; newLeafName: string }
 *   getUrl  : { siteUrl: string; serverRelativeUrl: string }
 *   recycle : { siteUrl: string; fileServerRelativeUrl: string }
 *   createFolder : { siteUrl: string; folderServerRelativeUrls: string[] (each level, outermost first) }
 *
 * v0.2 additions:
 *   listFolder        : { siteUrl: string; folderServerRelativeUrl: string; maxItems: number }
 *   renameFolder      : { siteUrl: string; folderServerRelativeUrl: string; newLeafName: string }
 *   recycleFolder     : { siteUrl: string; folderServerRelativeUrl: string }
 *   listFileVersions  : { siteUrl: string; fileServerRelativeUrl: string }
 *   restoreFileVersion: { siteUrl: string; fileServerRelativeUrl: string; versionLabel: string }
 *   checkoutFile      : { siteUrl: string; fileServerRelativeUrl: string }
 *   checkinFile       : { siteUrl: string; fileServerRelativeUrl: string; comment: string; checkInType: number (0|1|2) }
 *   discardCheckout   : { siteUrl: string; fileServerRelativeUrl: string }
 *   updateFileMetadata: { siteUrl: string; fileServerRelativeUrl: string; fields: Record<string, string|number|null> }
 *   requestApproval: { hostname: string; url: string; action: string; detail?: string }
 *     -> response result: { decision: "allow-once" | "allow-always" | "deny" }
 *
 * `PipeResponse.result` shape per op mirrors the MCP tool result shapes in
 * `tools.ts` (e.g. download -> { localPath, fileName, size, sha256 }).
 */
const PipeOpSchema = z.enum([
  "status",
  "download",
  "upload",
  "copy",
  "move",
  "rename",
  "getUrl",
  "recycle",
  "createFolder",
  "listFolder",
  "renameFolder",
  "recycleFolder",
  "listFileVersions",
  "restoreFileVersion",
  "checkoutFile",
  "checkinFile",
  "discardCheckout",
  "updateFileMetadata",
  "requestApproval",
]);

export const PipeRequestSchema = z.object({
  kind: z.literal("request"),
  id: z.string(),
  secret: z.string(),
  op: PipeOpSchema,
  payload: z.record(z.unknown()),
});
export type PipeRequest = z.infer<typeof PipeRequestSchema>;

/** Local-only handshake used to distinguish the Edge native host from a second MCP process. */
export const PipeHelloSchema = z.object({
  kind: z.literal("hello"),
  role: z.enum(["native-host", "mcp-proxy"]),
});
export type PipeHello = z.infer<typeof PipeHelloSchema>;

/** A later MCP process forwards its tool requests through the process that owns the pipe. */
export const PipeProxyRequestSchema = z.object({
  kind: z.literal("proxy-request"),
  id: z.string(),
  secret: z.string(),
  op: PipeOpSchema,
  payload: z.record(z.unknown()),
});
export type PipeProxyRequest = z.infer<typeof PipeProxyRequestSchema>;

export const PipeResponseSchema = z.object({
  kind: z.literal("response"),
  id: z.string(),
  ok: z.boolean(),
  result: z.record(z.unknown()).optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type PipeResponse = z.infer<typeof PipeResponseSchema>;

// ---------------------------------------------------------------------------
// Native Messaging envelope: Native Host <-> Extension service worker
// ---------------------------------------------------------------------------

/** Every native-messaging JSON message is prefixed by a 4-byte native-endian length (handled by transport, not here). */
export const NativeMessageSchema = z.object({
  v: z.literal(1),
  msgId: z.string(),
  /** For chunked transfers: same msgId across chunks, sequential index, final chunk sets `last: true`. */
  chunk: z
    .object({
      index: z.number().int().nonnegative(),
      last: z.boolean(),
    })
    .optional(),
  type: z.enum([
    "bridge-status",
    "sp-get-file",
    "sp-upload-file",
    "sp-copy",
    "sp-move",
    "sp-rename",
    "sp-get-url",
    "sp-recycle",
    "sp-create-folder",
    "sp-list-folder",
    "sp-rename-folder",
    "sp-recycle-folder",
    "sp-list-versions",
    "sp-restore-version",
    "sp-checkout",
    "sp-checkin",
    "sp-discard-checkout",
    "sp-update-metadata",
    "ack",
    "error",
  ]),
  payload: z.record(z.unknown()).optional(),
  /** base64-encoded binary chunk, present only on file-content-bearing messages. */
  dataBase64: z.string().optional(),
});
export type NativeMessage = z.infer<typeof NativeMessageSchema>;
