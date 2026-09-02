/**
 * Pure, environment-agnostic SharePoint REST request builders / response
 * parsers. No fetch() calls live here — this package only knows how to shape
 * a request and interpret a response. The actual fetch() execution MUST
 * happen from a content script running same-origin on the target
 * *.sharepoint.com / *-my.sharepoint.com tab (see the built-in bridge README
 * for why: SharePoint does not emit Access-Control-Allow-Origin, so a
 * cross-origin call from the extension service worker is blocked by CORS
 * regardless of host_permissions).
 *
 * Every endpoint here is sourced from official Microsoft Learn documentation
 * — see docs/ARCHITECTURE.md "SharePoint REST reference" table for citations.
 * Anything not confirmed against an official doc is NOT implemented; callers
 * get NOT_SUPPORTED_SESSION_BRIDGE instead of a guessed endpoint.
 */

export interface RestCall {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** string for JSON bodies, or a marker for the caller to substitute raw binary. */
  body?: string | "BINARY_PLACEHOLDER";
}

export interface ContextInfo {
  formDigestValue: string;
  /** ms since epoch when the digest expires; caller must re-fetch after this. */
  expiresAt: number;
}

const VERBOSE_ACCEPT = "application/json;odata=verbose";
const VERBOSE_CONTENT_TYPE = "application/json;odata=verbose";

/** Extracts the server-relative URL (decoded path) from an absolute SharePoint URL. */
export function serverRelativeUrl(absoluteUrl: string): string {
  const u = new URL(absoluteUrl);
  return decodeURIComponent(u.pathname);
}

function encodeForRestLiteral(serverRelPath: string): string {
  // Single-quote-delimited REST string literal; escape embedded single quotes by doubling.
  return `'${serverRelPath.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// _api/contextinfo — Request Digest
// Source: https://learn.microsoft.com/en-us/sharepoint/dev/sp-add-ins/complete-basic-operations-using-sharepoint-rest-endpoints
// ---------------------------------------------------------------------------
export function buildContextInfoRequest(siteUrl: string): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/contextinfo`,
    method: "POST",
    headers: { Accept: VERBOSE_ACCEPT },
  };
}

export function parseContextInfoResponse(json: unknown, digestLifetimeSeconds = 1800): ContextInfo {
  const value = (json as { d?: { GetContextWebInformation?: { FormDigestValue?: string; FormDigestTimeoutSeconds?: number } } })?.d
    ?.GetContextWebInformation;
  if (!value?.FormDigestValue) {
    throw new Error("REQUEST_DIGEST_FAILED: response missing d.GetContextWebInformation.FormDigestValue");
  }
  const lifetime = value.FormDigestTimeoutSeconds ?? digestLifetimeSeconds;
  return { formDigestValue: value.FormDigestValue, expiresAt: Date.now() + lifetime * 1000 };
}

// ---------------------------------------------------------------------------
// GET file content — $value
// Source: https://learn.microsoft.com/en-us/sharepoint/dev/sp-add-ins/working-with-folders-and-files-with-rest
// ---------------------------------------------------------------------------
export function buildGetFileRequest(siteUrl: string, fileServerRelativeUrl: string): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
      fileServerRelativeUrl
    )})/$value`,
    method: "GET",
    headers: {},
  };
}

export function buildGetFileMetadataRequest(siteUrl: string, fileServerRelativeUrl: string): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
      fileServerRelativeUrl
    )})`,
    method: "GET",
    headers: { Accept: VERBOSE_ACCEPT },
  };
}

export interface FileMetadata {
  exists: boolean;
  name?: string;
  length?: number;
  serverRelativeUrl?: string;
  eTag?: string;
  listItemAllFieldsUrl?: string;
}

