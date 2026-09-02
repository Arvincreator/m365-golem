#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  BridgeError,
  ErrorCode,
  CONFIRMATION_TOKEN,
  BridgeStatusInput,
  DownloadFileInput,
  UploadFileInput,
  CopyFileInput,
  MoveFileInput,
  RenameFileInput,
  GetFileUrlInput,
  RecycleFileInput,
  CreateFolderInput,
  CreateWordDocumentInput,
  CreateExcelWorkbookInput,
  CONFIRM_RECYCLE_FOLDER_TOKEN,
  CONFIRM_RESTORE_VERSION_TOKEN,
  CONFIRM_DISCARD_CHECKOUT_TOKEN,
  FORBIDDEN_METADATA_FIELDS,
  ListFolderInput,
  RenameFolderInput,
  RecycleFolderInput,
  ListFileVersionsInput,
  RestoreFileVersionInput,
  CheckOutFileInput,
  CheckInFileInput,
  DiscardCheckoutInput,
  UpdateFileMetadataInput,
} from "@m365-bridge/protocol";
import {
  resolveAllowedLocalPath,
  checkWriteEnabled,
  checkOverwrite,
  checkRecycleAllowed,
  checkConfirmationToken,
} from "@m365-bridge/policy";
import { fileExists } from "@m365-bridge/files";
import { AuditLogger, newRequestId, type AuditEvent } from "@m365-bridge/audit";
import { createWordDocument, createExcelWorkbook } from "@m365-bridge/documents";
import {
  splitExtension,
  validateLeafName,
  CHECK_IN_TYPE,
  CHECK_IN_COMMENT_MAX_LENGTH,
} from "@m365-bridge/sharepoint";
import { getPolicy, defaultLogPath } from "./policy-store.js";
import { NativeHostServer } from "./pipe-server.js";
import { authorizeSharePointTarget, createAuthorizationSession } from "./target-authorization.js";
import { startControlPanel } from "./control-panel.js";

// M365 Golem closes this process's stdin when it shuts down or restarts.
// The MCP SDK's stdio transport is expected to handle this, but defense in
// depth here: an orphaned MCP server process was observed staying alive
// indefinitely (holding the named pipe) after M365 Golem had already
// restarted, blocking a fresh instance from ever accepting connections.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

