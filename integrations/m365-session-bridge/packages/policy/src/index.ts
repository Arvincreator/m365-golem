import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  DEFAULT_READ_HOST_PATTERNS,
  SHAREPOINT_ONLINE_HOST_SUFFIXES,
  type Policy,
  parsePolicy,
  BridgeError,
  ErrorCode,
} from "@m365-bridge/protocol";

export function loadPolicy(policyJsonPath: string): Policy {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(policyJsonPath, "utf8"));
  } catch (err) {
    throw new BridgeError(ErrorCode.INTERNAL_ERROR, `Failed to read/parse policy file at ${policyJsonPath}: ${String(err)}`);
  }
  try {
    return parsePolicy(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new BridgeError(
        ErrorCode.INTERNAL_ERROR,
        `policy.json failed validation — a locked security invariant or type mismatch was violated: ${issues}`
      );
    }
    throw err;
  }
}

export function expandEnvPath(raw: string): string {
  return raw.replace(/%([^%]+)%/g, (_match, name: string) => {
    const value = process.env[name];
    if (value === undefined) {
      throw new BridgeError(ErrorCode.INTERNAL_ERROR, `Environment variable %${name}% referenced in policy.json is not set`);
    }
    return value;
  });
}

function normalizeForCompare(p: string): string {
  return path.resolve(p).toLowerCase();
}

export function resolveAllowedLocalPath(candidatePath: string, policy: Policy): string {
  if (!candidatePath || candidatePath.includes("\0")) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "Local path is empty or contains invalid characters");
  }

  const candidateAbs = path.resolve(candidatePath);
  const candidateForCompare = candidateAbs.toLowerCase();

  let matched = false;
  for (const entry of policy.allowedLocalPaths) {
    const rootAbs = path.resolve(expandEnvPath(entry));
    const rootForCompare = rootAbs.toLowerCase();
    if (candidateForCompare === rootForCompare) {
      matched = true;
      break;
    }
    const rel = path.relative(rootForCompare, candidateForCompare);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    throw new BridgeError(ErrorCode.LOCAL_PATH_NOT_ALLOWED, `Path is outside all allowedLocalPaths: ${candidateAbs}`);
  }

  const ext = path.extname(candidateAbs).toLowerCase();
  if (ext && policy.denylistExtensions.some((d) => d.toLowerCase() === ext)) {
    throw new BridgeError(ErrorCode.FORBIDDEN_BY_POLICY, `File extension '${ext}' is denylisted by policy`);
  }

  return candidateAbs;
}

export type ValidatedSharePointUrl = { siteUrl: string; serverRelativeUrl: string };

const SITE_COLLECTION_MANAGED_PATHS = new Set(["sites", "teams", "personal"]);

export function parseHttpsUrl(urlStr: string): URL {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new BridgeError(ErrorCode.INVALID_INPUT, `Not a valid URL: ${urlStr}`);
  }

  if (url.protocol !== "https:") {
    throw new BridgeError(ErrorCode.INVALID_INPUT, `URL must use https: ${urlStr}`);
  }
  if (url.username || url.password) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "SharePoint/OneDrive URLs must not contain a username or password");
  }
  return url;
}

export function normalizeServerRelativePath(url: URL): string {
  // Connector web URLs sometimes point at a list view with the actual file in
  // the `id` query parameter. Prefer it when it is an absolute server-relative
  // path; ordinary file URLs continue to use pathname.
  const queryId = url.searchParams.get("id");
  let decodedPath = queryId?.startsWith("/") ? queryId : url.pathname;
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "SharePoint/OneDrive URL contains invalid percent-encoding");
  }

  // Opaque SharePoint sharing routes contain a token, not the target's
  // server-relative path. Treating that token as a folder path can produce a
  // misleading successful empty result. Callers must resolve it through the
  // authenticated Edge session before policy/path validation.
  if (/^\/:[^/]+:\/(?:s|g)\//i.test(decodedPath)) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "Opaque SharePoint sharing URL must be resolved before use");
  }

  // Common SharePoint sharing links look like `/:x:/r/sites/...`. The `/r`
  // suffix is a sharing-route marker, not part of the server-relative file
  // path used by the REST endpoint.
  const sharingRoute = decodedPath.match(/^\/:[^/]+:\/r(\/.*)$/i);
  if (sharingRoute) decodedPath = sharingRoute[1];

  if (!decodedPath.startsWith("/") || decodedPath.includes("\0")) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "SharePoint/OneDrive URL did not contain a safe server-relative path");
  }

  const segments = decodedPath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "SharePoint/OneDrive URL contains path traversal segments");
  }
  return decodedPath;
}

function hostPatternMatches(pattern: string, hostname: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedHost = hostname.toLowerCase();
  if (!normalizedPattern || normalizedPattern === "*") return false;
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
  }
  return normalizedHost === normalizedPattern;
}

export function isSharePointOnlineHost(hostname: string): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");
  return SHAREPOINT_ONLINE_HOST_SUFFIXES.some(
    (suffix) => normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length
  );
}