export function parseFileMetadataResponse(json: unknown): FileMetadata {
  const d = (json as { d?: Record<string, unknown> })?.d;
  if (!d) return { exists: false };
  return {
    exists: true,
    name: d.Name as string | undefined,
    length: d.Length !== undefined ? Number(d.Length) : undefined,
    serverRelativeUrl: d.ServerRelativeUrl as string | undefined,
    eTag: d["odata.etag"] as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Simple upload — Files/Add (use for files under LARGE_FILE_THRESHOLD_BYTES)
// Source: https://learn.microsoft.com/en-us/sharepoint/dev/sp-add-ins/working-with-folders-and-files-with-rest
// ---------------------------------------------------------------------------
export const LARGE_FILE_THRESHOLD_BYTES = 10 * 1024 * 1024; // MS guidance: use chunked upload above ~10MB
export const RECOMMENDED_CHUNK_SIZE_BYTES = 10 * 1024 * 1024;

export function buildAddFileRequest(
  siteUrl: string,
  folderServerRelativeUrl: string,
  fileName: string,
  overwrite: boolean,
  digest: string
): RestCall {
  const params = new URLSearchParams();
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFolderByServerRelativeUrl(${encodeForRestLiteral(
      folderServerRelativeUrl
    )})/Files/add(url=${encodeForRestLiteral(fileName)},overwrite=${overwrite ? "true" : "false"})`,
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
    body: "BINARY_PLACEHOLDER",
  };
}

// ---------------------------------------------------------------------------
// Chunked upload — StartUpload / ContinueUpload / FinishUpload
// SharePoint Online only. Chunks MUST be sent sequentially, not concurrently.
// Source: https://learn.microsoft.com/en-us/previous-versions/office/developer/sharepoint-rest-reference/dn450841(v=office.15)
//         https://learn.microsoft.com/en-us/sharepoint/dev/solution-guidance/upload-large-files-sample-app-for-sharepoint
// ---------------------------------------------------------------------------
export function buildStartUploadRequest(
  siteUrl: string,
  emptyFileServerRelativeUrl: string,
  uploadId: string,
  digest: string
): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
      emptyFileServerRelativeUrl
    )})/startupload(uploadId=guid'${uploadId}')`,
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
    body: "BINARY_PLACEHOLDER",
  };
}

export function buildContinueUploadRequest(
  siteUrl: string,
  fileServerRelativeUrl: string,
  uploadId: string,
  fileOffset: number,
  digest: string
): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
      fileServerRelativeUrl
    )})/continueupload(uploadId=guid'${uploadId}',fileOffset=${fileOffset})`,
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
    body: "BINARY_PLACEHOLDER",
  };
}

export function buildFinishUploadRequest(
  siteUrl: string,
  fileServerRelativeUrl: string,
  uploadId: string,
  fileOffset: number,
  digest: string
): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
      fileServerRelativeUrl
    )})/finishupload(uploadId=guid'${uploadId}',fileOffset=${fileOffset})`,
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
    body: "BINARY_PLACEHOLDER",
  };
}

export function buildCancelUploadRequest(
  siteUrl: string,
  fileServerRelativeUrl: string,
  uploadId: string,
  digest: string
): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
      fileServerRelativeUrl
    )})/cancelupload(uploadId=guid'${uploadId}')`,
    method: "POST",
    headers: { "X-RequestDigest": digest },
  };
}

// ---------------------------------------------------------------------------
// Copy / Move / Recycle
// Source: https://learn.microsoft.com/en-us/previous-versions/office/developer/sharepoint-rest-reference/dn450841(v=office.15)
// (Endpoint names/behavior cross-checked as unchanged against the current
// folders-and-files-with-rest doc; flagged in AUTH_SPIKE_REPORT as verified
// via an archived-but-MS-authored page — re-verify empirically in Gate 2/5.)
// ---------------------------------------------------------------------------
export function buildCopyRequest(
  siteUrl: string,
  sourceServerRelativeUrl: string,
  destServerRelativeUrl: string,
  overwrite: boolean,
  digest: string
): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
      sourceServerRelativeUrl
    )})/copyto(strnewurl=${encodeForRestLiteral(destServerRelativeUrl)},boverwrite=${overwrite ? "true" : "false"})`,
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
  };
}

const MOVE_FLAG_NONE = 0;
const MOVE_FLAG_OVERWRITE = 1;