const BRIDGE_VERSION = "0.1.0";
const nativeHost = new NativeHostServer();
nativeHost.listen();
const audit = new AuditLogger(defaultLogPath());
startControlPanel();

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function toBridgeError(err: unknown): BridgeError {
  if (err instanceof BridgeError) return err;
  return new BridgeError(ErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
}

async function withAudit(
  operation: string,
  target: string,
  extra: Partial<Pick<AuditEvent, "source" | "destination">>,
  fn: () => Promise<Record<string, unknown>>
): Promise<ToolResult> {
  const requestId = newRequestId();
  const start = Date.now();
  try {
    const result = await fn();
    await audit.append({
      timestamp: new Date().toISOString(),
      operation,
      target,
      source: extra.source ?? null,
      destination: extra.destination ?? null,
      fileName: typeof result.fileName === "string" ? result.fileName : null,
      size: typeof result.size === "number" ? result.size : null,
      result: "success",
      duration: Date.now() - start,
      requestId,
      errorCode: null,
    });
    return { content: [{ type: "text", text: JSON.stringify({ status: "success", ...result }, null, 2) }] };
  } catch (err) {
    const be = toBridgeError(err);
    await audit.append({
      timestamp: new Date().toISOString(),
      operation,
      target,
      source: extra.source ?? null,
      destination: extra.destination ?? null,
      fileName: null,
      size: null,
      result: "error",
      duration: Date.now() - start,
      requestId,
      errorCode: be.code,
    });
    return { content: [{ type: "text", text: JSON.stringify(be.toToolResult(), null, 2) }], isError: true };
  }
}

function requireExtensionOnline(): void {
  if (!nativeHost.isNativeHostConnected()) {
    throw new BridgeError(ErrorCode.EDGE_EXTENSION_OFFLINE, "The Edge extension is not connected. Open Edge and ensure the M365 Session Bridge extension is loaded.");
  }
}

function throwIfPipeError(reply: { ok: boolean; errorCode?: string; errorMessage?: string }, fallback: ErrorCode): void {
  if (!reply.ok) {
    throw new BridgeError((reply.errorCode as ErrorCode) ?? fallback, reply.errorMessage ?? "Operation failed");
  }
}

function targetAuthorizer(policy: ReturnType<typeof getPolicy>) {
  const session = createAuthorizationSession();
  return (urlStr: string, action: string, detail?: string) =>
    authorizeSharePointTarget(urlStr, policy, nativeHost, action, detail, { session, audit });
}

const server = new McpServer({ name: "m365-session-bridge", version: BRIDGE_VERSION });

server.registerTool(
  "m365_bridge_status",
  {
    description:
       "Check whether the M365 Session Bridge is online: Edge extension connectivity, whether a Microsoft 365 session is available, the SharePoint/OneDrive host scope, and the current allow/deny policy. This tool does not search Microsoft 365 and never returns cookies, tokens, or request digests.",
    inputSchema: BridgeStatusInput.shape,
  },
  async () =>
    withAudit("m365_bridge_status", "-", {}, async () => {
      const policy = getPolicy();
      let extensionOnline = nativeHost.isNativeHostConnected();
      let m365SessionAvailable = false;
      let probeDetail: Record<string, unknown> = {};
      if (extensionOnline) {
        // Session detection must remain useful even before the owner has
        // explicitly authorized a target. Use an allowed host root only for
        // the read-only status probe; file operations use the deny-first
        // target authorizer and may open the native approval dialog.
        // A "/personal/..." site only resolves under the "-my" host, while a
        // "/sites/..." (or other) site belongs on the regular tenant host —
        // allowedHosts and allowedSites are separate arrays with no implicit
        // index pairing, so pick the host that actually matches the site
        // path's shape instead of always zipping allowedHosts[0].
        const firstSite = policy.allowedSites[0];
        const myHost = policy.allowedHosts.find((host) => host.endsWith("-my.sharepoint.com"));
        const tenantHost = policy.allowedHosts.find((host) => !host.endsWith("-my.sharepoint.com")) ?? policy.allowedHosts[0];
        const siteHost = firstSite?.startsWith("/personal/") ? myHost ?? policy.allowedHosts[0] : tenantHost;
        const siteUrl =
          firstSite && siteHost
            ? `https://${siteHost}${firstSite}`
            : (myHost ?? policy.allowedHosts[0])
              ? `https://${myHost ?? policy.allowedHosts[0]}`
              : undefined;
        const reply = await nativeHost.sendRequest("status", { siteUrl }, 15_000);
        type StatusResultShape = { extensionOnline?: boolean; reachable?: boolean; result?: { reachable?: boolean } };
        const result = reply.result as StatusResultShape | undefined;
        extensionOnline = Boolean(reply.ok && result?.extensionOnline);
        // Tolerate the pre-fix double-nested shape (result.result.reachable)
        // from an extension build older than the background.ts flattening
        // fix, so this doesn't silently regress for anyone still running an
        // unreloaded extension.
        m365SessionAvailable = Boolean(reply.ok && (result?.reachable ?? result?.result?.reachable));
        // Diagnostic-only fields (not a stable contract) to make failures
        // debuggable without digging into logs: which URL was probed, and
        // what the pipe/extension layer actually returned.
        probeDetail = {
          probedSiteUrl: siteUrl ?? null,
          replyOk: reply.ok,
          replyErrorCode: reply.errorCode ?? null,
          replyErrorMessage: reply.errorMessage ?? null,
          replyResult: reply.result ?? null,
        };
      }
      return {
        extensionOnline,
        m365SessionAvailable,
        tenantHost: policy.allowedHosts[0] ?? null,
        readHostPatterns: policy.readHostPatterns,
        bridgeVersion: BRIDGE_VERSION,
        writeMode: policy.writeEnabled,
        allowedHosts: policy.allowedHosts,
        allowedSites: policy.allowedSites,
        deniedHosts: policy.deniedHosts,
        deniedSites: policy.deniedSites,
        ...probeDetail,
      };
    })
);

server.registerTool(
  "m365_download_file",
  {
    description:
      "Download one Microsoft 365 SharePoint/OneDrive for Business file from any supported SharePoint Online host reachable by the user's existing authenticated Edge session, saving it to a local path under an allowed folder. Pass the exact file URL (for example, a URL returned by an M365 connector); this tool does not search Microsoft 365.",
    inputSchema: DownloadFileInput.shape,
  },
  async (args) =>
    withAudit("m365_download_file", args.fileUrl, { destination: args.destinationPath }, async () => {
      const policy = getPolicy();
      const destinationPath = resolveAllowedLocalPath(args.destinationPath, policy);
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.fileUrl, "Download file", `Save to: ${destinationPath}`);
      const reply = await nativeHost.sendRequest("download", { siteUrl, serverRelativeUrl, destinationPath }, 300_000);
      throwIfPipeError(reply, ErrorCode.DOWNLOAD_FAILED);
      return reply.result ?? {};
    })
);

