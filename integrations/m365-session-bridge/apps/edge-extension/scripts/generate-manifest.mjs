import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(root, "..");
const repoRoot = path.resolve(extensionDir, "..", "..");

const localPolicyPath = path.join(repoRoot, "config", "policy.json");
const defaultPolicyPath = path.join(repoRoot, "config", "policy.default.json");
const requestedPolicyPath = process.env.M365_BRIDGE_POLICY_PATH
  ? path.resolve(process.env.M365_BRIDGE_POLICY_PATH)
  : "";
const policyPath = requestedPolicyPath && existsSync(requestedPolicyPath)
  ? requestedPolicyPath
  : existsSync(localPolicyPath)
    ? localPolicyPath
    : defaultPolicyPath;
const templatePath = path.join(extensionDir, "manifest.template.json");
const outPath = path.join(extensionDir, "manifest.json");

const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const hosts = Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [];
const defaultReadHostPatterns = [
  "*.sharepoint.com",
  "*.sharepoint.us",
  "*.sharepoint-mil.us",
  "*.sharepoint.de",
  "*.sharepoint.cn",
];
const readHostPatterns = Array.isArray(policy.readHostPatterns) && policy.readHostPatterns.length > 0
  ? policy.readHostPatterns
  : defaultReadHostPatterns;

const supportedSuffixes = [".sharepoint.com", ".sharepoint.us", ".sharepoint-mil.us", ".sharepoint.de", ".sharepoint.cn"];
for (const pattern of readHostPatterns) {
  const normalized = String(pattern).trim().toLowerCase();
  const host = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
  if (!supportedSuffixes.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
    throw new Error(`readHostPatterns contains a non-SharePoint host pattern: ${pattern}`);
  }
}

for (const allowedHost of hosts) {
  const normalized = String(allowedHost).trim().toLowerCase();
  if (!supportedSuffixes.some((suffix) => normalized.endsWith(suffix))) {
    throw new Error(`allowedHosts contains a non-SharePoint hostname: ${allowedHost}`);
  }
}

const hostPatterns = [...new Set([...readHostPatterns, ...hosts].map((h) => `https://${h}/*`))];
const template = readFileSync(templatePath, "utf8");
const manifest = template.replace(
  '"host_permissions": ["__HOST_PERMISSIONS_PLACEHOLDER__"]',
  `"host_permissions": ${JSON.stringify(hostPatterns)}`
);

// Sanity check the substitution actually happened and the result is valid JSON.
if (manifest.includes("__HOST_PERMISSIONS_PLACEHOLDER__")) {
  throw new Error("Failed to substitute host_permissions placeholder in manifest.template.json");
}
JSON.parse(manifest);

writeFileSync(outPath, manifest);
console.log(`Wrote ${outPath} from ${policyPath} with host_permissions: ${hostPatterns.join(", ")}`);
