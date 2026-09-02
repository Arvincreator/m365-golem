import { z } from "zod";

/**
 * MCP v0.1 tool contract (spec section 12). Every input schema below is the
 * single source of truth used by: the MCP server (to validate before calling
 * the policy guard), and docs generation. Do not add a generic
 * fetch/execute/run-script tool — every capability must be purpose-built.
 */

export const BridgeStatusInput = z.object({});

export interface BridgeStatusResult {
  status: "success" | "error";
  extensionOnline: boolean;
  m365SessionAvailable: boolean;
  tenantHost: string | null;
  readHostPatterns: string[];
  bridgeVersion: string;
  writeMode: boolean;
  allowedHosts: string[];
  allowedSites: string[];
  deniedHosts: string[];
  deniedSites: string[];
}

export const DownloadFileInput = z.object({
  fileUrl: z.string().url(),
  destinationPath: z.string(),
});

export interface DownloadFileResult {
  status: "success" | "error";
  localPath?: string;
  fileName?: string;
  size?: number;
  sha256?: string;
}

export const UploadFileInput = z.object({
  localPath: z.string(),
  destinationFolderUrl: z.string().url(),
  fileName: z.string(),
  overwrite: z.boolean().default(false),
});

export const CopyFileInput = z.object({
  sourceFileUrl: z.string().url(),
  destinationFolderUrl: z.string().url(),
  newName: z.string().nullable().default(null),
  overwrite: z.boolean().default(false),
});

export const MoveFileInput = z.object({
  sourceFileUrl: z.string().url(),
  destinationFolderUrl: z.string().url(),
  newName: z.string().nullable().default(null),
  overwrite: z.boolean().default(false),
});

export const RenameFileInput = z.object({
  fileUrl: z.string().url(),
  newName: z.string(),
  allowExtensionChange: z.boolean().default(false),
});

export const GetFileUrlInput = z.object({
  fileUrl: z.string().url(),
});

export interface GetFileUrlResult {
  status: "success" | "error";
  canonicalUrl?: string;
}

export const RecycleFileInput = z.object({
  fileUrl: z.string().url(),
  confirmation: z.string(),
});

export const CreateFolderInput = z.object({
  /** Existing parent folder the new folder is created inside. */
  parentFolderUrl: z.string().url(),
  /** Single folder name, or a relative path like "2026/Q1" to create nested levels. */
  folderName: z.string(),
});

export interface CreateFolderResult {
  status: "success" | "error";
  folderUrl?: string;
  /** Folders actually created by this call (already-existing levels are skipped, not an error). */
  created?: string[];
}

export const CONFIRMATION_TOKEN = "CONFIRM_RECYCLE";

// ---------------------------------------------------------------------------
// v0.2 — additional SharePoint capabilities.
//
// Each destructive action gets its OWN confirmation token. Distinct tokens
// mean a confirmation the user gave for one action (e.g. recycling a single
// file) can never be replayed by a caller to authorize a different, more
// destructive action (e.g. recycling an entire folder tree).
// ---------------------------------------------------------------------------

export const CONFIRM_RECYCLE_FOLDER_TOKEN = "CONFIRM_RECYCLE_FOLDER";
export const CONFIRM_RESTORE_VERSION_TOKEN = "CONFIRM_RESTORE_VERSION";
export const CONFIRM_DISCARD_CHECKOUT_TOKEN = "CONFIRM_DISCARD_CHECKOUT";

export const ListFolderInput = z.object({
  folderUrl: z.string().url(),
  maxItems: z.number().int().positive().max(1000).default(200),
});

export interface ListFolderResult {
  status: "success" | "error";
  folderUrl?: string;
  files?: Array<{ name: string; serverRelativeUrl: string; size: number | null; modified: string | null }>;
  folders?: Array<{ name: string; serverRelativeUrl: string }>;
  /** True when either collection hit maxItems — the listing is incomplete. */
  truncated?: boolean;
}

export const RenameFolderInput = z.object({
  folderUrl: z.string().url(),
  newName: z.string(),
});

export const RecycleFolderInput = z.object({
  folderUrl: z.string().url(),
  confirmation: z.string(),
});

export const ListFileVersionsInput = z.object({
  fileUrl: z.string().url(),
});