server.registerTool(
  "m365_upload_file",
  {
    description:
      "Upload one local file to a SharePoint/OneDrive for Business folder using the user's existing Edge session. Defaults to overwrite:false and returns CONFLICT if a file with that name already exists — only pass overwrite:true after the user has explicitly agreed to replace the existing file in this conversation.",
    inputSchema: UploadFileInput.shape,
  },
  async (args) =>
    withAudit("m365_upload_file", args.destinationFolderUrl, { source: args.localPath, destination: args.fileName }, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);
      const localPath = resolveAllowedLocalPath(args.localPath, policy);
      if (!(await fileExists(localPath))) {
        throw new BridgeError(ErrorCode.NOT_FOUND, `Local file not found: ${localPath}`);
      }
      checkOverwrite(args.overwrite, policy);
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl: folderServerRelativeUrl } = await authorize(
        args.destinationFolderUrl,
        "Upload file",
        `File: ${args.fileName}`
      );
      const reply = await nativeHost.sendRequest(
        "upload",
        { localPath, siteUrl, folderServerRelativeUrl, fileName: args.fileName, overwrite: args.overwrite },
        300_000
      );
      throwIfPipeError(reply, ErrorCode.UPLOAD_FAILED);
      return reply.result ?? {};
    })
);

server.registerTool(
  "m365_copy_file",
  {
    description:
      "Copy one existing SharePoint/OneDrive for Business file to another folder (optionally renaming it), using the user's existing Edge session. Defaults to overwrite:false and returns CONFLICT if a file already exists at the destination.",
    inputSchema: CopyFileInput.shape,
  },
  async (args) =>
    withAudit("m365_copy_file", args.sourceFileUrl, { destination: args.destinationFolderUrl }, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);
      checkOverwrite(args.overwrite, policy);
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const source = await authorize(args.sourceFileUrl, "Copy file", `Destination: ${args.destinationFolderUrl}`);
      const destFolder = await authorize(args.destinationFolderUrl, "Copy file", `Source: ${args.sourceFileUrl}`);
      const leafName = args.newName ?? source.serverRelativeUrl.split("/").filter(Boolean).pop() ?? "file";
      const destServerRelativeUrl = `${destFolder.serverRelativeUrl.replace(/\/$/, "")}/${leafName}`;
      const reply = await nativeHost.sendRequest("copy", {
        siteUrl: source.siteUrl,
        sourceServerRelativeUrl: source.serverRelativeUrl,
        destServerRelativeUrl,
        overwrite: args.overwrite,
      });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return {
        destinationUrl: `${destFolder.siteUrl.split("/").slice(0, 3).join("/")}${destServerRelativeUrl}`,
        ...(reply.result ?? {}),
      };
    })
);