export function buildMoveRequest(
  siteUrl: string,
  sourceServerRelativeUrl: string,
  destServerRelativeUrl: string,
  overwrite: boolean,
  digest: string
): RestCall {
  const flags = overwrite ? MOVE_FLAG_OVERWRITE : MOVE_FLAG_NONE;
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
      sourceServerRelativeUrl
    )})/moveto(newurl=${encodeForRestLiteral(destServerRelativeUrl)},flags=${flags})`,
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
  };
}

export function buildRecycleRequest(siteUrl: string, fileServerRelativeUrl: string, digest: string): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
      fileServerRelativeUrl
    )})/recycle`,
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
  };
}

// ---------------------------------------------------------------------------
// Create folder — Folders/AddUsingPath, the ResourcePath ("...UsingPath")
// family. Source (current):
// https://learn.microsoft.com/en-us/sharepoint/dev/solution-guidance/supporting-and-in-file-and-folder-with-the-resourcepath-api
//
// Deliberately NOT the older `POST _api/web/folders` + SP.Folder body: the
// current folders-and-files page carries an explicit warning that those
// examples "do not support the % and # characters" and points here instead.
// Names containing % or # are entirely plausible in real document libraries,
// so the path-based form is the correct default.
//
// This creates ONE folder and is not documented to create missing
// intermediate parents (Microsoft doesn't state either way), so the caller
// walks a nested path level by level rather than relying on that.
// ---------------------------------------------------------------------------
export function buildCreateFolderRequest(
  siteUrl: string,
  folderServerRelativeUrl: string,
  digest: string
): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/Folders/AddUsingPath(decodedurl=${encodeForRestLiteral(
      folderServerRelativeUrl
    )})`,
    method: "POST",
    headers: {
      "X-RequestDigest": digest,
      Accept: VERBOSE_ACCEPT,
      "Content-Type": VERBOSE_CONTENT_TYPE,
    },
  };
}

/**
 * GET a folder's metadata — used to test existence before creating.
 * Uses GetFolderByServerRelativePath (the %/#-safe ResourcePath form) for the
 * same reason as buildCreateFolderRequest above.
 */
export function buildGetFolderRequest(siteUrl: string, folderServerRelativeUrl: string): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFolderByServerRelativePath(decodedUrl=${encodeForRestLiteral(
      folderServerRelativeUrl
    )})`,
    method: "GET",
    headers: { Accept: VERBOSE_ACCEPT },
  };
}

/**
 * SharePoint rejects these characters in file/folder names, and some are also
 * path-traversal vectors. Validated before any create/rename call so a bad
 * name fails locally with a clear message instead of a raw SharePoint error.
 * Source: https://support.microsoft.com/en-us/office/restrictions-and-limitations-in-onedrive-and-sharepoint-64883a5d-228e-48f5-b3d2-eb39e07630fa
 */
