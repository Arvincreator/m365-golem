#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { ErrorCode, type PipeRequest, type PipeResponse } from "@m365-bridge/protocol";
import { ensureDir, writeFileAtomic, sha256File, getFileSize } from "@m365-bridge/files";
import { ExtensionLink, type ExtensionReply } from "./extension-link.js";
import { McpPipeConnection } from "./pipe-connection.js";
import { log } from "./log.js";
import { parseApprovalResult, type ApprovalDecision } from "./approval.js";

log(`native host starting; argv=${JSON.stringify(process.argv.slice(2))}`);
process.on("uncaughtException", (err) => log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`));
process.on("exit", (code) => log(`process exiting with code ${code}`));

// Edge closes this process's stdin when it disconnects the native messaging
// port (extension reload, service worker restart, browser shutdown, etc.).
// Without an explicit exit here, the process would sit alive indefinitely
// with no more input ever arriving — this was observed piling up as zombie
// node processes (one per reconnect attempt) before this fix.
process.stdin.on("end", () => {
  log("stdin ended (Edge disconnected us) — exiting");
  process.exit(0);
});
process.stdin.on("close", () => {
  log("stdin closed — exiting");
  process.exit(0);
});

const link = new ExtensionLink();

function errResponse(id: string, code: string, message: string): PipeResponse {
  return { kind: "response", id, ok: false, errorCode: code, errorMessage: message };
}
function okResponse(id: string, result: Record<string, unknown>): PipeResponse {
  return { kind: "response", id, ok: true, result };
}
function errorFromReply(reply: ExtensionReply, fallbackCode: string, fallbackMessage: string) {
  const p = reply.payload as { code?: string; message?: string } | undefined;
  return { code: p?.code ?? fallbackCode, message: p?.message ?? fallbackMessage };
}

type ApprovalPayload = { hostname: string; url: string; action: string; detail?: string };

const approvalScriptPath = path.join(__dirname, "..", "scripts", "approval-dialog.ps1");
const approvalQueue: Array<{ payload: ApprovalPayload; resolve: (decision: ApprovalDecision) => void }> = [];
let approvalDialogBusy = false;

function runApprovalDialog(payload: ApprovalPayload): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      resolve(decision);
    };

    const child = execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        approvalScriptPath,
        "-Hostname",
        payload.hostname,
        "-Url",
        payload.url,
        "-Action",
        payload.action,
        "-Detail",
        payload.detail ?? "",
      ],
      { windowsHide: true, encoding: "utf8", maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) {
          finish("deny");
          return;
        }
        finish(parseApprovalResult(stdout));
      }
    );

    child.once("error", () => finish("deny"));
    const timeout = setTimeout(() => {
      child.kill();
      finish("deny");
    }, 90_000);
    child.once("close", () => clearTimeout(timeout));
  });
}

function drainApprovalQueue(): void {
  if (approvalDialogBusy) return;
  const next = approvalQueue.shift();
  if (!next) return;
  approvalDialogBusy = true;
  void runApprovalDialog(next.payload).then((decision) => {
    next.resolve(decision);
    approvalDialogBusy = false;
    drainApprovalQueue();
  });
}

function requestApproval(payload: ApprovalPayload): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    approvalQueue.push({ payload, resolve });
    drainApprovalQueue();
  });
}

function parseApprovalPayload(raw: Record<string, unknown>): ApprovalPayload | null {
  if (
    typeof raw.hostname !== "string" ||
    typeof raw.url !== "string" ||
    typeof raw.action !== "string" ||
    (raw.detail !== undefined && typeof raw.detail !== "string")
  ) {
    return null;
  }
  return { hostname: raw.hostname, url: raw.url, action: raw.action, detail: raw.detail as string | undefined };
}

/** Defense-in-depth: the MCP server already validated this path against allowedLocalPaths; never trust a single layer. */
function looksLikeSafeAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) && !p.split(path.sep).includes("..");
}

async function handleRequest(req: PipeRequest): Promise<PipeResponse> {
  try {
    switch (req.op) {
      case "requestApproval": {
        const payload = parseApprovalPayload(req.payload);
        if (!payload) return okResponse(req.id, { decision: "deny" });
        const decision = await requestApproval(payload);
        return okResponse(req.id, { decision });
      }

      case "status": {
        const payload = req.payload as { siteUrl?: string };
        const reply = await link.request("bridge-status", { siteUrl: payload.siteUrl }, undefined, 15_000).catch(() => null);
        if (!reply) return okResponse(req.id, { extensionOnline: false });
        return okResponse(req.id, { extensionOnline: true, ...(reply.payload ?? {}) });
      }

      case "download": {
        const payload = req.payload as { siteUrl: string; serverRelativeUrl: string; destinationPath: string };
        if (!looksLikeSafeAbsolutePath(payload.destinationPath)) {
          return errResponse(req.id, ErrorCode.INTERNAL_ERROR, "destinationPath failed native-host sanity check");
        }
        const reply = await link.request("sp-get-file", {
          siteUrl: payload.siteUrl,
          serverRelativeUrl: payload.serverRelativeUrl,
        });
        if (reply.type === "error") {
          const { code, message } = errorFromReply(reply, ErrorCode.DOWNLOAD_FAILED, "Download failed");
          return errResponse(req.id, code, message);
        }
        if (!reply.data) return errResponse(req.id, ErrorCode.DOWNLOAD_FAILED, "No data received from extension");
        await ensureDir(path.dirname(payload.destinationPath));
        await writeFileAtomic(payload.destinationPath, reply.data);
        const [sha256, size] = await Promise.all([
          sha256File(payload.destinationPath),
          getFileSize(payload.destinationPath),
        ]);
        return okResponse(req.id, {
          localPath: payload.destinationPath,
          fileName: path.basename(payload.destinationPath),
          size,
          sha256,
        });
      }

      case "upload": {
        const payload = req.payload as {
          localPath: string;
          siteUrl: string;
          folderServerRelativeUrl: string;
          fileName: string;
          overwrite: boolean;
        };
        if (!looksLikeSafeAbsolutePath(payload.localPath)) {
          return errResponse(req.id, ErrorCode.INTERNAL_ERROR, "localPath failed native-host sanity check");
        }
        const data = await fs.promises.readFile(payload.localPath);
        const reply = await link.request(
          "sp-upload-file",
          {
            siteUrl: payload.siteUrl,
            folderServerRelativeUrl: payload.folderServerRelativeUrl,
            fileName: payload.fileName,
            overwrite: payload.overwrite,
          },
          data,
          300_000
        );
        if (reply.type === "error") {
          const { code, message } = errorFromReply(reply, ErrorCode.UPLOAD_FAILED, "Upload failed");
          return errResponse(req.id, code, message);
        }
        return okResponse(req.id, { size: data.length, ...(reply.payload ?? {}) });
      }

      case "copy":
      case "move": {
        const payload = req.payload as {
          siteUrl: string;
          sourceServerRelativeUrl: string;
          destServerRelativeUrl: string;
          overwrite: boolean;
        };
        const reply = await link.request(req.op === "copy" ? "sp-copy" : "sp-move", payload);
        if (reply.type === "error") {
          const { code, message } = errorFromReply(reply, ErrorCode.INTERNAL_ERROR, `${req.op} failed`);
          return errResponse(req.id, code, message);
        }
        return okResponse(req.id, reply.payload ?? {});
      }

      case "rename": {
        const payload = req.payload as { siteUrl: string; fileServerRelativeUrl: string; newLeafName: string };
        const reply = await link.request("sp-rename", payload);
        if (reply.type === "error") {
          const { code, message } = errorFromReply(reply, ErrorCode.INTERNAL_ERROR, "rename failed");
          return errResponse(req.id, code, message);
        }
        return okResponse(req.id, reply.payload ?? {});
      }

      case "getUrl": {
        const payload = req.payload as { siteUrl: string; serverRelativeUrl: string };
        const reply = await link.request("sp-get-url", payload);
        if (reply.type === "error") {
          const { code, message } = errorFromReply(reply, ErrorCode.NOT_FOUND, "getUrl failed");
          return errResponse(req.id, code, message);
        }
        return okResponse(req.id, reply.payload ?? {});
      }

      case "createFolder": {
        const payload = req.payload as { siteUrl: string; folderServerRelativeUrls: string[] };
        const reply = await link.request("sp-create-folder", payload);
        if (reply.type === "error") {
          const { code, message } = errorFromReply(reply, ErrorCode.INTERNAL_ERROR, "createFolder failed");
          return errResponse(req.id, code, message);
        }
        return okResponse(req.id, reply.payload ?? {});
      }

      case "recycle": {
        const payload = req.payload as { siteUrl: string; fileServerRelativeUrl: string };
        const reply = await link.request("sp-recycle", payload);
        if (reply.type === "error") {
          const { code, message } = errorFromReply(reply, ErrorCode.INTERNAL_ERROR, "recycle failed");
          return errResponse(req.id, code, message);
        }
        return okResponse(req.id, reply.payload ?? {});
      }

      // ---------------------------------------------------------------- v0.2
      // Each of these is a pure relay: the payload was already validated by
      // the MCP server's policy guard, and the native host adds nothing but
      // the op -> native-message-type mapping.
      case "listFolder":
      case "renameFolder":
      case "recycleFolder":
      case "listFileVersions":
      case "restoreFileVersion":
      case "checkoutFile":
      case "checkinFile":
      case "discardCheckout":
      case "updateFileMetadata": {
        const messageType = {
          listFolder: "sp-list-folder",
          renameFolder: "sp-rename-folder",
          recycleFolder: "sp-recycle-folder",
          listFileVersions: "sp-list-versions",
          restoreFileVersion: "sp-restore-version",
          checkoutFile: "sp-checkout",
          checkinFile: "sp-checkin",
          discardCheckout: "sp-discard-checkout",
          updateFileMetadata: "sp-update-metadata",
        }[req.op];
        const reply = await link.request(messageType, req.payload);
        if (reply.type === "error") {
          const { code, message } = errorFromReply(reply, ErrorCode.INTERNAL_ERROR, `${req.op} failed`);
          return errResponse(req.id, code, message);
        }
        return okResponse(req.id, reply.payload ?? {});
      }

      default:
        return errResponse(req.id, ErrorCode.NOT_SUPPORTED_SESSION_BRIDGE, `Unknown op: ${req.op}`);
    }
  } catch (err) {
    return errResponse(req.id, ErrorCode.EDGE_EXTENSION_OFFLINE, err instanceof Error ? err.message : String(err));
  }
}

const pipe = new McpPipeConnection(handleRequest);
pipe.start();