server.registerTool(
  "m365_move_file",
  {
    description:
      "Move one existing SharePoint/OneDrive for Business file to another folder (optionally renaming it), using the user's existing Edge session. This changes the file's location for anyone who has the old link — confirm with the user before moving a file others may depend on. Defaults to overwrite:false.",
    inputSchema: MoveFileInput.shape,
  },
  async (args) =>
    withAudit("m365_move_file", args.sourceFileUrl, { destination: args.destinationFolderUrl }, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);
      checkOverwrite(args.overwrite, policy);
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const source = await authorize(args.sourceFileUrl, "Move file", `Destination: ${args.destinationFolderUrl}`);
      const destFolder = await authorize(args.destinationFolderUrl, "Move file", `Source: ${args.sourceFileUrl}`);
      const leafName = args.newName ?? source.serverRelativeUrl.split("/").filter(Boolean).pop() ?? "file";
      const destServerRelativeUrl = `${destFolder.serverRelativeUrl.replace(/\/$/, "")}/${leafName}`;
      const reply = await nativeHost.sendRequest("move", {
        siteUrl: source.siteUrl,
        sourceServerRelativeUrl: source.serverRelativeUrl,
        destServerRelativeUrl,
        overwrite: args.overwrite,
      });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return {
        destinationUrl: `${destFolder.siteUrl.split("/").slice(0, 3).join("/")}${destServerRelativeUrl}`,
        ...(reply.result ?? {}),
      };
    })
);

server.registerTool(
  "m365_rename_file",
  {
    description:
      "Rename one existing SharePoint/OneDrive for Business file in place, using the user's existing Edge session. Refuses to change the file extension unless allowExtensionChange is explicitly set to true. Confirm with the user before renaming a file others may depend on.",
    inputSchema: RenameFileInput.shape,
  },
  async (args) =>
    withAudit("m365_rename_file", args.fileUrl, { destination: args.newName }, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.fileUrl, "Rename file", `New name: ${args.newName}`);
      const currentLeaf = serverRelativeUrl.split("/").filter(Boolean).pop() ?? "";
      const [, currentExt] = splitExtension(currentLeaf);
      const [, newExt] = splitExtension(args.newName);
      if (!args.allowExtensionChange && currentExt.toLowerCase() !== newExt.toLowerCase()) {
        throw new BridgeError(ErrorCode.FORBIDDEN_BY_POLICY, `Refusing to change file extension from '${currentExt}' to '${newExt}' without allowExtensionChange:true`);
      }
      const reply = await nativeHost.sendRequest("rename", { siteUrl, fileServerRelativeUrl: serverRelativeUrl, newLeafName: args.newName });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return {};
    })
);

server.registerTool(
  "m365_get_file_url",
  {
    description:
      "Get the canonical Microsoft 365 web URL for an existing SharePoint/OneDrive for Business file on any supported SharePoint Online host reachable by the user's existing Edge session. This is not a sharing link; v0.1 never creates or modifies sharing permissions.",
    inputSchema: GetFileUrlInput.shape,
  },
  async (args) =>
    withAudit("m365_get_file_url", args.fileUrl, {}, async () => {
      const policy = getPolicy();
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.fileUrl, "Get file URL");
      const reply = await nativeHost.sendRequest("getUrl", { siteUrl, serverRelativeUrl });
      throwIfPipeError(reply, ErrorCode.NOT_FOUND);
      return reply.result ?? {};
    })
);

