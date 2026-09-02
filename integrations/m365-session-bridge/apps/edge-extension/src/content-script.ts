/**
 * Injected on demand (chrome.scripting.executeScript) into a tab already on
 * an allowed *.sharepoint.com / *-my.sharepoint.com origin. Runs in the
 * isolated world (default) — not subject to the page's CSP, and same-origin
 * fetch() here carries the user's existing session cookies automatically.
 *
 * ONLY fetch() calls happen here. No querySelector, no .click(), no reading
 * document.cookie, no DOM inspection of the SharePoint UI.
 */
import { ErrorCode } from "@m365-bridge/protocol";
import {
  buildContextInfoRequest,
  parseContextInfoResponse,
  buildGetFileRequest,
  buildGetFileMetadataRequest,
  parseFileMetadataResponse,
  buildAddFileRequest,
  buildStartUploadRequest,
  buildContinueUploadRequest,
  buildFinishUploadRequest,
  buildCopyRequest,
  buildMoveRequest,
  buildRecycleRequest,
  buildCreateFolderRequest,
  buildGetFolderRequest,
  buildListItemAllFieldsRequest,
  parseListItemODataType,
  buildRenameRequest,
  buildListFolderFilesRequest,
  buildListFolderFoldersRequest,
  parseFolderFilesResponse,
  parseFolderFoldersResponse,
  verboseResultCount,
  buildFolderListItemAllFieldsRequest,
  buildFolderRenameRequest,
  buildRecycleFolderRequest,
  buildListFileVersionsRequest,
  parseFileVersionsResponse,
  buildRestoreFileVersionRequest,
  buildCheckOutRequest,
  buildCheckInRequest,
  buildUndoCheckOutRequest,
  buildUpdateFileMetadataRequest,
  LARGE_FILE_THRESHOLD_BYTES,
  RECOMMENDED_CHUNK_SIZE_BYTES,
  type RestCall,
} from "@m365-bridge/sharepoint";

interface CsRequest {
  type: string;
  payload: Record<string, unknown>;
}

type CsResponse = { ok: true; result?: unknown } | { ok: false; code: string; message: string };

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Throttling (SharePoint documents 3,000 requests / 5 minutes / user and
// answers with 429 or 503 plus a Retry-After header). Microsoft states that
// throttled requests themselves count toward the usage limit, so failing to
// honor Retry-After makes throttling worse rather than better.
//
// Retries here are triggered ONLY by an explicit 429/503 *response*. That
// status is proof the request was rejected and never reached success, which is
// what makes retrying a non-idempotent write safe. A thrown network error is
// deliberately NOT retried: there the outcome is unknown, so a retry could
// double-apply a write that had in fact already landed.
// ---------------------------------------------------------------------------
const THROTTLE_STATUSES = new Set([429, 503]);
const THROTTLE_MAX_RETRIES = 2;
/** Used only when the server omits Retry-After; index = retry attempt number. */
const THROTTLE_FALLBACK_DELAYS_MS = [5_000, 15_000];
/** Guard against a hostile/absurd Retry-After pinning the content script for hours. */
const THROTTLE_MAX_WAIT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get("Retry-After");
  const seconds = header ? Number(header.trim()) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, THROTTLE_MAX_WAIT_MS);
  }
  return THROTTLE_FALLBACK_DELAYS_MS[Math.min(attempt, THROTTLE_FALLBACK_DELAYS_MS.length - 1)];
}

function buildRequestInit(call: RestCall, body?: Uint8Array): RequestInit {
  const requestBody: BodyInit | undefined =
    call.body === "BINARY_PLACEHOLDER" ? (body ? new Blob([body as unknown as BlobPart]) : undefined) : call.body;
  return { method: call.method, headers: call.headers, body: requestBody };
}

/**
 * Single fetch path for every SharePoint call in this file. Transparently
 * waits out 429/503 throttling up to THROTTLE_MAX_RETRIES times; if the last
 * attempt is still throttled, the throttled Response is returned as-is and
 * mapHttpError turns it into ErrorCode.THROTTLED.
 */
