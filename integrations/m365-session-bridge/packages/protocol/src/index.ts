export * from "./errors.js";
export * from "./policy.js";
export * from "./ipc.js";
export * from "./tools.js";
// Note: ./secret.js is deliberately NOT re-exported here — it uses node:fs/
// node:path/node:crypto and this barrel is bundled into the browser
// extension. Node-only consumers (mcp-server, native-host) import it via the
// "@m365-bridge/protocol/secret" subpath instead (see package.json "exports").