server.registerTool(
  "m365_create_folder",
  {
    description:
      "Create a folder in a SharePoint/OneDrive for Business document library using the user's existing Edge session. folderName may be a single name or a relative path like \"2026/Q1\" to create several nested levels at once. Levels that already exist are left alone, so calling this twice is safe. Does not create files — use m365_upload_file for that.",
    inputSchema: CreateFolderInput.shape,
  },
  async (args) =>
    withAudit("m365_create_folder", args.parentFolderUrl, { destination: args.folderName }, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);

      // Split "2026/Q1" into its levels, validating each name the same way a
      // rename would. Rejecting "..", "/", etc. here means a crafted
      // folderName cannot walk outside the validated parent folder.
      const segments = args.folderName.split("/").filter((s) => s.length > 0);
      if (segments.length === 0) {
        throw new BridgeError(ErrorCode.INVALID_INPUT, "folderName is empty");
      }
      for (const segment of segments) {
        const check = validateLeafName(segment);
        if (!check.ok) {
          throw new BridgeError(ErrorCode.INVALID_INPUT, `Invalid folder name segment '${segment}': ${check.reason}`);
        }
      }

      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const parent = await authorize(args.parentFolderUrl, "Create folder", `Folder: ${args.folderName}`);

      // The folder name segments are validated above and are appended only to
      // the already-authorized parent, so the derived paths cannot escape the
      // approved site or library.
      const base = parent.serverRelativeUrl.replace(/\/$/, "");
      const folderServerRelativeUrls = segments.map((_, i) => `${base}/${segments.slice(0, i + 1).join("/")}`);
      const deepest = folderServerRelativeUrls[folderServerRelativeUrls.length - 1];

      const reply = await nativeHost.sendRequest("createFolder", {
        siteUrl: parent.siteUrl,
        folderServerRelativeUrls,
      });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return {
        folderUrl: `${new URL(args.parentFolderUrl).origin}${deepest}`,
        ...(reply.result ?? {}),
      };
    })
);

server.registerTool(
  "m365_recycle_file",
  {
    description: `Send one existing SharePoint/OneDrive for Business file to the site's Recycle Bin (never a permanent delete) using the user's existing Edge session. Requires the caller to pass confirmation:"${CONFIRMATION_TOKEN}" — ask the user to confirm before calling this tool, then pass that exact confirmation string.`,
    inputSchema: RecycleFileInput.shape,
  },
  async (args) =>
    withAudit("m365_recycle_file", args.fileUrl, {}, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);
      checkRecycleAllowed(policy);
      checkConfirmationToken(args.confirmation, CONFIRMATION_TOKEN);
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.fileUrl, "Recycle file");
      const reply = await nativeHost.sendRequest("recycle", { siteUrl, fileServerRelativeUrl: serverRelativeUrl });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return {};
    })
);

// ===========================================================================
// v0.2 capabilities
// ===========================================================================

server.registerTool(
  "m365_list_folder",
  {
    description:
      "List the files and sub-folders directly inside one SharePoint/OneDrive for Business folder, using the user's existing Edge session. Read-only: it never creates, moves, or deletes anything. Returns each file's name, server-relative URL, size and last-modified time, plus sub-folder names. This is not a search tool — it lists exactly one folder, non-recursively. If truncated is true, more items exist than maxItems returned.",
    inputSchema: ListFolderInput.shape,
  },
  async (args) =>
    withAudit("m365_list_folder", args.folderUrl, {}, async () => {
      const policy = getPolicy();
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.folderUrl, "List folder");
      const reply = await nativeHost.sendRequest("listFolder", {
        siteUrl,
        folderServerRelativeUrl: serverRelativeUrl,
        maxItems: args.maxItems,
      });
      throwIfPipeError(reply, ErrorCode.NOT_FOUND);
      return { folderUrl: args.folderUrl, ...(reply.result ?? {}) };
    })
);

