import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cpSync, mkdirSync } from "node:fs";

const root = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(root, "..");

mkdirSync(path.join(extensionDir, "dist"), { recursive: true });

await esbuild.build({
  entryPoints: [path.join(extensionDir, "src", "background.ts")],
  outfile: path.join(extensionDir, "dist", "background.js"),
  bundle: true,
  format: "esm",
  target: "chrome95",
  platform: "browser",
  logLevel: "info",
});

await esbuild.build({
  entryPoints: [path.join(extensionDir, "src", "content-script.ts")],
  outfile: path.join(extensionDir, "dist", "content-script.js"),
  bundle: true,
  format: "iife",
  target: "chrome95",
  platform: "browser",
  logLevel: "info",
});

cpSync(path.join(extensionDir, "manifest.json"), path.join(extensionDir, "dist", "manifest.json"));
console.log("Extension build complete: dist/background.js, dist/content-script.js, dist/manifest.json");