export interface ListFileVersionsResult {
  status: "success" | "error";
  versions?: Array<{
    versionLabel: string;
    id: number | null;
    created: string | null;
    /** Display name only — never an email or login name. */
    createdBy: string | null;
    size: number | null;
    isCurrentVersion: boolean;
    checkInComment: string | null;
  }>;
}

export const RestoreFileVersionInput = z.object({
  fileUrl: z.string().url(),
  versionLabel: z.string(),
  confirmation: z.string(),
});

export const CheckOutFileInput = z.object({
  fileUrl: z.string().url(),
});

export const CheckInFileInput = z.object({
  fileUrl: z.string().url(),
  comment: z.string().default(""),
  checkInType: z.enum(["minor", "major", "overwrite"]).default("major"),
});

export const DiscardCheckoutInput = z.object({
  fileUrl: z.string().url(),
  confirmation: z.string(),
});

export const UpdateFileMetadataInput = z.object({
  fileUrl: z.string().url(),
  /**
   * Simple values only. Complex fields (lookup, managed metadata, person)
   * require ValidateUpdateListItem and are out of scope for v0.2 — objects and
   * arrays are rejected with INVALID_INPUT rather than silently mangled.
   */
  fields: z.record(z.unknown()),
});

/**
 * Identity / permission / path fields that are never "user metadata". Allowing
 * these through m365_update_file_metadata would let a metadata update silently
 * move a file (FileRef/FileDirRef/FileLeafRef), re-attribute it (Author/Editor),
 * change its content type, or alter moderation state. Renaming has its own
 * dedicated tool; there is no supported path for the rest.
 */
export const FORBIDDEN_METADATA_FIELDS = [
  "FileLeafRef",
  "FileRef",
  "FileDirRef",
  "ContentTypeId",
  "Author",
  "Editor",
  "ID",
  "GUID",
  "PermMask",
  "owshiddenversion",
  "_ModerationStatus",
] as const;

// ---------------------------------------------------------------------------
// Document creation (spec sections 15-18) — structured JSON in, local file out.
// The result path is then handed to m365_upload_file; these tools never touch
// SharePoint themselves and never launch Word/Excel.
// ---------------------------------------------------------------------------

const RunSchema = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});

const WordBlockSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("title"), text: z.string() }),
    z.object({ type: z.literal("heading"), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), text: z.string() }),
    z.object({ type: z.literal("paragraph"), runs: z.array(RunSchema) }),
    z.object({ type: z.literal("bulletList"), items: z.array(z.string()) }),
    z.object({ type: z.literal("numberedList"), items: z.array(z.string()) }),
    z.object({
      type: z.literal("table"),
      rows: z.array(z.array(z.string())),
      header: z.boolean().default(true),
    }),
    z.object({ type: z.literal("pageBreak") }),
  ])
);

export const CreateWordDocumentInput = z.object({
  outputPath: z.string(),
  header: z.string().optional(),
  footer: z.string().optional(),
  blocks: z.array(WordBlockSchema),
});

const CellSchema = z.union([z.string(), z.number(), z.null()]);

export const CreateExcelWorkbookInput = z.object({
  outputPath: z.string(),
  worksheets: z.array(
    z.object({
      name: z.string(),
      columns: z
        .array(z.object({ header: z.string(), key: z.string(), width: z.number().optional() }))
        .optional(),
      rows: z.array(z.array(CellSchema)).optional(),
      rowsByKey: z.array(z.record(CellSchema)).optional(),
      freezeHeaderRow: z.boolean().default(false),
      autoFilter: z.boolean().default(false),
      numberFormats: z.record(z.string()).optional(),
    })
  ),
});

export type ToolName =
  | "m365_bridge_status"
  | "m365_download_file"
  | "m365_upload_file"
  | "m365_copy_file"
  | "m365_move_file"
  | "m365_rename_file"
  | "m365_get_file_url"
  | "m365_recycle_file"
  | "m365_create_folder"
  | "m365_list_folder"
  | "m365_rename_folder"
  | "m365_recycle_folder"
  | "m365_list_file_versions"
  | "m365_restore_file_version"
  | "m365_checkout_file"
  | "m365_checkin_file"
  | "m365_discard_checkout"
  | "m365_update_file_metadata"
  | "create_word_document"
  | "create_excel_workbook";