server.registerTool(
  "m365_rename_folder",
  {
    description:
      "Rename one existing SharePoint/OneDrive for Business folder in place, using the user's existing Edge session. Everything inside the folder stays where it is, but the folder's URL changes, so any existing links pointing into it will break — confirm with the user before renaming a folder others may depend on. Returns CONFLICT if a folder with the new name already exists alongside it.",
    inputSchema: RenameFolderInput.shape,
  },
  async (args) =>
    withAudit("m365_rename_folder", args.folderUrl, { destination: args.newName }, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);
      // validateLeafName already rejects "/" (and "\", "..", reserved names),
      // so a crafted newName cannot turn a rename into a move.
      const check = validateLeafName(args.newName);
      if (!check.ok) {
          throw new BridgeError(ErrorCode.INVALID_INPUT, `Invalid folder name '${args.newName}': ${check.reason}`);
      }
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.folderUrl, "Rename folder", `New name: ${args.newName}`);
      const reply = await nativeHost.sendRequest("renameFolder", {
        siteUrl,
        folderServerRelativeUrl: serverRelativeUrl,
        newLeafName: args.newName,
      });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return {};
    })
);

server.registerTool(
  "m365_recycle_folder",
  {
    description: `Send one SharePoint/OneDrive for Business folder to the site's Recycle Bin. WARNING: this recycles the folder AND EVERY FILE AND SUB-FOLDER INSIDE IT, recursively — not just the folder itself. This is the most destructive action this bridge can perform. Always show the user what the folder contains (use m365_list_folder first) and get an explicit yes before calling this. Items go to the Recycle Bin and are never permanently deleted. Requires the caller to pass confirmation:"${CONFIRM_RECYCLE_FOLDER_TOKEN}" — this token is specific to folder recycling and is deliberately different from the single-file recycle token.`,
    inputSchema: RecycleFolderInput.shape,
  },
  async (args) =>
    withAudit("m365_recycle_folder", args.folderUrl, {}, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);
      checkRecycleAllowed(policy);
      checkConfirmationToken(args.confirmation, CONFIRM_RECYCLE_FOLDER_TOKEN);
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.folderUrl, "Recycle folder");
      const reply = await nativeHost.sendRequest("recycleFolder", {
        siteUrl,
        folderServerRelativeUrl: serverRelativeUrl,
      });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return {};
    })
);

server.registerTool(
  "m365_list_file_versions",
  {
    description:
      "List the version history of one SharePoint/OneDrive for Business file, using the user's existing Edge session. Read-only. Returns each version's label (for example \"1.0\", \"2.3\"), creation time, author display name, size and check-in comment. Use the versionLabel from this list with m365_restore_file_version. Deleting versions is not supported by this bridge.",
    inputSchema: ListFileVersionsInput.shape,
  },
  async (args) =>
    withAudit("m365_list_file_versions", args.fileUrl, {}, async () => {
      const policy = getPolicy();
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.fileUrl, "List file versions");
      const reply = await nativeHost.sendRequest("listFileVersions", { siteUrl, fileServerRelativeUrl: serverRelativeUrl });
      throwIfPipeError(reply, ErrorCode.NOT_FOUND);
      return reply.result ?? {};
    })
);

server.registerTool(
  "m365_restore_file_version",
  {
    description: `Restore one earlier version of a SharePoint/OneDrive for Business file, making it the current version. This does not discard history: SharePoint records the restore as a NEW version, so the version you are replacing remains in the version list and can itself be restored later. It does change what anyone opening the file now sees, so confirm with the user first. Get valid version labels from m365_list_file_versions. Requires confirmation:"${CONFIRM_RESTORE_VERSION_TOKEN}".`,
    inputSchema: RestoreFileVersionInput.shape,
  },
  async (args) =>
    withAudit("m365_restore_file_version", args.fileUrl, { destination: args.versionLabel }, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);
      checkConfirmationToken(args.confirmation, CONFIRM_RESTORE_VERSION_TOKEN);
      if (!args.versionLabel.trim()) {
        throw new BridgeError(ErrorCode.INVALID_INPUT, "versionLabel is empty");
      }
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.fileUrl, "Restore file version", `Version: ${args.versionLabel}`);
      const reply = await nativeHost.sendRequest("restoreFileVersion", {
        siteUrl,
        fileServerRelativeUrl: serverRelativeUrl,
        versionLabel: args.versionLabel,
      });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return { versionLabel: args.versionLabel };
    })
);