function normalizePolicySitePath(sitePath: string): string {
  const trimmed = sitePath.trim();
  if (!trimmed || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") : `/${trimmed.replace(/\/+$/, "")}`;
}

function sitePathMatches(decodedPath: string, configuredSitePath: string): boolean {
  const sitePath = normalizePolicySitePath(configuredSitePath).toLowerCase();
  const candidate = decodedPath.toLowerCase();
  return sitePath === "" || candidate === sitePath || candidate.startsWith(sitePath + "/");
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export function isTargetDenied(hostname: string, decodedPath: string, policy: Policy): boolean {
  const host = normalizedHost(hostname);
  if (policy.deniedHosts.some((entry) => normalizedHost(entry.trim()) === host)) return true;
  return policy.deniedSites.some((site) => sitePathMatches(decodedPath, site));
}

export function inferSiteCollectionPath(serverRelativeUrl: string): string {
  const segments = serverRelativeUrl.split("/").filter(Boolean);
  if (segments.length >= 2 && SITE_COLLECTION_MANAGED_PATHS.has(segments[0].toLowerCase())) {
    return `/${segments[0]}/${segments[1]}`;
  }
  // The root site collection (including a root OneDrive URL where the site
  // prefix was not present in the supplied link) uses the host origin.
  return "";
}

function siteUrlFor(url: URL, serverRelativeUrl: string): string {
  const sitePath = inferSiteCollectionPath(serverRelativeUrl);
  if (!sitePath) return url.origin;
  return new URL(sitePath, url.origin).toString().replace(/\/$/, "");
}

function readHostPatterns(policy: Policy): string[] {
  return policy.readHostPatterns?.length ? policy.readHostPatterns : [...DEFAULT_READ_HOST_PATTERNS];
}

/**
 * Validates a SharePoint/OneDrive URL for read-only operations.
 *
 * The actual authorization is the existing signed-in Edge session and the
 * SharePoint REST response. The local policy only limits the browser surface
 * to Microsoft's SharePoint Online host families and applies deny-first
 * host/site exclusions.
 */
export function validateReadableHostAndSite(urlStr: string, policy: Policy): ValidatedSharePointUrl {
  const url = parseHttpsUrl(urlStr);
  if (!isSharePointOnlineHost(url.hostname)) {
    throw new BridgeError(ErrorCode.HOST_NOT_ALLOWED, `Host is not a supported SharePoint Online host: ${url.hostname}`);
  }

  const hostAllowed = readHostPatterns(policy).some((pattern) => hostPatternMatches(pattern, url.hostname));
  if (!hostAllowed) {
    throw new BridgeError(ErrorCode.HOST_NOT_ALLOWED, `Host is not in readHostPatterns: ${url.hostname}`);
  }

  const serverRelativeUrl = normalizeServerRelativePath(url);
  if (isTargetDenied(url.hostname, serverRelativeUrl, policy)) {
    throw new BridgeError(ErrorCode.FORBIDDEN_BY_POLICY, `Target is denied by policy: ${url.hostname}${serverRelativeUrl}`);
  }
  return { siteUrl: siteUrlFor(url, serverRelativeUrl), serverRelativeUrl };
}

/** Computes the relay target shape for a supported SharePoint Online URL. */
export function computeApprovedTarget(urlStr: string): ValidatedSharePointUrl {
  const url = parseHttpsUrl(urlStr);
  if (!isSharePointOnlineHost(url.hostname)) {
    throw new BridgeError(ErrorCode.HOST_NOT_ALLOWED, `Host is not a supported SharePoint Online host: ${url.hostname}`);
  }
  const serverRelativeUrl = normalizeServerRelativePath(url);
  return { siteUrl: siteUrlFor(url, serverRelativeUrl), serverRelativeUrl };
}

export function validateHostAndSite(
  urlStr: string,
  policy: Policy
): ValidatedSharePointUrl {
  return validateReadableHostAndSite(urlStr, policy);
}

export function checkWriteEnabled(policy: Policy): void {
  if (!policy.writeEnabled) {
    throw new BridgeError(ErrorCode.FORBIDDEN_BY_POLICY, "Write operations are disabled (writeEnabled=false in policy.json)");
  }
}

/**
 * The upload/copy/move tool schemas (spec section 12) have no machine-checkable
 * confirmation field for overwrite — only m365_recycle_file does. So the only
 * thing this layer can enforce is the policy toggle; the human-in-the-loop
 * check for "did the user actually agree to overwrite this file" is pushed to
 * the tool description text (the harness must ask before ever passing
 * overwrite:true) and to operator documentation, not to a token this function
 * can verify.
 */
export function checkOverwrite(requested: boolean, policy: Policy): void {
  if (!requested) return;
  if (!policy.allowOverwrite) {
    throw new BridgeError(ErrorCode.FORBIDDEN_BY_POLICY, "Overwrite is disabled by policy (allowOverwrite=false)");
  }
}

export function checkRecycleAllowed(policy: Policy): void {
  if (!policy.allowRecycle) {
    throw new BridgeError(ErrorCode.FORBIDDEN_BY_POLICY, "Recycle is disabled by policy (allowRecycle=false)");
  }
}

export function checkConfirmationToken(providedToken: string | undefined, expectedToken: string): void {
  if (providedToken !== expectedToken) {
    throw new BridgeError(ErrorCode.NEEDS_USER_CONFIRMATION, `This action requires confirmation:"${expectedToken}"`);
  }
}
