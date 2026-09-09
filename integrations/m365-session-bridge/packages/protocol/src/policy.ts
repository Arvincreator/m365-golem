import { z } from "zod";

/**
 * SharePoint Online host suffixes supported by the browser-session bridge.
 * These are intentionally limited to Microsoft SharePoint host families;
 * this is not an allowlist for arbitrary Entra-protected websites.
 */
export const SHAREPOINT_ONLINE_HOST_SUFFIXES = [
  ".sharepoint.com",
  ".sharepoint.us",
  ".sharepoint-mil.us",
  ".sharepoint.de",
  ".sharepoint.cn",
] as const;

/**
 * Read-only host patterns. The extension needs these patterns so a file URL
 * returned by an M365 connector can be relayed through the user's existing
 * Edge session even when that tenant/site was not preconfigured for writes.
 */
export const DEFAULT_READ_HOST_PATTERNS = SHAREPOINT_ONLINE_HOST_SUFFIXES.map((suffix) => `*${suffix}`);

/**
 * config/policy.json schema (spec section 20).
 * SharePoint/OneDrive targets are allowed by default within the supported
 * Microsoft host families. The signed-in Edge session and SharePoint remain
 * the authority for what the user can actually access; deniedHosts and
 * deniedSites are local deny-first overrides.
 *
 * Older policy files may still contain allowedHosts, allowedSites, or
 * allowedLibraries. Zod strips those legacy keys so they cannot silently keep
 * acting as authorization gates after this migration.
 */
export const PolicySchema = z.object({
  writeEnabled: z.boolean().default(false),
  readHostPatterns: z.array(z.string().min(1)).default([...DEFAULT_READ_HOST_PATTERNS]),
  deniedHosts: z.array(z.string()).default([]),
  deniedSites: z.array(z.string()).default([]),
  allowedLocalPaths: z.array(z.string()).default([]),
  allowOverwrite: z.boolean().default(false),
  allowRecycle: z.boolean().default(false),
  allowPermanentDelete: z.literal(false).default(false),
  allowExternalSharing: z.literal(false).default(false),
  allowPermissionChange: z.literal(false).default(false),
  allowBulkDelete: z.literal(false).default(false),
  allowArbitraryHttp: z.literal(false).default(false),
  denylistExtensions: z.array(z.string()).default([]),
});

export type Policy = z.infer<typeof PolicySchema>;

/** Parses and validates policy.json; throws on any attempt to enable a permanently-forbidden capability. */
export function parsePolicy(raw: unknown): Policy {
  return PolicySchema.parse(raw);
}