async function doFetch(call: RestCall, body?: Uint8Array): Promise<Response> {
  let res = await fetch(call.url, buildRequestInit(call, body));
  for (let attempt = 0; attempt < THROTTLE_MAX_RETRIES && THROTTLE_STATUSES.has(res.status); attempt++) {
    await sleep(retryAfterDelayMs(res, attempt));
    res = await fetch(call.url, buildRequestInit(call, body));
  }
  return res;
}

// SharePoint's error *messages* are localized per tenant language (this
// tenant returns zh-TW), so matching English text like "already exists" is
// unreliable and silently fails on non-English tenants — confirmed live
// against this tenant. Two distinct codes have been observed empirically for
// the same "file already exists" condition depending on which endpoint hit
// it: Files/Add uses the Win32-wrapped HRESULT 0x80070050
// (HRESULT_FROM_WIN32(ERROR_FILE_EXISTS)); moveto uses SharePoint's own
// SPException facility code 0x81020067. Both are language-independent,
// unlike the message text. There may be others not yet observed — the
// English/Chinese text fallback below covers what's been seen live so far.
const SP_ERROR_FILE_EXISTS_HRESULTS = ["-2147024816" /* 0x80070050 */, "-2130575257" /* 0x81020067 */];

function isFileExistsError(responseText: string): boolean {
  try {
    const parsed = JSON.parse(responseText) as { error?: { code?: string } };
    const code = parsed.error?.code ?? "";
    if (SP_ERROR_FILE_EXISTS_HRESULTS.some((known) => code.startsWith(known))) return true;
  } catch {
    // fall through to the text heuristic below for non-JSON bodies
  }
  return /already exists|已經存在|已存在/i.test(responseText);
}

function mapHttpError(status: number, text: string): { code: string; message: string } {
  if (status === 401 || status === 302 || status === 403) {
    // A same-origin request only gets a 401/redirect-to-login when the M365 session itself
    // is missing/expired; 403 with no digest context is more often a real permission denial,
    // but a 403 on contextinfo/write can also mean an expired session — surface both possibilities.
    if (status === 401 || status === 302) {
      return { code: ErrorCode.M365_SESSION_REQUIRED, message: "Please sign in to Microsoft 365 in Microsoft Edge." };
    }
    return { code: ErrorCode.M365_PERMISSION_DENIED, message: `SharePoint denied the request (403): ${text.slice(0, 300)}` };
  }
  if (status === 404) return { code: ErrorCode.NOT_FOUND, message: "The requested file or folder was not found." };
  if (status === 409) return { code: ErrorCode.CONFLICT, message: "A file with that name already exists." };
  if (THROTTLE_STATUSES.has(status)) {
    // doFetch already honored Retry-After for the maximum number of retries,
    // so reaching here means SharePoint is still throttling this user.
    return {
      code: ErrorCode.THROTTLED,
      message: `SharePoint is throttling requests (HTTP ${status}) and did not recover after ${THROTTLE_MAX_RETRIES} retries honoring Retry-After. Wait a few minutes before trying again.`,
    };
  }
  return { code: ErrorCode.INTERNAL_ERROR, message: `SharePoint returned HTTP ${status}: ${text.slice(0, 300)}` };
}

async function getDigest(siteUrl: string): Promise<string> {
  const call = buildContextInfoRequest(siteUrl);
  const res = await doFetch(call);
  if (!res.ok) throw Object.assign(new Error("REQUEST_DIGEST_FAILED"), { code: ErrorCode.REQUEST_DIGEST_FAILED, httpStatus: res.status });
  const json = await res.json();
  return parseContextInfoResponse(json).formDigestValue;
}