const INVALID_NAME_CHARS = /["*:<>?/\\|]/;
const RESERVED_LEAF_NAMES = new Set([".lock", "CON", "PRN", "AUX", "NUL", "desktop.ini"]);

export function validateLeafName(name: string): { ok: true } | { ok: false; reason: string } {
  if (!name || !name.trim()) return { ok: false, reason: "Name is empty" };
  if (name !== name.trim()) return { ok: false, reason: "Name must not start or end with whitespace" };
  if (INVALID_NAME_CHARS.test(name)) {
    return { ok: false, reason: 'Name must not contain any of: " * : < > ? / \\ |' };
  }
  if (name === "." || name === "..") return { ok: false, reason: "Name must not be '.' or '..'" };
  if (name.startsWith("~$")) return { ok: false, reason: "Name must not start with '~$'" };
  if (name.endsWith(".")) return { ok: false, reason: "Name must not end with a period" };
  if (RESERVED_LEAF_NAMES.has(name) || RESERVED_LEAF_NAMES.has(name.toUpperCase())) {
    return { ok: false, reason: `'${name}' is a reserved name in SharePoint/OneDrive` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Rename — via the file's ListItem (MERGE), NOT the file endpoint directly.
// Two-step: GET ListItemAllFields for odata.type, then MERGE Title+FileLeafRef.
// Source: https://learn.microsoft.com/en-us/sharepoint/dev/sp-add-ins/working-with-folders-and-files-with-rest
// ---------------------------------------------------------------------------
export function buildListItemAllFieldsRequest(siteUrl: string, fileServerRelativeUrl: string): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
      fileServerRelativeUrl
    )})/ListItemAllFields`,
    method: "GET",
    headers: { Accept: VERBOSE_ACCEPT },
  };
}

export function parseListItemODataType(json: unknown): { odataType: string; eTag: string } {
  const d = (json as { d?: { __metadata?: { type?: string }; "odata.etag"?: string } })?.d;
  const odataType = d?.__metadata?.type;
  if (!odataType) throw new Error("Could not resolve ListItem odata.type for rename");
  return { odataType, eTag: (d?.["odata.etag"] as string) ?? "*" };
}

export function buildRenameRequest(
  siteUrl: string,
  fileServerRelativeUrl: string,
  odataType: string,
  eTag: string,
  newLeafName: string,
  digest: string
): RestCall {
  return {
    url: `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
      fileServerRelativeUrl
    )})/ListItemAllFields`,
    method: "POST",
    headers: {
      "X-RequestDigest": digest,
      "X-HTTP-Method": "MERGE",
      "IF-MATCH": eTag,
      Accept: VERBOSE_ACCEPT,
      "Content-Type": VERBOSE_CONTENT_TYPE,
    },
    body: JSON.stringify({
      __metadata: { type: odataType },
      Title: newLeafName,
      FileLeafRef: newLeafName,
    }),
  };
}

/** Splits a leaf file name into [baseName, extensionWithDot] ("" if none). */
export function splitExtension(fileName: string): [string, string] {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0) return [fileName, ""];
  return [fileName.slice(0, idx), fileName.slice(idx)];
}

// ===========================================================================
// v0.2 additions
// ===========================================================================

// ---------------------------------------------------------------------------
// Folder listing — Files / Folders collections off the ResourcePath form.
// Source (current): ResourcePath API page + working-with-folders-and-files.
// GET only; no request digest is required.
// ---------------------------------------------------------------------------
const FOLDER_FILES_SELECT = "Name,ServerRelativeUrl,Length,TimeLastModified,TimeCreated";
const FOLDER_FOLDERS_SELECT = "Name,ServerRelativeUrl,ItemCount";

export const LIST_FOLDER_DEFAULT_MAX_ITEMS = 200;
export const LIST_FOLDER_HARD_MAX_ITEMS = 1000;

function folderPathUrl(siteUrl: string, folderServerRelativeUrl: string, suffix: string): string {
  return `${siteUrl.replace(/\/$/, "")}/_api/web/GetFolderByServerRelativePath(decodedUrl=${encodeForRestLiteral(
    folderServerRelativeUrl
  )})${suffix}`;
}

function filePathUrl(siteUrl: string, fileServerRelativeUrl: string, suffix: string): string {
  return `${siteUrl.replace(/\/$/, "")}/_api/web/GetFileByServerRelativeUrl(${encodeForRestLiteral(
    fileServerRelativeUrl
  )})${suffix}`;
}

export function buildListFolderFilesRequest(
  siteUrl: string,
  folderServerRelativeUrl: string,
  maxItems: number
): RestCall {
  return {
    url: folderPathUrl(siteUrl, folderServerRelativeUrl, `/Files?$select=${FOLDER_FILES_SELECT}&$top=${maxItems}`),
    method: "GET",
    headers: { Accept: VERBOSE_ACCEPT },
  };
}

export function buildListFolderFoldersRequest(
  siteUrl: string,
  folderServerRelativeUrl: string,
  maxItems: number
): RestCall {
  return {
    url: folderPathUrl(siteUrl, folderServerRelativeUrl, `/Folders?$select=${FOLDER_FOLDERS_SELECT}&$top=${maxItems}`),
    method: "GET",
    headers: { Accept: VERBOSE_ACCEPT },
  };
}

export interface FolderListingFile {
  name: string;
  serverRelativeUrl: string;
  size: number | null;
  modified: string | null;
  created: string | null;
}

export interface FolderListingFolder {
  name: string;
  serverRelativeUrl: string;
  itemCount: number | null;
}

/**
 * Every SharePoint document library carries a hidden system folder named
 * "Forms" holding the library's form pages. It is not user content and is
 * noise in every single listing, so it is filtered out here rather than
 * leaving each caller to know about it.
 */
const SYSTEM_FOLDER_NAMES = new Set(["forms"]);

function verboseResults(json: unknown): Record<string, unknown>[] {
  const d = (json as { d?: { results?: unknown } })?.d;
  const results = d?.results;
  return Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Number of entries SharePoint actually returned, BEFORE any client-side
 * filtering. Truncation must be judged against this — filtering the "Forms"
 * folder out of a full page would otherwise make an incomplete listing look
 * complete.
 */
export function verboseResultCount(json: unknown): number {
  return verboseResults(json).length;
}

export function parseFolderFilesResponse(json: unknown): FolderListingFile[] {
  return verboseResults(json).map((r) => ({
    name: (r.Name as string) ?? "",
    serverRelativeUrl: (r.ServerRelativeUrl as string) ?? "",
    size: optionalNumber(r.Length),
    modified: (r.TimeLastModified as string) ?? null,
    created: (r.TimeCreated as string) ?? null,
  }));
}

export function parseFolderFoldersResponse(json: unknown): FolderListingFolder[] {
  return verboseResults(json)
    .map((r) => ({
      name: (r.Name as string) ?? "",
      serverRelativeUrl: (r.ServerRelativeUrl as string) ?? "",
      itemCount: optionalNumber(r.ItemCount),
    }))
    .filter((f) => !SYSTEM_FOLDER_NAMES.has(f.name.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Folder rename — same two-step ListItem MERGE as the file rename, but reached
// through GetFolderByServerRelativePath. The odata.type differs per library,
// so it is read at runtime and never hard-coded.
// ---------------------------------------------------------------------------
export function buildFolderListItemAllFieldsRequest(siteUrl: string, folderServerRelativeUrl: string): RestCall {
  return {
    url: folderPathUrl(siteUrl, folderServerRelativeUrl, "/ListItemAllFields"),
    method: "GET",
    headers: { Accept: VERBOSE_ACCEPT },
  };
}

export function buildFolderRenameRequest(
  siteUrl: string,
  folderServerRelativeUrl: string,
  odataType: string,
  eTag: string,
  newLeafName: string,
  digest: string
): RestCall {
  return {
    url: folderPathUrl(siteUrl, folderServerRelativeUrl, "/ListItemAllFields"),
    method: "POST",
    headers: {
      "X-RequestDigest": digest,
      "X-HTTP-Method": "MERGE",
      "IF-MATCH": eTag,
      Accept: VERBOSE_ACCEPT,
      "Content-Type": VERBOSE_CONTENT_TYPE,
    },
    body: JSON.stringify({
      __metadata: { type: odataType },
      Title: newLeafName,
      FileLeafRef: newLeafName,
    }),
  };
}

// ---------------------------------------------------------------------------
// Folder recycle — recycles the folder AND its entire contents.
// Source: archived-but-Microsoft-authored dn450841 (same family as the file
// recycle already in use above).
// ---------------------------------------------------------------------------
export function buildRecycleFolderRequest(siteUrl: string, folderServerRelativeUrl: string, digest: string): RestCall {
  return {
    url: folderPathUrl(siteUrl, folderServerRelativeUrl, "/recycle"),
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
  };
}

// ---------------------------------------------------------------------------
// File version history — list + restore by label.
// Source: archived reference dn450841 (Tier 2 — see docs/LIMITATIONS.md).
// Version DELETION (deleteall/deletebyid/deletebylabel) is deliberately not
// implemented: it is permanent and irreversible, and out of scope for v0.2.
// ---------------------------------------------------------------------------
export function buildListFileVersionsRequest(siteUrl: string, fileServerRelativeUrl: string): RestCall {
  return {
    url: filePathUrl(siteUrl, fileServerRelativeUrl, "/versions"),
    method: "GET",
    headers: { Accept: VERBOSE_ACCEPT },
  };
}

export function buildRestoreFileVersionRequest(
  siteUrl: string,
  fileServerRelativeUrl: string,
  versionLabel: string,
  digest: string
): RestCall {
  return {
    url: filePathUrl(
      siteUrl,
      fileServerRelativeUrl,
      `/versions/restorebylabel(versionlabel=${encodeForRestLiteral(versionLabel)})`
    ),
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
  };
}

export interface FileVersion {
  versionLabel: string;
  id: number | null;
  created: string | null;
  /**
   * Display name only. The nested user object can also carry Email/LoginName;
   * those are deliberately dropped so a version listing never leaks an
   * identity beyond the name already visible in the SharePoint UI.
   */
  createdBy: string | null;
  size: number | null;
  isCurrentVersion: boolean;
  checkInComment: string | null;
}

export function parseFileVersionsResponse(json: unknown): FileVersion[] {
  return verboseResults(json).map((r) => {
    const createdByRaw = r.CreatedBy as { Title?: string; LookupValue?: string } | undefined;
    const createdBy =
      createdByRaw && typeof createdByRaw === "object"
        ? (createdByRaw.Title ?? createdByRaw.LookupValue ?? null)
        : null;
    return {
      versionLabel: (r.VersionLabel as string) ?? "",
      id: optionalNumber(r.ID),
      created: (r.Created as string) ?? null,
      createdBy,
      size: optionalNumber(r.Size),
      isCurrentVersion: Boolean(r.IsCurrentVersion),
      checkInComment: (r.CheckInComment as string) || null,
    };
  });
}

// ---------------------------------------------------------------------------
// Check-out / check-in / discard check-out.
// CheckOut + CheckIn are current docs; UndoCheckOut is Tier 2 (dn450841).
// ---------------------------------------------------------------------------
export const CHECK_IN_TYPE = { minor: 0, major: 1, overwrite: 2 } as const;
export type CheckInTypeName = keyof typeof CHECK_IN_TYPE;
/** SharePoint rejects longer check-in comments; enforced locally for a clean error. */
export const CHECK_IN_COMMENT_MAX_LENGTH = 1023;

export function buildCheckOutRequest(siteUrl: string, fileServerRelativeUrl: string, digest: string): RestCall {
  return {
    url: filePathUrl(siteUrl, fileServerRelativeUrl, "/CheckOut()"),
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
  };
}

export function buildCheckInRequest(
  siteUrl: string,
  fileServerRelativeUrl: string,
  comment: string,
  checkInType: number,
  digest: string
): RestCall {
  return {
    url: filePathUrl(
      siteUrl,
      fileServerRelativeUrl,
      `/CheckIn(comment=${encodeForRestLiteral(comment)},checkintype=${checkInType})`
    ),
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
  };
}

export function buildUndoCheckOutRequest(siteUrl: string, fileServerRelativeUrl: string, digest: string): RestCall {
  return {
    url: filePathUrl(siteUrl, fileServerRelativeUrl, "/UndoCheckOut()"),
    method: "POST",
    headers: { "X-RequestDigest": digest, Accept: VERBOSE_ACCEPT },
  };
}

// ---------------------------------------------------------------------------
// File metadata update — ListItemAllFields MERGE with caller-supplied fields.
// The forbidden-field guard lives in the MCP server (policy layer); this
// builder is intentionally pure and assumes the fields were already vetted.
// ---------------------------------------------------------------------------
export function buildUpdateFileMetadataRequest(
  siteUrl: string,
  fileServerRelativeUrl: string,
  odataType: string,
  eTag: string,
  fields: Record<string, string | number | null>,
  digest: string
): RestCall {
  return {
    url: filePathUrl(siteUrl, fileServerRelativeUrl, "/ListItemAllFields"),
    method: "POST",
    headers: {
      "X-RequestDigest": digest,
      "X-HTTP-Method": "MERGE",
      "IF-MATCH": eTag,
      Accept: VERBOSE_ACCEPT,
      "Content-Type": VERBOSE_CONTENT_TYPE,
    },
    body: JSON.stringify({ __metadata: { type: odataType }, ...fields }),
  };
}