server.registerTool(
  "m365_checkout_file",
  {
    description:
      "Check out one SharePoint/OneDrive for Business file, using the user's existing Edge session. While checked out to the user, other people cannot edit the file and do not see the user's changes until it is checked back in with m365_checkin_file. Leaving a file checked out blocks colleagues, so pair every check-out with a check-in.",
    inputSchema: CheckOutFileInput.shape,
  },
  async (args) =>
    withAudit("m365_checkout_file", args.fileUrl, {}, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.fileUrl, "Check out file");
      const reply = await nativeHost.sendRequest("checkoutFile", { siteUrl, fileServerRelativeUrl: serverRelativeUrl });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return {};
    })
);

server.registerTool(
  "m365_checkin_file",
  {
    description:
      "Check in one SharePoint/OneDrive for Business file that is currently checked out, publishing the pending changes so colleagues can see and edit it again. checkInType \"minor\" creates a draft version (0.x), \"major\" (the default) publishes a full version (x.0), and \"overwrite\" replaces the current version instead of creating a new one. The optional comment is stored in the file's version history and must be 1023 characters or fewer.",
    inputSchema: CheckInFileInput.shape,
  },
  async (args) =>
    withAudit("m365_checkin_file", args.fileUrl, {}, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);
      // Rejected locally rather than letting SharePoint fail the call, so the
      // user gets a precise reason instead of a raw server error.
      if (args.comment.length > CHECK_IN_COMMENT_MAX_LENGTH) {
        throw new BridgeError(
          ErrorCode.INVALID_INPUT,
          `Check-in comment is ${args.comment.length} characters; SharePoint allows at most ${CHECK_IN_COMMENT_MAX_LENGTH}.`
        );
      }
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.fileUrl, "Check in file", `Type: ${args.checkInType}`);
      // The human-facing string is mapped to SharePoint's int here, so the
      // wire protocol below this point stays numeric.
      const reply = await nativeHost.sendRequest("checkinFile", {
        siteUrl,
        fileServerRelativeUrl: serverRelativeUrl,
        comment: args.comment,
        checkInType: CHECK_IN_TYPE[args.checkInType],
      });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return { checkInType: args.checkInType };
    })
);

server.registerTool(
  "m365_discard_checkout",
  {
    description: `Discard the check-out of one SharePoint/OneDrive for Business file. WARNING: this THROWS AWAY every change made since the file was checked out — those edits are not saved anywhere and cannot be recovered, and the file reverts to the last checked-in version. If the user wants to keep the changes, use m365_checkin_file instead. Requires confirmation:"${CONFIRM_DISCARD_CHECKOUT_TOKEN}".`,
    inputSchema: DiscardCheckoutInput.shape,
  },
  async (args) =>
    withAudit("m365_discard_checkout", args.fileUrl, {}, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);
      checkConfirmationToken(args.confirmation, CONFIRM_DISCARD_CHECKOUT_TOKEN);
      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.fileUrl, "Discard file check-out");
      const reply = await nativeHost.sendRequest("discardCheckout", { siteUrl, fileServerRelativeUrl: serverRelativeUrl });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return {};
    })
);

/** Case-insensitive so a "fileref" spelling cannot slip past the allowlist. */
const FORBIDDEN_METADATA_FIELDS_LOWER = new Set(FORBIDDEN_METADATA_FIELDS.map((f) => f.toLowerCase()));

