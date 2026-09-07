import * as fs from "node:fs";
import * as path from "node:path";
import { defaultPolicyPath } from "./policy-store.js";
import {
  BridgeError,
  ErrorCode,
  PolicySchema,
  type Policy,
} from "@m365-bridge/protocol";
import { isSharePointOnlineHost } from "@m365-bridge/policy";

export type EditablePolicyList = "allowedHosts" | "allowedSites" | "deniedHosts" | "deniedSites" | "allowedLocalPaths";
export type PolicyListAction = "add" | "remove";

function readRawPolicy(): Policy {
  const policyPath = defaultPolicyPath();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (err) {
    throw new BridgeError(ErrorCode.INTERNAL_ERROR, `Failed to read policy file at ${policyPath}: ${String(err)}`);
  }
  try {
    return PolicySchema.parse(raw);
  } catch (err) {
    throw new BridgeError(ErrorCode.INTERNAL_ERROR, `Current policy is invalid and cannot be edited: ${String(err)}`);
  }
}

function normalizeHostEntry(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!value || value.includes("/") || value.includes(":") || value.includes(" ")) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "Host entries must be a bare hostname, for example tenant.sharepoint.com");
  }
  if (!isSharePointOnlineHost(value)) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "Only Microsoft SharePoint Online host families can be managed here");
  }
  return value;
}

function normalizeLocalPathEntry(raw: string): string {
  const value = raw.trim().replace(/^"(.*)"$/, "$1");
  if (!value || value.includes("\0")) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "Local path entries must not be empty");
  }
  if (/^%[A-Za-z_][A-Za-z0-9_]*%(?:[\\/].*)?$/.test(value)) {
    return value;
  }

  const pathApi = path.win32.isAbsolute(value) ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(value)) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "Local path entries must be absolute project folders");
  }
  const normalized = pathApi.normalize(value);
  if (normalized.toLowerCase() === pathApi.parse(normalized).root.toLowerCase()) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "A filesystem root is too broad; choose a specific project folder");
  }
  return normalized.replace(/[\\/]+$/, "");
}

export function normalizeSiteEntry(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "/") return "";
  if (!trimmed.startsWith("/") || trimmed.includes("?") || trimmed.includes("#") || trimmed.includes("\0")) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "Site entries must be a path such as /sites/Finance or /personal/user_example_com");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "Site entry contains invalid percent-encoding");
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new BridgeError(ErrorCode.INVALID_INPUT, "Site entries must not contain path traversal segments");
  }
  return decoded.replace(/\/+$/, "") || "";
}

function normalizeListEntry(list: EditablePolicyList, raw: string): string {
  if (list === "allowedLocalPaths") return normalizeLocalPathEntry(raw);
  return list.endsWith("Hosts") ? normalizeHostEntry(raw) : normalizeSiteEntry(raw);
}

function sameEntry(list: EditablePolicyList, left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sitePrefixMatches(existing: string, requested: string): boolean {
  const a = existing.toLowerCase();
  const b = requested.toLowerCase();
  return a === "" || a === b || b.startsWith(a + "/");
}

function writePolicy(policy: Policy): Policy {
  const policyPath = defaultPolicyPath();
  const validated = PolicySchema.parse(policy);
  fs.copyFileSync(policyPath, `${policyPath}.bak`);
  try {
    fs.writeFileSync(policyPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  } catch (err) {
    throw new BridgeError(ErrorCode.INTERNAL_ERROR, `Failed to persist policy at ${policyPath}; backup is available at ${policyPath}.bak: ${String(err)}`);
  }
  return validated;
}

function updatePolicyList(list: EditablePolicyList, action: PolicyListAction, rawValue: string): Policy {
  const value = normalizeListEntry(list, rawValue);
  const policy = readRawPolicy();
  const entries = [...policy[list]];

  if (action === "add") {
    const alreadyPresent = list.endsWith("Sites")
      ? entries.some((entry) => sitePrefixMatches(entry, value))
      : entries.some((entry) => sameEntry(list, entry, value));
    if (!alreadyPresent) entries.push(value);
  } else {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (sameEntry(list, entries[i], value)) entries.splice(i, 1);
    }
  }

  return writePolicy({ ...policy, [list]: entries });
}

export function persistApprovedTarget(hostname: string, sitePath: string): Policy {
  const host = normalizeHostEntry(hostname);
  const site = normalizeSiteEntry(sitePath);
  const policy = readRawPolicy();
  const allowedHosts = [...policy.allowedHosts];
  const allowedSites = [...policy.allowedSites];

  if (!allowedHosts.some((entry) => sameEntry("allowedHosts", entry, host))) allowedHosts.push(host);
  if (!allowedSites.some((entry) => sitePrefixMatches(entry, site))) allowedSites.push(site);

  return writePolicy({ ...policy, allowedHosts, allowedSites });
}

export function addPolicyEntry(list: EditablePolicyList, value: string): Policy {
  return updatePolicyList(list, "add", value);
}

export function removePolicyEntry(list: EditablePolicyList, value: string): Policy {
  return updatePolicyList(list, "remove", value);
}

export function readPolicyForControlPanel(): Policy {
  return readRawPolicy();
}

export function updatePolicySettings(settings: Partial<Pick<Policy, "writeEnabled" | "allowOverwrite" | "allowRecycle">>): Policy {
  const policy = readRawPolicy();
  return writePolicy({ ...policy, ...settings });
}