async function handle(req: CsRequest): Promise<CsResponse> {
  const p = req.payload as Record<string, string | boolean | number | undefined>;
  try {
    switch (req.type) {
      case "sp-status": {
        // Routed through doFetch like every other call so the status probe is
        // subject to the same Retry-After handling rather than reporting the
        // session unreachable when it is merely throttled.
        const res = await doFetch({
          url: `${(p.siteUrl as string).replace(/\/$/, "")}/_api/web`,
          method: "GET",
          headers: { Accept: "application/json;odata=verbose" },
        });
        return { ok: true, result: { reachable: res.ok, httpStatus: res.status } };
      }

      case "sp-get-file": {
        const call = buildGetFileRequest(p.siteUrl as string, p.serverRelativeUrl as string);
        const res = await doFetch(call);
        if (!res.ok) {
          const err = mapHttpError(res.status, await res.text().catch(() => ""));
          return { ok: false, ...err };
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        return { ok: true, result: { dataBase64: bytesToBase64(buf), size: buf.byteLength } };
      }

      case "sp-get-metadata": {
        const call = buildGetFileMetadataRequest(p.siteUrl as string, p.serverRelativeUrl as string);
        const res = await doFetch(call);
        if (res.status === 404) return { ok: true, result: { exists: false } };
        if (!res.ok) {
          const err = mapHttpError(res.status, await res.text().catch(() => ""));
          return { ok: false, ...err };
        }
        const meta = parseFileMetadataResponse(await res.json());
        return { ok: true, result: meta };
      }

      case "sp-upload-file": {
        const siteUrl = p.siteUrl as string;
        const folderServerRelativeUrl = p.folderServerRelativeUrl as string;
        const fileName = p.fileName as string;
        const overwrite = Boolean(p.overwrite);
        const bytes = base64ToBytes(p.dataBase64 as string);
        const digest = await getDigest(siteUrl);

        if (bytes.byteLength <= LARGE_FILE_THRESHOLD_BYTES) {
          const call = buildAddFileRequest(siteUrl, folderServerRelativeUrl, fileName, overwrite, digest);
          const res = await doFetch(call, bytes);
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            if (!overwrite && isFileExistsError(text)) {
              return { ok: false, code: ErrorCode.CONFLICT, message: "A file with that name already exists." };
            }
            const err = mapHttpError(res.status, text);
            return { ok: false, ...err };
          }
          return { ok: true, result: { size: bytes.byteLength } };
        }

        // Chunked upload for large files: create an empty file first, then
        // startupload/continueupload/finishupload sequentially (must not run concurrently).
        const emptyCall = buildAddFileRequest(siteUrl, folderServerRelativeUrl, fileName, overwrite, digest);
        const createRes = await doFetch(emptyCall, new Uint8Array(0));
        if (!createRes.ok) {
          const text = await createRes.text().catch(() => "");
          if (!overwrite && isFileExistsError(text)) {
            return { ok: false, code: ErrorCode.CONFLICT, message: "A file with that name already exists." };
          }
          return { ok: false, ...mapHttpError(createRes.status, text) };
        }
        const fileServerRelativeUrl = `${folderServerRelativeUrl.replace(/\/$/, "")}/${fileName}`;
        const uploadId = crypto.randomUUID();
        let offset = 0;
        const total = bytes.byteLength;
        let freshDigest = await getDigest(siteUrl);

        while (offset < total) {
          const remaining = total - offset;
          const size = Math.min(RECOMMENDED_CHUNK_SIZE_BYTES, remaining);
          const slice = bytes.subarray(offset, offset + size);
          const isFirst = offset === 0;
          const isLast = offset + size >= total;
          freshDigest = await getDigest(siteUrl);
          const call = isFirst
            ? buildStartUploadRequest(siteUrl, fileServerRelativeUrl, uploadId, freshDigest)
            : isLast
              ? buildFinishUploadRequest(siteUrl, fileServerRelativeUrl, uploadId, offset, freshDigest)
              : buildContinueUploadRequest(siteUrl, fileServerRelativeUrl, uploadId, offset, freshDigest);
          const res = await doFetch(call, slice);
          if (!res.ok) {
            return { ok: false, ...mapHttpError(res.status, await res.text().catch(() => "")) };
          }
          offset += size;
        }
        return { ok: true, result: { size: total } };
      }

      case "sp-copy":
      case "sp-move": {
        const siteUrl = p.siteUrl as string;
        const overwrite = Boolean(p.overwrite);
        const destServerRelativeUrl = p.destServerRelativeUrl as string;

        // Confirmed live: SharePoint's moveto is not safely atomic on a
        // destination naming conflict — it can remove the source before the
        // destination-exists check fails, even with overwrite=false, leaving
        // the source gone and nothing usable at the destination (the source
        // does land in the site's Recycle Bin, so it isn't a permanent loss,
        // but a caller relying on "error means nothing happened" would be
        // wrong). Check the destination ourselves first and refuse before
        // ever calling copyto/moveto, so this can't happen from here.
        if (!overwrite) {
          const existsCall = buildGetFileMetadataRequest(siteUrl, destServerRelativeUrl);
          const existsRes = await doFetch(existsCall);
          if (existsRes.ok) {
            return { ok: false, code: ErrorCode.CONFLICT, message: "A file with that name already exists at the destination." };
          }
          if (existsRes.status !== 404) {
            return { ok: false, ...mapHttpError(existsRes.status, await existsRes.text().catch(() => "")) };
          }
        }

        const digest = await getDigest(siteUrl);
        const call =
          req.type === "sp-copy"
            ? buildCopyRequest(siteUrl, p.sourceServerRelativeUrl as string, destServerRelativeUrl, overwrite, digest)
            : buildMoveRequest(siteUrl, p.sourceServerRelativeUrl as string, destServerRelativeUrl, overwrite, digest);
        const res = await doFetch(call);
        const bodyText = await res.text().catch(() => "");
        if (!res.ok) {
          if (!overwrite && isFileExistsError(bodyText)) {
            return { ok: false, code: ErrorCode.CONFLICT, message: "A file with that name already exists at the destination." };
          }
          return { ok: false, ...mapHttpError(res.status, bodyText) };
        }
        // Diagnostic-only field (not a stable contract): copyto/moveto were
        // only verified against an archived 2015-era reference doc — surface
        // the raw response so a "success" that didn't actually move/copy
        // anything (e.g. a modern-SharePoint behavior change) is visible
        // instead of silently reporting ok:true.
        return { ok: true, result: { httpStatus: res.status, rawResponse: bodyText.slice(0, 500) } };
      }

      case "sp-create-folder": {
        const siteUrl = p.siteUrl as string;
        // Each level of the requested path, outermost first. SharePoint's
        // folders endpoint creates exactly one folder and does NOT create
        // missing parents, so nested paths are walked level by level.
        const levels = p.folderServerRelativeUrls as unknown as string[];
        const created: string[] = [];

        for (const level of levels) {
          // Already-present levels are skipped rather than treated as an
          // error — this makes creating "2026/Q1" when "2026" already exists
          // work, and makes the whole call safely idempotent.
          const existsRes = await doFetch(buildGetFolderRequest(siteUrl, level));
          if (existsRes.ok) continue;
          if (existsRes.status !== 404) {
            return { ok: false, ...mapHttpError(existsRes.status, await existsRes.text().catch(() => "")) };
          }

          const digest = await getDigest(siteUrl);
          const res = await doFetch(buildCreateFolderRequest(siteUrl, level, digest));
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            // A concurrent creator can win the race between our existence
            // check and this POST; that's success from the caller's view.
            if (isFileExistsError(text)) continue;
            return { ok: false, ...mapHttpError(res.status, text) };
          }
          created.push(level);
        }

        return { ok: true, result: { created } };
      }

      case "sp-recycle": {
        const siteUrl = p.siteUrl as string;
        const digest = await getDigest(siteUrl);
        const call = buildRecycleRequest(siteUrl, p.fileServerRelativeUrl as string, digest);
        const res = await doFetch(call);
        if (!res.ok) return { ok: false, ...mapHttpError(res.status, await res.text().catch(() => "")) };
        return { ok: true };
      }

      case "sp-rename": {
        const siteUrl = p.siteUrl as string;
        const fileServerRelativeUrl = p.fileServerRelativeUrl as string;
        const newLeafName = p.newLeafName as string;

        // Same pre-flight safety guard as copy/move (see the comment there):
        // a rename to an existing name is refused before touching anything,
        // rather than relying on SharePoint to reject the MERGE cleanly.
        const parentPath = fileServerRelativeUrl.slice(0, fileServerRelativeUrl.lastIndexOf("/"));
        const renameDestPath = `${parentPath}/${newLeafName}`;
        if (renameDestPath.toLowerCase() !== fileServerRelativeUrl.toLowerCase()) {
          const existsCall = buildGetFileMetadataRequest(siteUrl, renameDestPath);
          const existsRes = await doFetch(existsCall);
          if (existsRes.ok) {
            return { ok: false, code: ErrorCode.CONFLICT, message: "A file with that name already exists." };
          }
          if (existsRes.status !== 404) {
            return { ok: false, ...mapHttpError(existsRes.status, await existsRes.text().catch(() => "")) };
          }
        }

        const itemCall = buildListItemAllFieldsRequest(siteUrl, fileServerRelativeUrl);
        const itemRes = await doFetch(itemCall);
        if (!itemRes.ok) return { ok: false, ...mapHttpError(itemRes.status, await itemRes.text().catch(() => "")) };
        const { odataType, eTag } = parseListItemODataType(await itemRes.json());
        const digest = await getDigest(siteUrl);
        const call = buildRenameRequest(siteUrl, fileServerRelativeUrl, odataType, eTag, p.newLeafName as string, digest);
        const res = await doFetch(call);
        if (!res.ok) return { ok: false, ...mapHttpError(res.status, await res.text().catch(() => "")) };
        return { ok: true };
      }

      case "sp-get-url": {
        const call = buildGetFileMetadataRequest(p.siteUrl as string, p.serverRelativeUrl as string);
        const res = await doFetch(call);
        if (res.status === 404) return { ok: false, code: ErrorCode.NOT_FOUND, message: "File not found." };
        if (!res.ok) return { ok: false, ...mapHttpError(res.status, await res.text().catch(() => "")) };
        const meta = parseFileMetadataResponse(await res.json());
        if (!meta.exists || !meta.serverRelativeUrl) {
          return { ok: false, code: ErrorCode.NOT_FOUND, message: "File not found." };
        }
        const origin = new URL(p.siteUrl as string).origin;
        const canonicalUrl = origin + meta.serverRelativeUrl.split("/").map(encodeURIComponent).join("/");
        return { ok: true, result: { canonicalUrl } };
      }

      // ---------------------------------------------------------------- v0.2
      case "sp-list-folder": {
        const siteUrl = p.siteUrl as string;
        const folderServerRelativeUrl = p.folderServerRelativeUrl as string;
        const maxItems = Number(p.maxItems);

        const filesRes = await doFetch(buildListFolderFilesRequest(siteUrl, folderServerRelativeUrl, maxItems));
        if (filesRes.status === 404) {
          return { ok: false, code: ErrorCode.NOT_FOUND, message: `Folder not found: ${folderServerRelativeUrl}` };
        }
        if (!filesRes.ok) return { ok: false, ...mapHttpError(filesRes.status, await filesRes.text().catch(() => "")) };
        const filesJson = await filesRes.json();
        const files = parseFolderFilesResponse(filesJson);
        const rawFileCount = verboseResultCount(filesJson);

        const foldersRes = await doFetch(buildListFolderFoldersRequest(siteUrl, folderServerRelativeUrl, maxItems));
        if (foldersRes.status === 404) {
          return { ok: false, code: ErrorCode.NOT_FOUND, message: `Folder not found: ${folderServerRelativeUrl}` };
        }
        if (!foldersRes.ok) {
          return { ok: false, ...mapHttpError(foldersRes.status, await foldersRes.text().catch(() => "")) };
        }
        const foldersJson = await foldersRes.json();
        const folders = parseFolderFoldersResponse(foldersJson);
        const rawFolderCount = verboseResultCount(foldersJson);

        // truncated is judged on the RAW $top counts, before the "Forms"
        // system folder is dropped — otherwise filtering one entry out of a
        // full page would make an incomplete listing look complete.
        return {
          ok: true,
          result: {
            files: files.map(({ name, serverRelativeUrl, size, modified }) => ({ name, serverRelativeUrl, size, modified })),
            folders: folders.map(({ name, serverRelativeUrl }) => ({ name, serverRelativeUrl })),
            truncated: rawFileCount >= maxItems || rawFolderCount >= maxItems,
          },
        };
      }

      case "sp-rename-folder": {
        const siteUrl = p.siteUrl as string;
        const folderServerRelativeUrl = p.folderServerRelativeUrl as string;
        const newLeafName = p.newLeafName as string;

        // Same pre-flight guard as file rename/copy/move: refuse a colliding
        // name before touching SharePoint rather than trusting it to fail cleanly.
        const parentPath = folderServerRelativeUrl.slice(0, folderServerRelativeUrl.lastIndexOf("/"));
        const destPath = `${parentPath}/${newLeafName}`;
        if (destPath.toLowerCase() !== folderServerRelativeUrl.toLowerCase()) {
          const existsRes = await doFetch(buildGetFolderRequest(siteUrl, destPath));
          if (existsRes.ok) {
            return { ok: false, code: ErrorCode.CONFLICT, message: "A folder with that name already exists." };
          }
          if (existsRes.status !== 404) {
            return { ok: false, ...mapHttpError(existsRes.status, await existsRes.text().catch(() => "")) };
          }
        }

        const itemRes = await doFetch(buildFolderListItemAllFieldsRequest(siteUrl, folderServerRelativeUrl));
        if (!itemRes.ok) return { ok: false, ...mapHttpError(itemRes.status, await itemRes.text().catch(() => "")) };
        const { odataType, eTag } = parseListItemODataType(await itemRes.json());
        const digest = await getDigest(siteUrl);
        const res = await doFetch(
          buildFolderRenameRequest(siteUrl, folderServerRelativeUrl, odataType, eTag, newLeafName, digest)
        );
        if (!res.ok) return { ok: false, ...mapHttpError(res.status, await res.text().catch(() => "")) };
        return { ok: true, result: {} };
      }

      case "sp-recycle-folder": {
        const siteUrl = p.siteUrl as string;
        const digest = await getDigest(siteUrl);
        const res = await doFetch(buildRecycleFolderRequest(siteUrl, p.folderServerRelativeUrl as string, digest));
        if (!res.ok) return { ok: false, ...mapHttpError(res.status, await res.text().catch(() => "")) };
        return { ok: true, result: {} };
      }

      case "sp-list-versions": {
        const res = await doFetch(buildListFileVersionsRequest(p.siteUrl as string, p.fileServerRelativeUrl as string));
        if (res.status === 404) return { ok: false, code: ErrorCode.NOT_FOUND, message: "File not found." };
        if (!res.ok) return { ok: false, ...mapHttpError(res.status, await res.text().catch(() => "")) };
        return { ok: true, result: { versions: parseFileVersionsResponse(await res.json()) } };
      }

      case "sp-restore-version": {
        const siteUrl = p.siteUrl as string;
        const digest = await getDigest(siteUrl);
        const res = await doFetch(
          buildRestoreFileVersionRequest(siteUrl, p.fileServerRelativeUrl as string, p.versionLabel as string, digest)
        );
        if (res.status === 404) {
          return { ok: false, code: ErrorCode.NOT_FOUND, message: `No such file or version label: ${p.versionLabel}` };
        }
        if (!res.ok) return { ok: false, ...mapHttpError(res.status, await res.text().catch(() => "")) };
        return { ok: true, result: {} };
      }

      case "sp-checkout":
      case "sp-discard-checkout": {
        const siteUrl = p.siteUrl as string;
        const fileServerRelativeUrl = p.fileServerRelativeUrl as string;
        const digest = await getDigest(siteUrl);
        const call =
          req.type === "sp-checkout"
            ? buildCheckOutRequest(siteUrl, fileServerRelativeUrl, digest)
            : buildUndoCheckOutRequest(siteUrl, fileServerRelativeUrl, digest);
        const res = await doFetch(call);
        if (!res.ok) return { ok: false, ...mapHttpError(res.status, await res.text().catch(() => "")) };
        return { ok: true, result: {} };
      }

      case "sp-checkin": {
        const siteUrl = p.siteUrl as string;
        const digest = await getDigest(siteUrl);
        // checkInType arrives already mapped to SharePoint's int by the MCP
        // server; the wire protocol stays numeric and the tool surface human.
        const res = await doFetch(
          buildCheckInRequest(
            siteUrl,
            p.fileServerRelativeUrl as string,
            (p.comment as string) ?? "",
            Number(p.checkInType),
            digest
          )
        );
        if (!res.ok) return { ok: false, ...mapHttpError(res.status, await res.text().catch(() => "")) };
        return { ok: true, result: {} };
      }

      case "sp-update-metadata": {
        const siteUrl = p.siteUrl as string;
        const fileServerRelativeUrl = p.fileServerRelativeUrl as string;
        // The forbidden-field and value-type guards already ran in the MCP
        // server (policy runs before any network call); this layer only shapes
        // the request.
        const fields = req.payload.fields as Record<string, string | number | null>;

        const itemRes = await doFetch(buildListItemAllFieldsRequest(siteUrl, fileServerRelativeUrl));
        if (itemRes.status === 404) return { ok: false, code: ErrorCode.NOT_FOUND, message: "File not found." };
        if (!itemRes.ok) return { ok: false, ...mapHttpError(itemRes.status, await itemRes.text().catch(() => "")) };
        const { odataType, eTag } = parseListItemODataType(await itemRes.json());
        const digest = await getDigest(siteUrl);
        const res = await doFetch(
          buildUpdateFileMetadataRequest(siteUrl, fileServerRelativeUrl, odataType, eTag, fields, digest)
        );
        if (!res.ok) return { ok: false, ...mapHttpError(res.status, await res.text().catch(() => "")) };
        return { ok: true, result: { updatedFields: Object.keys(fields) } };
      }

      default:
        return { ok: false, code: ErrorCode.NOT_SUPPORTED_SESSION_BRIDGE, message: `Unknown operation: ${req.type}` };
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? ErrorCode.INTERNAL_ERROR;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code, message };
  }
}

// background.ts injects this file on every operation without checking
// whether it's already present in the tab (chrome.scripting.executeScript
// re-runs the whole script each call; it does not dedupe against a prior
// injection into the same tab). Left unguarded, a long-lived background tab
// accumulates one onMessage listener per operation ever performed in it, and
// EVERY listener independently executes each incoming request — confirmed
// live: a single upload call fired two real POSTs to Files/Add, the first
// silently creating the file and the second correctly finding it already
// there, with the CONFLICT response racing the success response back to the
// caller. `window` survives across re-injections into the same tab (unlike
// any state kept in the service worker, which can restart independently of
// the tab's lifetime), so it's what actually stops re-registration.
const injectionFlag = "__m365BridgeContentScriptInjected";
if (!(window as unknown as Record<string, boolean>)[injectionFlag]) {
  (window as unknown as Record<string, boolean>)[injectionFlag] = true;

  chrome.runtime.onMessage.addListener((message: CsRequest, _sender, sendResponse) => {
    handle(message).then(sendResponse);
    return true; // keep the message channel open for the async response
  });
}