server.registerTool(
  "m365_update_file_metadata",
  {
    description:
      "Update SharePoint column values (metadata) on one existing SharePoint/OneDrive for Business file — for example Title, a status choice, a number, or a date stored as text. Only simple text, number and null values are accepted; lookup, person and managed-metadata columns are not supported. Identity, permission and path columns (including FileLeafRef, FileRef, Author, Editor, ContentTypeId) are refused: this tool can never move, rename or re-permission a file. To rename a file use m365_rename_file; to move it use m365_move_file.",
    inputSchema: UpdateFileMetadataInput.shape,
  },
  async (args) =>
    withAudit("m365_update_file_metadata", args.fileUrl, {}, async () => {
      const policy = getPolicy();
      checkWriteEnabled(policy);

      const entries = Object.entries(args.fields);
      if (entries.length === 0) {
        throw new BridgeError(ErrorCode.INVALID_INPUT, "fields is empty — nothing to update");
      }

      // Policy first, before anything reaches the network.
      for (const [name] of entries) {
        if (FORBIDDEN_METADATA_FIELDS_LOWER.has(name.toLowerCase())) {
          throw new BridgeError(
            ErrorCode.FORBIDDEN_BY_POLICY,
            `Field '${name}' is an identity/permission/path field and cannot be changed through m365_update_file_metadata. Forbidden fields: ${FORBIDDEN_METADATA_FIELDS.join(", ")}.`
          );
        }
      }
      const fields: Record<string, string | number | null> = {};
      for (const [name, value] of entries) {
        if (value !== null && typeof value !== "string" && typeof value !== "number") {
          throw new BridgeError(
            ErrorCode.INVALID_INPUT,
            `Field '${name}' must be a string, number, or null. Complex columns (lookup, person, managed metadata) are not supported by this bridge.`
          );
        }
        if (typeof value === "number" && !Number.isFinite(value)) {
          throw new BridgeError(ErrorCode.INVALID_INPUT, `Field '${name}' must be a finite number.`);
        }
        fields[name] = value;
      }

      requireExtensionOnline();
      const authorize = targetAuthorizer(policy);
      const { siteUrl, serverRelativeUrl } = await authorize(args.fileUrl, "Update file metadata", `Fields: ${Object.keys(fields).join(", ")}`);
      const reply = await nativeHost.sendRequest("updateFileMetadata", {
        siteUrl,
        fileServerRelativeUrl: serverRelativeUrl,
        fields,
      });
      throwIfPipeError(reply, ErrorCode.INTERNAL_ERROR);
      return reply.result ?? {};
    })
);

server.registerTool(
  "create_word_document",
  {
    description:
      "Create a Word (.docx) document locally from structured content (title, headings, paragraphs, lists, tables, page breaks) — does not open or automate Microsoft Word. After creating it, use m365_upload_file to store it in SharePoint/OneDrive if needed.",
    inputSchema: CreateWordDocumentInput.shape,
  },
  async (args) =>
    withAudit("create_word_document", args.outputPath, {}, async () => {
      const policy = getPolicy();
      const outputPath = resolveAllowedLocalPath(args.outputPath, policy);
      const result = await createWordDocument({ ...args, outputPath });
      return { ...result };
    })
);

server.registerTool(
  "create_excel_workbook",
  {
    description:
      "Create an Excel (.xlsx) workbook locally from structured worksheet/row data (columns, rows, freeze panes, autofilter, number formats) — does not open or automate Microsoft Excel. After creating it, use m365_upload_file to store it in SharePoint/OneDrive if needed.",
    inputSchema: CreateExcelWorkbookInput.shape,
  },
  async (args) =>
    withAudit("create_excel_workbook", args.outputPath, {}, async () => {
      const policy = getPolicy();
      const outputPath = resolveAllowedLocalPath(args.outputPath, policy);
      const result = await createExcelWorkbook({ ...args, outputPath });
      return { ...result };
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
